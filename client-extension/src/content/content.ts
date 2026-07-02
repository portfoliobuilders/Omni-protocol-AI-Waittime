const BEHAVIORAL_LAYER_KEY = "behavioralLayer";
const AMOUNT_TIER2 = 0.1;
const AMOUNT_TIER3 = 0.25;
const TIER1_MAX_SEC = 4;
const TIER2_MAX_SEC = 14;
const USER_ID = "user-001";
const YIELD_LAYER = "behavioralLayer";
const BOX_ID = "omni-piggy-mindful-break";
const STYLE_ID = "omni-piggy-styles";

const GENERATION_SELECTORS = [
  '[aria-label="Stop generating"]',
  '[aria-label*="Stop"]',
  '[data-testid="stop-button"]',
  'button[aria-label="Stop streaming"]',
].join(", ");

let observer: MutationObserver | null = null;
let rafHandle = 0;
let isGenerating = false;
let boxMounted = false;
let claimedThisCycle = false;
let isClaiming = false;
let currentSessionToken: string | null = null;
let generationStartedAt: number | null = null;
let waitTimerInterval: number | null = null;

type BackgroundMessage =
  | { type: "SESSION_START"; payload: { userId: string } }
  | {
      type: "CLAIM_YIELD";
      payload: {
        userId: string;
        amount: number;
        layer: string;
        nonce: string;
        sessionToken: string | null;
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
  if (elapsedSec <= TIER1_MAX_SEC) return 1;
  if (elapsedSec <= TIER2_MAX_SEC) return 2;
  return 3;
}

function getClaimAmount(tier: WaitTier): number {
  return tier >= 3 ? AMOUNT_TIER3 : AMOUNT_TIER2;
}

function formatClaimAmount(amount: number): string {
  return amount.toFixed(2);
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
    return;
  }

  body.hidden = true;
  counter.hidden = true;
  button.hidden = false;

  if (tier === 2) {
    title.textContent = "🧘 Mindful Break";
    button.textContent = "Claim $0.10 Dividend";
    return;
  }

  title.textContent = "💎 Deep Work Bonus";
  button.textContent = "Claim $0.25 Dividend";
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${BOX_ID} {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 2147483647;
      width: 280px;
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
      transform: translateX(0);
      opacity: 1;
      transition:
        transform 0.55s cubic-bezier(0.4, 0, 0.2, 1),
        opacity 0.55s cubic-bezier(0.4, 0, 0.2, 1);
      pointer-events: auto;
    }

    #${BOX_ID}.omni-slide-out {
      transform: translateX(calc(100% + 32px));
      opacity: 0;
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
  `;

  document.head.appendChild(style);
}

function detectActiveWaitState(): boolean {
  if (document.querySelector(GENERATION_SELECTORS)) {
    return true;
  }

  const typingIndicators = document.querySelectorAll(
    '[class*="typing"], [data-testid="conversation-turn"] [class*="result-streaming"]',
  );
  if (typingIndicators.length > 0) {
    return true;
  }

  const submitButtons = document.querySelectorAll<HTMLButtonElement>(
    'button[type="submit"], button[data-testid="send-button"], form button[class*="send"]',
  );

  for (const button of submitButtons) {
    if (!button.disabled) continue;

    const form = button.closest("form");
    const hasStopControl = form
      ? form.querySelector(GENERATION_SELECTORS)
      : document.querySelector(GENERATION_SELECTORS);

    if (hasStopControl) {
      return true;
    }
  }

  return false;
}

function removeBox(): void {
  const existing = document.getElementById(BOX_ID);
  if (existing) {
    existing.remove();
  }
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
      payload: { userId: USER_ID },
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

async function showMindfulBreakBox(): Promise<void> {
  if (boxMounted || claimedThisCycle || isClaiming) return;
  if (!currentSessionToken) return;

  const enabled = await isBehavioralLayerEnabled();
  if (!enabled) return;

  injectStyles();
  removeBox();

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

  box.append(title, body, counter, button);
  document.body.appendChild(box);
  boxMounted = true;
  updateBoxTier();
  if (waitTimerInterval === null) {
    startWaitTimer();
  }
}

async function handleClaim(
  box: HTMLElement,
  button: HTMLButtonElement,
): Promise<void> {
  if (isClaiming) return;
  isClaiming = true;
  button.disabled = true;

  const claimAmount = getClaimAmount(getWaitTier(getElapsedSeconds()));

  try {
    const response = await sendBackgroundMessage({
      type: "CLAIM_YIELD",
      payload: {
        userId: USER_ID,
        amount: claimAmount,
        layer: YIELD_LAYER,
        nonce: crypto.randomUUID(),
        sessionToken: currentSessionToken,
      },
    });

    if (!response.ok) {
      throw new Error(
        response.status
          ? `Yield API responded with ${response.status}`
          : response.error,
      );
    }

    button.classList.add("omni-claimed");
    button.innerHTML = `
      <span class="omni-check">
        <span class="omni-check-icon" aria-hidden="true"></span>
        Claimed $${formatClaimAmount(claimAmount)}
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
    generationStartedAt = Date.now();
    startWaitTimer();
    void requestSessionToken();
  }

  if (isGenerating && !active && !claimedThisCycle) {
    clearSessionToken();
    clearWaitTimer();
    generationStartedAt = null;
  }

  isGenerating = active;

  if (active && !claimedThisCycle) {
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
    attributeFilter: ["aria-label", "disabled", "class", "data-testid"],
  });

  scheduleEvaluation();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startObserver, { once: true });
} else {
  startObserver();
}
