const SPONSORED_WAITS_KEY = "sponsoredWaitsEnabled";
/** Legacy storage key — treated as Sponsored Waits until users re-toggle. */
const LEGACY_BEHAVIORAL_KEY = "behavioralLayer";
const BOX_ID = "omni-wait-ad";
const STYLE_ID = "omni-wait-ad-styles";

type SiteProfile = {
  name: string;
  hosts: string[];
  selectors: string[];
};

const GENERIC_SELECTORS = [
  '[aria-label="Stop generating"]',
  '[aria-label*="Stop"]',
  '[data-testid="stop-button"]',
  'button[aria-label="Stop streaming"]',
];

const SITE_PROFILES: SiteProfile[] = [
  {
    name: "ChatGPT",
    hosts: ["chatgpt.com"],
    selectors: [
      '[data-testid="stop-button"]',
      '[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]',
    ],
  },
  {
    name: "Claude",
    hosts: ["claude.ai"],
    selectors: [
      'button[aria-label="Stop streaming"]',
      '[aria-label*="Stop"]',
    ],
  },
  {
    name: "Gemini",
    hosts: ["gemini.google.com"],
    selectors: [
      'button[aria-label*="Stop"]',
      'button[aria-label*="Cancel"]',
      'button[title*="Stop"]',
      'button[title*="Cancel"]',
      '[role="progressbar"][aria-valuetext]',
      '[role="progressbar"][aria-busy="true"]',
    ],
  },
  {
    name: "Perplexity",
    hosts: ["perplexity.ai", "www.perplexity.ai"],
    selectors: [
      '[aria-label*="Stop"]',
      '[data-testid*="stop"]',
      '[data-testid*="typing"]',
      '[data-testid*="cursor"]',
    ],
  },
  {
    name: "Copilot",
    hosts: ["copilot.microsoft.com"],
    selectors: [
      '[aria-label*="Stop"]',
      '[data-testid*="stop"]',
      'button[type="submit"][disabled][aria-label*="Send"]',
      'button[aria-label*="Send"][disabled]',
    ],
  },
  {
    name: "DeepSeek",
    hosts: ["chat.deepseek.com"],
    selectors: ['[aria-label*="Stop"]', '[data-testid*="stop"]'],
  },
  {
    name: "Grok",
    hosts: ["grok.com"],
    selectors: ['[aria-label*="Stop"]', '[data-testid*="stop"]'],
  },
  {
    name: "Meta AI",
    hosts: ["meta.ai", "www.meta.ai"],
    selectors: ['[aria-label*="Stop"]'],
  },
  {
    name: "Le Chat",
    hosts: ["chat.mistral.ai"],
    selectors: ['[aria-label*="Stop"]'],
  },
  {
    name: "Poe",
    hosts: ["poe.com", "www.poe.com"],
    selectors: [
      '[aria-label*="Stop"]',
      '[data-testid*="stop"]',
      '[data-action*="stop"]',
    ],
  },
];

const ANCHOR_WALK_MAX = 12;
const ANCHOR_MIN_WIDTH = 300;

let observer: MutationObserver | null = null;
let rafHandle = 0;
let isGenerating = false;
let boxMounted = false;
let detectionLoggedThisCycle = false;
let currentSessionToken: string | null = null;
let generationStartedAt: number | null = null;
let waitTimerInterval: number | null = null;
let adFetchedThisCycle = false;
let adFetchInProgress = false;
let currentAd: SponsoredAd | null = null;
let adImpressionSent = false;

type PlatformConfig = {
  currency: string;
  symbol: string;
  minWaitSeconds: number;
  minRedemption: number;
  userRevenueShareBps: number;
  omniRevenueShareBps: number;
};

const FALLBACK_PLATFORM_CONFIG: PlatformConfig = {
  currency: "INR",
  symbol: "₹",
  minWaitSeconds: 5,
  minRedemption: 100,
  userRevenueShareBps: 6000,
  omniRevenueShareBps: 4000,
};

let platformConfig: PlatformConfig | null = null;

type SponsoredAd = {
  id: number;
  headline: string;
  body: string;
  cta_label: string;
  cta_url: string;
  campaignId?: number;
};

type BackgroundMessage =
  | { type: "SESSION_START"; payload?: undefined }
  | { type: "GET_CONFIG"; payload?: undefined }
  | { type: "GET_AD"; payload?: undefined }
  | {
      type: "AD_EVENT";
      payload: {
        adId: number;
        event: "impression" | "click";
        campaignId?: number;
      };
    };

type BackgroundResponse =
  | { ok: true; data: unknown; status?: number }
  | { ok: false; error: string; status?: number };

function isExtensionContextValid(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function stopExtensionScript(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (rafHandle) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
  clearWaitTimer();
  removeWaitAd();
}

function getElapsedSeconds(): number {
  if (generationStartedAt === null) return 0;
  return Math.floor((Date.now() - generationStartedAt) / 1000);
}

function clearWaitTimer(): void {
  if (waitTimerInterval !== null) {
    clearInterval(waitTimerInterval);
    waitTimerInterval = null;
  }
}

function startWaitTimer(): void {
  clearWaitTimer();
  waitTimerInterval = window.setInterval(() => {
    if (!isExtensionContextValid()) {
      stopExtensionScript();
      return;
    }
    if (!isGenerating) {
      clearWaitTimer();
      return;
    }
    if (boxMounted) {
      updateWaitAd();
    }
  }, 1000);
}

async function fetchEligibleAd(): Promise<void> {
  if (adFetchedThisCycle || adFetchInProgress) return;
  adFetchInProgress = true;

  try {
    const response = await sendBackgroundMessage({ type: "GET_AD" });
    adFetchedThisCycle = true;

    if (response.ok) {
      const payload = response.data as {
        success?: boolean;
        data?: {
          ad?: SponsoredAd | null;
          source?: string;
          campaignId?: number;
        };
      };
      const ad = payload.success && payload.data?.ad ? payload.data.ad : null;
      if (ad && ad.headline && ad.cta_url) {
        const campaignId =
          payload.data?.source === "campaign" &&
          typeof payload.data.campaignId === "number" &&
          payload.data.campaignId > 0
            ? payload.data.campaignId
            : undefined;
        currentAd = campaignId ? { ...ad, campaignId } : ad;
      } else {
        currentAd = null;
      }
    } else {
      currentAd = null;
    }
  } catch {
    adFetchedThisCycle = true;
    currentAd = null;
  } finally {
    adFetchInProgress = false;
    if (boxMounted) {
      updateWaitAd();
    }
  }
}

function renderAdCard(box: HTMLElement): void {
  const container = box.querySelector<HTMLElement>(".omni-ad-card");
  if (!container) return;

  if (!currentAd) {
    container.hidden = true;
    return;
  }

  if (container.dataset.adId === String(currentAd.id)) {
    container.hidden = false;
    return;
  }

  container.dataset.adId = String(currentAd.id);
  container.hidden = false;
  container.innerHTML = "";

  const label = document.createElement("p");
  label.className = "omni-ad-label";
  label.textContent = "Sponsored";

  const headline = document.createElement("p");
  headline.className = "omni-ad-headline";
  headline.textContent = currentAd.headline;

  const adBody = document.createElement("p");
  adBody.className = "omni-ad-body";
  adBody.textContent = currentAd.body;

  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = "omni-ad-cta";
  cta.textContent = currentAd.cta_label;
  const adSnapshot = currentAd;
  cta.addEventListener("click", () => {
    void sendBackgroundMessage({
      type: "AD_EVENT",
      payload: {
        adId: adSnapshot.id,
        event: "click",
        ...(adSnapshot.campaignId
          ? { campaignId: adSnapshot.campaignId }
          : {}),
      },
    });
    window.open(adSnapshot.cta_url, "_blank", "noopener");
  });

  container.append(label, headline, adBody, cta);

  if (!adImpressionSent) {
    adImpressionSent = true;
    void sendBackgroundMessage({
      type: "AD_EVENT",
      payload: {
        adId: currentAd.id,
        event: "impression",
        ...(currentAd.campaignId ? { campaignId: currentAd.campaignId } : {}),
      },
    });
  }
}

function updateWaitAd(): void {
  const box = document.getElementById(BOX_ID);
  if (!box) return;

  const title = box.querySelector<HTMLElement>(".omni-title");
  const body = box.querySelector<HTMLElement>(".omni-body");
  const counter = box.querySelector<HTMLElement>(".omni-counter");
  const shareNote = box.querySelector<HTMLElement>(".omni-share-note");
  if (!title || !body || !counter || !shareNote) return;

  const cfg = platformConfig ?? FALLBACK_PLATFORM_CONFIG;
  const elapsed = getElapsedSeconds();
  const userPct = Math.floor(cfg.userRevenueShareBps / 100);

  title.textContent = "Sponsored Wait";
  shareNote.textContent = `Omni · You receive ${userPct}% of qualifying ad revenue`;
  shareNote.hidden = false;

  if (elapsed < cfg.minWaitSeconds) {
    body.textContent = "Loading sponsored content while your AI generates…";
    body.hidden = false;
    counter.textContent = `${elapsed}s`;
    counter.hidden = false;
  } else {
    body.textContent = currentAd
      ? "Sponsored content for this wait."
      : "No paid campaign available for this wait.";
    body.hidden = false;
    counter.hidden = true;
    if (!adFetchedThisCycle && !adFetchInProgress) {
      void fetchEligibleAd();
    }
  }

  renderAdCard(box);
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${BOX_ID} {
      z-index: 2147483647;
      padding: 18px 20px;
      border-radius: 16px;
      border: 1px solid rgba(57, 255, 136, 0.25);
      background: linear-gradient(145deg, #1a1a1e 0%, #141416 100%);
      box-shadow:
        0 12px 40px rgba(0, 0, 0, 0.45),
        0 0 24px rgba(57, 255, 136, 0.12),
        inset 0 1px 0 rgba(255, 255, 255, 0.06);
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      color: #f4f4f5;
      opacity: 1;
      pointer-events: auto;
    }

    #${BOX_ID}.omni-floating {
      position: fixed;
      top: 20px;
      right: 20px;
      width: 280px;
      transform: translateX(0);
      transition:
        transform 0.55s cubic-bezier(0.4, 0, 0.2, 1),
        opacity 0.55s cubic-bezier(0.4, 0, 0.2, 1);
    }

    #${BOX_ID}.omni-inline {
      position: relative;
      display: block;
      max-width: 420px;
      margin: 12px 0;
      width: 100%;
      max-height: 600px;
      overflow: hidden;
      transition:
        opacity 0.55s cubic-bezier(0.4, 0, 0.2, 1),
        max-height 0.55s cubic-bezier(0.4, 0, 0.2, 1),
        margin 0.55s cubic-bezier(0.4, 0, 0.2, 1),
        padding 0.55s cubic-bezier(0.4, 0, 0.2, 1);
    }

    #${BOX_ID}.omni-floating.omni-slide-out {
      transform: translateX(calc(100% + 32px));
      opacity: 0;
      pointer-events: none;
    }

    #${BOX_ID}.omni-inline.omni-slide-out {
      opacity: 0;
      max-height: 0;
      margin-top: 0;
      margin-bottom: 0;
      padding-top: 0;
      padding-bottom: 0;
      pointer-events: none;
    }

    #${BOX_ID} .omni-title {
      margin: 0 0 8px;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.01em;
      color: #ffffff;
    }

    #${BOX_ID} .omni-body {
      margin: 0 0 8px;
      font-size: 13px;
      line-height: 1.45;
      color: #a1a1aa;
    }

    #${BOX_ID} .omni-counter {
      margin: 0 0 10px;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0.05em;
      color: #71717a;
    }

    #${BOX_ID} .omni-share-note {
      margin: 0 0 4px;
      font-size: 11px;
      line-height: 1.4;
      color: #71717a;
    }

    #${BOX_ID} .omni-ad-card {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }

    #${BOX_ID} .omni-ad-label {
      margin: 0 0 6px;
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #71717a;
    }

    #${BOX_ID} .omni-ad-headline {
      margin: 0 0 4px;
      font-size: 13px;
      font-weight: 600;
      color: #e4e4e7;
      line-height: 1.35;
    }

    #${BOX_ID} .omni-ad-body {
      margin: 0 0 10px;
      font-size: 12px;
      line-height: 1.4;
      color: #a1a1aa;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    #${BOX_ID} .omni-ad-cta {
      padding: 6px 12px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 8px;
      background: transparent;
      color: #d4d4d8;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition:
        background 0.15s ease,
        border-color 0.15s ease;
    }

    #${BOX_ID} .omni-ad-cta:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.28);
    }
  `;

  document.head.appendChild(style);
}

type GenerationMatch = {
  element: HTMLElement;
  profileName: string;
  selector: string;
};

function hostMatchesProfile(hostname: string, hosts: string[]): boolean {
  const normalized = hostname.toLowerCase();
  return hosts.some((host) => {
    const h = host.toLowerCase();
    return normalized === h || normalized.endsWith(`.${h}`);
  });
}

function getActiveSiteProfiles(): SiteProfile[] {
  const hostname = window.location.hostname;
  return SITE_PROFILES.filter((profile) =>
    hostMatchesProfile(hostname, profile.hosts),
  );
}

function getAllDetectionSelectors(): string[] {
  const profileSelectors = getActiveSiteProfiles().flatMap(
    (profile) => profile.selectors,
  );
  return [...profileSelectors, ...GENERIC_SELECTORS];
}

function findGenerationMatch(): GenerationMatch | null {
  for (const profile of getActiveSiteProfiles()) {
    for (const selector of profile.selectors) {
      const element = document.querySelector<HTMLElement>(selector);
      if (element) {
        return { element, profileName: profile.name, selector };
      }
    }
  }

  for (const selector of GENERIC_SELECTORS) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) {
      return { element, profileName: "generic", selector };
    }
  }

  return null;
}

function findGenerationIndicator(): HTMLElement | null {
  return findGenerationMatch()?.element ?? null;
}

function logDetectionMatch(match: GenerationMatch): void {
  if (detectionLoggedThisCycle) return;
  detectionLoggedThisCycle = true;
  console.debug("[OmniPiggy] matched", match.profileName, match.selector);
}

function scopeHasStopControl(scope: ParentNode): boolean {
  for (const selector of getAllDetectionSelectors()) {
    if (scope.querySelector(selector)) {
      return true;
    }
  }
  return false;
}

function omniPiggyProbe(): void {
  const hostname = window.location.hostname;
  const activeProfiles = getActiveSiteProfiles();

  console.log("[OmniPiggy] probe hostname:", hostname);
  console.log(
    "[OmniPiggy] active profiles:",
    activeProfiles.length > 0
      ? activeProfiles.map((p) => p.name).join(", ")
      : "(none)",
  );

  for (const profile of activeProfiles) {
    for (const selector of profile.selectors) {
      const count = document.querySelectorAll(selector).length;
      console.log(
        `[OmniPiggy] ${count > 0 ? "MATCH" : "miss"} profile=${profile.name} selector=${selector} count=${count}`,
      );
    }
  }

  for (const selector of GENERIC_SELECTORS) {
    const count = document.querySelectorAll(selector).length;
    console.log(
      `[OmniPiggy] ${count > 0 ? "MATCH" : "miss"} profile=generic selector=${selector} count=${count}`,
    );
  }

  const match = findGenerationMatch();
  console.log("[OmniPiggy] findGenerationMatch:", match ?? "none");
  console.log("[OmniPiggy] detectActiveWaitState:", detectActiveWaitState());
  console.log(
    "[OmniPiggy] inline anchor:",
    findInlineAnchor() ? "found" : "null (floating fallback)",
  );
}

(window as Window & { __omniPiggyProbe?: () => void }).__omniPiggyProbe =
  omniPiggyProbe;

function isElementVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    parseFloat(style.opacity) > 0
  );
}

function isInConversationRegion(el: HTMLElement): boolean {
  return Boolean(
    el.closest('main, [role="main"], article, form, [role="dialog"]') ||
      el.closest(
        '[data-testid*="conversation"], [data-testid*="message"], [data-testid*="thread"], [data-testid*="composer"], [data-testid*="chat"]',
      ),
  );
}

function findInlineAnchor(): HTMLElement | null {
  const indicator = findGenerationIndicator();
  if (!indicator) return null;

  let current: HTMLElement | null = indicator.parentElement;
  for (let depth = 0; depth < ANCHOR_WALK_MAX && current; depth++) {
    if (
      current.getBoundingClientRect().width >= ANCHOR_MIN_WIDTH &&
      isElementVisible(current) &&
      isInConversationRegion(current)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function detectActiveWaitState(): boolean {
  const match = findGenerationMatch();
  if (match) {
    logDetectionMatch(match);
    return true;
  }

  const progressBars = document.querySelectorAll(
    '[role="progressbar"][aria-valuetext], [role="progressbar"][aria-busy="true"]',
  );
  if (progressBars.length > 0) {
    return true;
  }

  const submitButtons = document.querySelectorAll<HTMLButtonElement>(
    'button[type="submit"][disabled], button[data-testid="send-button"][disabled], button[data-testid*="send"][disabled], button[aria-label*="Send"][disabled]',
  );

  for (const button of submitButtons) {
    const form = button.closest("form");
    const scope = form ?? document;
    if (scopeHasStopControl(scope)) {
      return true;
    }
  }

  return false;
}

function removeWaitAd(): void {
  // Grok (and other SPAs) can rebuild the DOM and leave multiple nodes with the
  // same id. Sweep all matches — getElementById only finds the first.
  document.querySelectorAll(`#${BOX_ID}`).forEach((el) => {
    el.remove();
  });
  // Remove legacy Mindful Break nodes if still present from older builds.
  document.querySelectorAll("#omni-piggy-mindful-break").forEach((el) => {
    el.remove();
  });
  boxMounted = false;
  clearWaitTimer();
}

function isSponsoredWaitsEnabled(): Promise<boolean> {
  if (!isExtensionContextValid()) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(
        [SPONSORED_WAITS_KEY, LEGACY_BEHAVIORAL_KEY],
        (result) => {
          if (Object.prototype.hasOwnProperty.call(result, SPONSORED_WAITS_KEY)) {
            resolve(result[SPONSORED_WAITS_KEY] !== false);
            return;
          }
          // Default on; respect legacy behavioralLayer if present.
          resolve(result[LEGACY_BEHAVIORAL_KEY] !== false);
        },
      );
    } catch {
      resolve(true);
    }
  });
}

function setupSponsoredWaitsListener(): void {
  if (!isExtensionContextValid()) return;
  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (!isExtensionContextValid()) {
        stopExtensionScript();
        return;
      }
      if (areaName !== "local") return;
      const next =
        changes[SPONSORED_WAITS_KEY]?.newValue ??
        changes[LEGACY_BEHAVIORAL_KEY]?.newValue;
      if (next === false && boxMounted) {
        removeWaitAd();
      }
    });
  } catch {
    // ignore
  }
}

function clearSessionToken(): void {
  currentSessionToken = null;
}

function parsePlatformConfig(data: unknown): PlatformConfig {
  if (typeof data !== "object" || data === null) {
    return FALLBACK_PLATFORM_CONFIG;
  }
  const obj = data as Record<string, unknown>;
  const pickNum = (key: keyof PlatformConfig, fallback: number): number => {
    const value = obj[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };
  const pickStr = (key: keyof PlatformConfig, fallback: string): string => {
    const value = obj[key];
    return typeof value === "string" && value ? value : fallback;
  };
  return {
    currency: pickStr("currency", FALLBACK_PLATFORM_CONFIG.currency),
    symbol: pickStr("symbol", FALLBACK_PLATFORM_CONFIG.symbol),
    minWaitSeconds: pickNum(
      "minWaitSeconds",
      FALLBACK_PLATFORM_CONFIG.minWaitSeconds,
    ),
    minRedemption: pickNum(
      "minRedemption",
      FALLBACK_PLATFORM_CONFIG.minRedemption,
    ),
    userRevenueShareBps: pickNum(
      "userRevenueShareBps",
      FALLBACK_PLATFORM_CONFIG.userRevenueShareBps,
    ),
    omniRevenueShareBps: pickNum(
      "omniRevenueShareBps",
      FALLBACK_PLATFORM_CONFIG.omniRevenueShareBps,
    ),
  };
}

async function ensurePlatformConfig(): Promise<void> {
  if (platformConfig) return;

  try {
    const response = await sendBackgroundMessage({ type: "GET_CONFIG" });
    if (response.ok) {
      platformConfig = parsePlatformConfig(response.data);
      return;
    }
  } catch {
    // fall through
  }

  platformConfig = FALLBACK_PLATFORM_CONFIG;
}

function sendBackgroundMessage(
  message: BackgroundMessage,
): Promise<BackgroundResponse> {
  if (!isExtensionContextValid()) {
    return Promise.reject(new Error("Extension context invalidated"));
  }

  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(
        message,
        (response: BackgroundResponse | undefined) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }
          if (!response) {
            reject(new Error("No background response"));
            return;
          }
          resolve(response);
        },
      );
    } catch (error) {
      reject(error);
    }
  });
}

async function requestSessionToken(): Promise<void> {
  if (!isExtensionContextValid()) return;

  try {
    const response = await sendBackgroundMessage({
      type: "SESSION_START",
    });

    if (!response.ok) return;

    const payload = response.data as {
      success?: boolean;
      data?: { sessionToken?: string };
    };

    if (!payload.success || !payload.data?.sessionToken) return;

    currentSessionToken = payload.data.sessionToken;

    if (isGenerating) {
      void showOmniWaitAd();
    }
  } catch {
    // ignore
  }
}

function createOmniWaitAd(): HTMLElement {
  const box = document.createElement("div");
  box.id = BOX_ID;
  box.setAttribute("role", "complementary");
  box.setAttribute("aria-label", "Omni Sponsored Wait");

  const title = document.createElement("p");
  title.className = "omni-title";

  const body = document.createElement("p");
  body.className = "omni-body";

  const counter = document.createElement("p");
  counter.className = "omni-counter";

  const shareNote = document.createElement("p");
  shareNote.className = "omni-share-note";

  const adCard = document.createElement("div");
  adCard.className = "omni-ad-card";
  adCard.hidden = true;

  box.append(title, body, counter, shareNote, adCard);
  return box;
}

function mountBox(box: HTMLElement): void {
  const anchor = findInlineAnchor();
  if (anchor?.parentElement) {
    box.classList.add("omni-inline");
    anchor.parentElement.insertBefore(box, anchor);
    return;
  }
  box.classList.add("omni-floating");
  document.body.appendChild(box);
}

async function showOmniWaitAd(): Promise<void> {
  const existingBoxes = Array.from(
    document.querySelectorAll<HTMLElement>(`#${BOX_ID}`),
  );
  const connectedBoxes = existingBoxes.filter((el) => el.isConnected);

  for (const el of existingBoxes) {
    if (!el.isConnected) {
      el.remove();
    }
  }

  if (connectedBoxes.length > 1) {
    for (const el of connectedBoxes.slice(1)) {
      el.remove();
    }
  }

  if (connectedBoxes[0]?.isConnected) {
    boxMounted = true;
    return;
  }

  boxMounted = false;
  if (document.querySelector(`#${BOX_ID}`)) return;
  if (!currentSessionToken) return;

  const enabled = await isSponsoredWaitsEnabled();
  if (!enabled) return;

  injectStyles();

  const box = createOmniWaitAd();
  mountBox(box);
  boxMounted = true;
  updateWaitAd();
  if (waitTimerInterval === null) {
    startWaitTimer();
  }
}

function evaluateWaitState(): void {
  rafHandle = 0;

  if (!isExtensionContextValid()) {
    stopExtensionScript();
    return;
  }

  const active = detectActiveWaitState();

  if (active && !isGenerating) {
    detectionLoggedThisCycle = false;
    adFetchedThisCycle = false;
    adFetchInProgress = false;
    currentAd = null;
    adImpressionSent = false;
    generationStartedAt = Date.now();
    startWaitTimer();
    void ensurePlatformConfig();
    void requestSessionToken();
  }

  if (isGenerating && !active) {
    clearSessionToken();
    clearWaitTimer();
    generationStartedAt = null;
  }

  isGenerating = active;

  if (active) {
    const boxes = document.querySelectorAll(`#${BOX_ID}`);
    let connectedCount = 0;
    boxes.forEach((el) => {
      if (el.isConnected) {
        connectedCount += 1;
      } else {
        el.remove();
        boxMounted = false;
      }
    });
    if (connectedCount === 0) {
      boxMounted = false;
    }
    void showOmniWaitAd();
  } else if (!active && boxMounted) {
    removeWaitAd();
  }
}

function scheduleEvaluation(): void {
  if (!isExtensionContextValid()) {
    stopExtensionScript();
    return;
  }
  if (rafHandle) return;
  rafHandle = window.requestAnimationFrame(evaluateWaitState);
}

function startObserver(): void {
  if (observer) return;

  setupSponsoredWaitsListener();

  observer = new MutationObserver(scheduleEvaluation);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "aria-label",
      "aria-busy",
      "aria-valuetext",
      "disabled",
      "data-testid",
      "data-action",
      "title",
      "role",
    ],
  });

  scheduleEvaluation();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startObserver, { once: true });
} else {
  startObserver();
}
