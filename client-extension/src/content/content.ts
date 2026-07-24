const BEHAVIORAL_LAYER_KEY = "behavioralLayer";
const YIELD_LAYER = "behavioralLayer";
const BOX_ID = "omni-piggy-mindful-break";
const STYLE_ID = "omni-piggy-styles";

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
    selectors: [
      '[aria-label*="Stop"]',
      '[data-testid*="stop"]',
    ],
  },
  {
    name: "Grok",
    hosts: ["grok.com"],
    selectors: [
      '[aria-label*="Stop"]',
      '[data-testid*="stop"]',
    ],
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
let claimedThisCycle = false;
let isClaiming = false;
let detectionLoggedThisCycle = false;
let currentSessionToken: string | null = null;
let generationStartedAt: number | null = null;
let waitTimerInterval: number | null = null;
let surveyFetchedThisCycle = false;
let surveyFetchInProgress = false;
let currentSurvey: SurveyQuestion | null = null;
let adFetchedThisCycle = false;
let adFetchInProgress = false;
let currentAd: SponsoredAd | null = null;
let adImpressionSent = false;

type RewardConfig = {
  currency: string;
  symbol: string;
  tier2Amount: number;
  tier3Amount: number;
  minRedemption: number;
  minWaitSeconds: number;
  tier3Seconds: number;
};

const FALLBACK_REWARD_CONFIG: RewardConfig = {
  currency: "INR",
  symbol: "₹",
  tier2Amount: 2,
  tier3Amount: 10,
  minRedemption: 100,
  minWaitSeconds: 5,
  tier3Seconds: 15,
};

let rewardConfig: RewardConfig | null = null;

type SurveyQuestion = {
  id: number;
  question: string;
  options: string[];
};

type SponsoredAd = {
  id: number;
  headline: string;
  body: string;
  cta_label: string;
  cta_url: string;
};

type BackgroundMessage =
  | { type: "SESSION_START"; payload?: undefined }
  | { type: "GET_CONFIG"; payload?: undefined }
  | { type: "GET_SURVEY"; payload?: undefined }
  | { type: "GET_AD"; payload?: undefined }
  | {
      type: "AD_EVENT";
      payload: { adId: number; event: "impression" | "click" };
    }
  | {
      type: "CLAIM_YIELD";
      payload: {
        amount: number;
        layer: string;
        nonce: string;
        sessionToken: string | null;
        surveyQuestionId?: number;
        surveyAnswer?: string;
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
  removeBox();
}

type WaitTier = 1 | 2 | 3;

function getElapsedSeconds(): number {
  if (generationStartedAt === null) return 0;
  return Math.floor((Date.now() - generationStartedAt) / 1000);
}

function getWaitTier(elapsedSec: number): WaitTier {
  const cfg = rewardConfig ?? FALLBACK_REWARD_CONFIG;
  if (elapsedSec < cfg.minWaitSeconds) return 1;
  if (elapsedSec < cfg.tier3Seconds) return 2;
  return 3;
}

function getClaimAmount(tier: WaitTier): number {
  const cfg = rewardConfig ?? FALLBACK_REWARD_CONFIG;
  return tier >= 3 ? cfg.tier3Amount : cfg.tier2Amount;
}

function formatMoney(amount: number): string {
  const cfg = rewardConfig ?? FALLBACK_REWARD_CONFIG;
  const display = amount % 1 === 0 ? String(amount) : amount.toFixed(2);
  return `${cfg.symbol}${display}`;
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
    if (claimedThisCycle || isClaiming || !isGenerating) {
      clearWaitTimer();
      return;
    }
    if (boxMounted) {
      updateBoxTier();
    }
  }, 1000);
}

function clearSurveyOptions(box: HTMLElement): void {
  const container = box.querySelector<HTMLElement>(".omni-survey-options");
  if (container) {
    container.hidden = true;
    container.innerHTML = "";
    delete container.dataset.surveyId;
  }
}

function renderTier3Survey(
  box: HTMLElement,
  title: HTMLElement,
  body: HTMLElement,
  counter: HTMLElement,
  button: HTMLButtonElement,
): void {
  if (!currentSurvey) return;

  title.textContent = `💬 Quick Question — earn ${formatMoney(
    (rewardConfig ?? FALLBACK_REWARD_CONFIG).tier3Amount,
  )}`;
  body.textContent = currentSurvey.question;
  body.hidden = false;
  counter.hidden = true;
  button.hidden = true;

  const container = box.querySelector<HTMLElement>(".omni-survey-options");
  if (!container) return;

  if (container.dataset.surveyId === String(currentSurvey.id)) return;
  container.dataset.surveyId = String(currentSurvey.id);

  container.hidden = false;
  container.innerHTML = "";

  for (const option of currentSurvey.options) {
    const optBtn = document.createElement("button");
    optBtn.type = "button";
    optBtn.className = "omni-survey-option";
    optBtn.textContent = option;
    optBtn.addEventListener("click", () => {
      void handleClaim(box, button, {
        surveyQuestionId: currentSurvey!.id,
        surveyAnswer: option,
      });
    });
    container.appendChild(optBtn);
  }
}

async function fetchSurveyForTier3(): Promise<void> {
  if (surveyFetchedThisCycle || surveyFetchInProgress) return;
  surveyFetchInProgress = true;

  try {
    const response = await sendBackgroundMessage({ type: "GET_SURVEY" });
    surveyFetchedThisCycle = true;

    if (response.ok) {
      const payload = response.data as {
        success?: boolean;
        data?: { question?: SurveyQuestion | null };
      };
      const question =
        payload.success && payload.data?.question ? payload.data.question : null;
      if (question && question.options.length >= 2) {
        currentSurvey = question;
      } else {
        currentSurvey = null;
      }
    } else {
      currentSurvey = null;
    }
  } catch {
    surveyFetchedThisCycle = true;
    currentSurvey = null;
  } finally {
    surveyFetchInProgress = false;
    if (boxMounted && !claimedThisCycle && !isClaiming) {
      updateBoxTier();
    }
  }
}

function hideAdCard(box: HTMLElement): void {
  const container = box.querySelector<HTMLElement>(".omni-ad-card");
  if (container) {
    container.hidden = true;
  }
}

async function fetchAdForTier2(): Promise<void> {
  if (adFetchedThisCycle || adFetchInProgress) return;
  adFetchInProgress = true;

  try {
    const response = await sendBackgroundMessage({ type: "GET_AD" });
    adFetchedThisCycle = true;

    if (response.ok) {
      const payload = response.data as {
        success?: boolean;
        data?: { ad?: SponsoredAd | null };
      };
      const ad = payload.success && payload.data?.ad ? payload.data.ad : null;
      if (ad && ad.headline && ad.cta_url) {
        currentAd = ad;
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
    if (boxMounted && !claimedThisCycle && !isClaiming) {
      updateBoxTier();
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
      payload: { adId: adSnapshot.id, event: "click" },
    });
    window.open(adSnapshot.cta_url, "_blank", "noopener");
  });

  container.append(label, headline, adBody, cta);

  if (!adImpressionSent) {
    adImpressionSent = true;
    void sendBackgroundMessage({
      type: "AD_EVENT",
      payload: { adId: currentAd.id, event: "impression" },
    });
  }
}

function updateBoxTier(): void {
  const box = document.getElementById(BOX_ID);
  if (!box || isClaiming || claimedThisCycle) return;

  const title = box.querySelector<HTMLElement>(".omni-title");
  const body = box.querySelector<HTMLElement>(".omni-body");
  const counter = box.querySelector<HTMLElement>(".omni-counter");
  const button = box.querySelector<HTMLButtonElement>(".omni-claim-btn");
  if (!title || !body || !counter || !button) return;

  const elapsed = getElapsedSeconds();
  const tier = getWaitTier(elapsed);

  if (tier === 1) {
    title.textContent = "🧘 Mindful Break";
    body.textContent = "Your AI is thinking — take a breath.";
    body.hidden = false;
    counter.textContent = `${elapsed}s`;
    counter.hidden = false;
    button.hidden = true;
    hideAdCard(box);
    return;
  }

  body.hidden = true;
  counter.hidden = true;
  button.hidden = false;

  if (tier === 2) {
    clearSurveyOptions(box);
    title.textContent = "🧘 Mindful Break";
    button.textContent = `Claim ${formatMoney(
      (rewardConfig ?? FALLBACK_REWARD_CONFIG).tier2Amount,
    )} Dividend`;
    if (!adFetchedThisCycle && !adFetchInProgress) {
      void fetchAdForTier2();
    }
    renderAdCard(box);
    return;
  }

  if (!surveyFetchedThisCycle && !surveyFetchInProgress) {
    void fetchSurveyForTier3();
  }

  if (surveyFetchInProgress && !surveyFetchedThisCycle) {
    clearSurveyOptions(box);
    title.textContent = "💎 Deep Work Bonus";
    body.hidden = true;
    counter.hidden = true;
    button.hidden = true;
    renderAdCard(box);
    return;
  }

  if (currentSurvey) {
    renderTier3Survey(box, title, body, counter, button);
    renderAdCard(box);
    return;
  }

  clearSurveyOptions(box);
  title.textContent = "💎 Deep Work Bonus";
  button.textContent = `Claim ${formatMoney(
    (rewardConfig ?? FALLBACK_REWARD_CONFIG).tier3Amount,
  )} Dividend`;
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
      margin: 0 0 14px;
      font-size: 17px;
      font-weight: 600;
      letter-spacing: 0.01em;
      color: #ffffff;
    }

    #${BOX_ID} .omni-body {
      margin: 0 0 10px;
      font-size: 14px;
      line-height: 1.45;
      color: #a1a1aa;
    }

    #${BOX_ID} .omni-counter {
      margin: 0 0 14px;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0.05em;
      color: #71717a;
    }

    #${BOX_ID} .omni-claim-btn {
      width: 100%;
      padding: 11px 16px;
      border: none;
      border-radius: 10px;
      background: linear-gradient(135deg, #39ff88 0%, #1a9f52 100%);
      color: #0a1a10;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition:
        transform 0.15s ease,
        box-shadow 0.15s ease,
        opacity 0.15s ease;
      box-shadow: 0 4px 16px rgba(57, 255, 136, 0.3);
    }

    #${BOX_ID} .omni-claim-btn:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(57, 255, 136, 0.4);
    }

    #${BOX_ID} .omni-claim-btn:disabled {
      cursor: default;
      opacity: 0.85;
    }

    #${BOX_ID} .omni-claim-btn.omni-claimed {
      background: linear-gradient(135deg, #2dd4bf 0%, #059669 100%);
      color: #ffffff;
    }

    #${BOX_ID} .omni-survey-options {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    #${BOX_ID} .omni-survey-option {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.06);
      color: #f4f4f5;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      text-align: left;
      transition:
        background 0.15s ease,
        border-color 0.15s ease;
    }

    #${BOX_ID} .omni-survey-option:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(57, 255, 136, 0.35);
    }

    #${BOX_ID} .omni-survey-option:disabled {
      cursor: default;
      opacity: 0.6;
    }

    #${BOX_ID} .omni-check {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }

    #${BOX_ID} .omni-check-icon {
      display: inline-block;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.2);
      position: relative;
      animation: omni-pop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    #${BOX_ID} .omni-check-icon::after {
      content: "";
      position: absolute;
      left: 5px;
      top: 3px;
      width: 5px;
      height: 9px;
      border: solid #fff;
      border-width: 0 2px 2px 0;
      transform: rotate(45deg);
      animation: omni-draw 0.25s ease 0.1s both;
    }

    @keyframes omni-pop {
      0% { transform: scale(0); opacity: 0; }
      100% { transform: scale(1); opacity: 1; }
    }

    @keyframes omni-draw {
      0% { opacity: 0; transform: rotate(45deg) scale(0.5); }
      100% { opacity: 1; transform: rotate(45deg) scale(1); }
    }

    #${BOX_ID} .omni-ad-card {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }

    #${BOX_ID} .omni-ad-label {
      margin: 0 0 6px;
      font-size: 9px;
      font-weight: 500;
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
  return SITE_PROFILES.filter((profile) => hostMatchesProfile(hostname, profile.hosts));
}

function getAllDetectionSelectors(): string[] {
  const profileSelectors = getActiveSiteProfiles().flatMap((profile) => profile.selectors);
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
    activeProfiles.length > 0 ? activeProfiles.map((p) => p.name).join(", ") : "(none)",
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
  console.log("[OmniPiggy] inline anchor:", findInlineAnchor() ? "found" : "null (floating fallback)");
}

(window as Window & { __omniPiggyProbe?: () => void }).__omniPiggyProbe = omniPiggyProbe;

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

function removeBox(): void {
  // Grok (and other SPAs) can rebuild the DOM and leave multiple nodes with the
  // same id. Sweep all matches — getElementById only finds the first.
  document.querySelectorAll(`#${BOX_ID}`).forEach((el) => {
    el.remove();
  });
  boxMounted = false;
  clearWaitTimer();
}

function isBehavioralLayerEnabled(): Promise<boolean> {
  if (!isExtensionContextValid()) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([BEHAVIORAL_LAYER_KEY], (result) => {
        resolve(result[BEHAVIORAL_LAYER_KEY] !== false);
      });
    } catch {
      resolve(true);
    }
  });
}

function setupBehavioralLayerListener(): void {
  if (!isExtensionContextValid()) return;
  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (!isExtensionContextValid()) {
        stopExtensionScript();
        return;
      }
      if (areaName !== "local") return;
      if (!changes[BEHAVIORAL_LAYER_KEY]) return;
      if (changes[BEHAVIORAL_LAYER_KEY].newValue === false && boxMounted && !isClaiming) {
        removeBox();
      }
    });
  } catch {
    // ignore
  }
}

function clearSessionToken(): void {
  currentSessionToken = null;
}

async function ensureRewardConfig(): Promise<void> {
  if (rewardConfig) return;

  try {
    const response = await sendBackgroundMessage({ type: "GET_CONFIG" });
    if (response.ok && typeof response.data === "object" && response.data !== null) {
      rewardConfig = response.data as RewardConfig;
      return;
    }
  } catch {
    // fall through to fallback
  }

  rewardConfig = FALLBACK_REWARD_CONFIG;
}

function sendBackgroundMessage(message: BackgroundMessage): Promise<BackgroundResponse> {
  if (!isExtensionContextValid()) {
    return Promise.reject(new Error("Extension context invalidated"));
  }

  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response: BackgroundResponse | undefined) => {
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
      });
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

    if (isGenerating && !claimedThisCycle) {
      void showMindfulBreakBox();
    }
  } catch {
    // ignore
  }
}

function createMindfulBreakBox(): HTMLElement {
  const box = document.createElement("div");
  box.id = BOX_ID;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Mindful Break dividend offer");

  const title = document.createElement("p");
  title.className = "omni-title";

  const body = document.createElement("p");
  body.className = "omni-body";

  const counter = document.createElement("p");
  counter.className = "omni-counter";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "omni-claim-btn";
  button.hidden = true;
  button.addEventListener("click", () => void handleClaim(box, button));

  const surveyOptions = document.createElement("div");
  surveyOptions.className = "omni-survey-options";
  surveyOptions.hidden = true;

  const adCard = document.createElement("div");
  adCard.className = "omni-ad-card";
  adCard.hidden = true;

  box.append(title, body, counter, surveyOptions, button, adCard);
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

async function showMindfulBreakBox(): Promise<void> {
  const existingBoxes = Array.from(
    document.querySelectorAll<HTMLElement>(`#${BOX_ID}`),
  );
  const connectedBoxes = existingBoxes.filter((el) => el.isConnected);

  // Drop detached orphans left behind by SPA DOM rebuilds (notably Grok).
  for (const el of existingBoxes) {
    if (!el.isConnected) {
      el.remove();
    }
  }

  // Invalid HTML can still produce duplicate ids — keep one, remove the rest.
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
  if (claimedThisCycle || isClaiming) return;
  if (!currentSessionToken) return;

  const enabled = await isBehavioralLayerEnabled();
  if (!enabled) return;

  injectStyles();

  const box = createMindfulBreakBox();
  mountBox(box);
  boxMounted = true;
  updateBoxTier();
  if (waitTimerInterval === null) {
    startWaitTimer();
  }
}

async function handleClaim(
  box: HTMLElement,
  button: HTMLButtonElement,
  survey?: { surveyQuestionId: number; surveyAnswer: string },
): Promise<void> {
  if (isClaiming) return;
  isClaiming = true;

  const surveyContainer = box.querySelector<HTMLElement>(".omni-survey-options");
  if (surveyContainer) {
    surveyContainer.querySelectorAll("button").forEach((el) => {
      (el as HTMLButtonElement).disabled = true;
    });
  }
  button.disabled = true;

  const claimAmount = survey
    ? (rewardConfig ?? FALLBACK_REWARD_CONFIG).tier3Amount
    : getClaimAmount(getWaitTier(getElapsedSeconds()));

  try {
    const response = await sendBackgroundMessage({
      type: "CLAIM_YIELD",
      payload: {
        amount: claimAmount,
        layer: YIELD_LAYER,
        nonce: crypto.randomUUID(),
        sessionToken: currentSessionToken,
        ...(survey
          ? {
              surveyQuestionId: survey.surveyQuestionId,
              surveyAnswer: survey.surveyAnswer,
            }
          : {}),
      },
    });

    if (!response.ok) {
      if (response.status === 400) {
        console.error("[OmniPiggy] Survey claim rejected:", response.error);
      }
      throw new Error(
        response.status
          ? `Yield API responded with ${response.status}`
          : response.error,
      );
    }

    clearSurveyOptions(box);
    button.hidden = false;
    button.classList.add("omni-claimed");
    button.innerHTML = `
      <span class="omni-check">
        <span class="omni-check-icon" aria-hidden="true"></span>
        Claimed ${formatMoney(claimAmount)}
      </span>
    `;

    claimedThisCycle = true;
    clearWaitTimer();
    clearSessionToken();

    window.setTimeout(() => {
      box.classList.add("omni-slide-out");
      window.setTimeout(() => {
        removeBox();
        isClaiming = false;
      }, 550);
    }, 2000);
  } catch (error) {
    console.error("[OmniPiggy] Failed to claim dividend:", error);
    clearSurveyOptions(box);
    button.hidden = false;
    button.textContent = "Bank offline — Retry";
    button.disabled = false;
    isClaiming = false;
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
    claimedThisCycle = false;
    detectionLoggedThisCycle = false;
    surveyFetchedThisCycle = false;
    surveyFetchInProgress = false;
    currentSurvey = null;
    adFetchedThisCycle = false;
    adFetchInProgress = false;
    currentAd = null;
    adImpressionSent = false;
    generationStartedAt = Date.now();
    startWaitTimer();
    void ensureRewardConfig();
    void requestSessionToken();
  }

  if (isGenerating && !active && !claimedThisCycle) {
    clearSessionToken();
    clearWaitTimer();
    generationStartedAt = null;
  }

  isGenerating = active;

  if (active && !claimedThisCycle) {
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
    void showMindfulBreakBox();
  } else if (!active && boxMounted && !isClaiming) {
    removeBox();
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

  setupBehavioralLayerListener();

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
