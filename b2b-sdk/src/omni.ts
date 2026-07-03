const DEFAULT_API_BASE =
  "https://omni-protocol-ai-waittime-production.up.railway.app";
const BOX_ID = "omni-b2b-card";
const STYLE_ID = "omni-b2b-styles";
const LAYER = "behavioralLayer";
const MIN_WAIT_SECONDS = 5;

type RewardConfig = {
  symbol: string;
  tier2Amount: number;
  minWaitSeconds: number;
};

type OmniInitOptions = {
  partnerKey: string;
  apiBase?: string;
  userId?: string;
};

type OmniGlobal = {
  init(options: OmniInitOptions): void;
  onGenerationStart(): Promise<void>;
  onGenerationEnd(): void;
};

let config: {
  partnerKey: string;
  apiBase: string;
  userId: string;
} | null = null;

let rewardConfig: RewardConfig = {
  symbol: "₹",
  tier2Amount: 2,
  minWaitSeconds: MIN_WAIT_SECONDS,
};

let sessionToken: string | null = null;
let generationStartedAt: number | null = null;
let waitTimerInterval: ReturnType<typeof setInterval> | null = null;
let claimedThisCycle = false;
let isClaiming = false;

function getStoredUserId(): string {
  const key = "omni_b2b_user_id";
  const existing = localStorage.getItem(key);
  if (existing) {
    return existing;
  }

  const created = `b2b-${crypto.randomUUID()}`;
  localStorage.setItem(key, created);
  return created;
}

async function fetchConfig(apiBase: string): Promise<void> {
  try {
    const response = await fetch(`${apiBase}/api/v1/config`);
    if (!response.ok) {
      return;
    }

    const json = (await response.json()) as {
      success?: boolean;
      data?: Partial<RewardConfig>;
    };

    if (!json.success || !json.data) {
      return;
    }

    rewardConfig = {
      symbol: json.data.symbol ?? rewardConfig.symbol,
      tier2Amount: json.data.tier2Amount ?? rewardConfig.tier2Amount,
      minWaitSeconds: json.data.minWaitSeconds ?? rewardConfig.minWaitSeconds,
    };
  } catch {
    // Keep defaults when config is unreachable.
  }
}

function getElapsedSeconds(): number {
  if (generationStartedAt === null) {
    return 0;
  }

  return Math.floor((Date.now() - generationStartedAt) / 1000);
}

function formatMoney(amount: number): string {
  return `${rewardConfig.symbol}${amount}`;
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${BOX_ID} {
      position: fixed;
      right: 20px;
      bottom: 20px;
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
    }

    #${BOX_ID} .omni-title {
      margin: 0 0 14px;
      font-size: 17px;
      font-weight: 600;
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
      font-weight: 600;
      cursor: pointer;
    }

    #${BOX_ID} .omni-claim-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    #${BOX_ID} .omni-success {
      margin: 0;
      font-size: 14px;
      color: #39ff88;
    }
  `;
  document.head.appendChild(style);
}

function removeCard(): void {
  document.getElementById(BOX_ID)?.remove();
}

function updateCard(): void {
  const box = document.getElementById(BOX_ID);
  if (!box || claimedThisCycle || isClaiming) {
    return;
  }

  const title = box.querySelector<HTMLElement>(".omni-title");
  const body = box.querySelector<HTMLElement>(".omni-body");
  const counter = box.querySelector<HTMLElement>(".omni-counter");
  const button = box.querySelector<HTMLButtonElement>(".omni-claim-btn");
  if (!title || !body || !counter || !button) {
    return;
  }

  const elapsed = getElapsedSeconds();
  const ready = elapsed >= rewardConfig.minWaitSeconds;

  if (!ready) {
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
  title.textContent = "🧘 Mindful Break";
  button.textContent = `Claim ${formatMoney(rewardConfig.tier2Amount)} Dividend`;
}

function showCard(): void {
  if (document.getElementById(BOX_ID)) {
    updateCard();
    return;
  }

  injectStyles();

  const box = document.createElement("div");
  box.id = BOX_ID;

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
  button.addEventListener("click", () => {
    void handleClaim(box, button);
  });

  box.append(title, body, counter, button);
  document.body.appendChild(box);
  updateCard();
}

function startWaitTimer(): void {
  if (waitTimerInterval !== null) {
    clearInterval(waitTimerInterval);
  }

  waitTimerInterval = setInterval(() => {
    if (!generationStartedAt || claimedThisCycle) {
      return;
    }

    updateCard();
  }, 1000);
}

function stopWaitTimer(): void {
  if (waitTimerInterval !== null) {
    clearInterval(waitTimerInterval);
    waitTimerInterval = null;
  }
}

async function handleClaim(
  box: HTMLElement,
  button: HTMLButtonElement,
): Promise<void> {
  if (!config || !sessionToken || isClaiming || claimedThisCycle) {
    return;
  }

  if (getElapsedSeconds() < rewardConfig.minWaitSeconds) {
    return;
  }

  isClaiming = true;
  button.disabled = true;

  try {
    const response = await fetch(`${config.apiBase}/api/v1/yield`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: config.userId,
        amount: rewardConfig.tier2Amount,
        layer: LAYER,
        nonce: crypto.randomUUID(),
        sessionToken,
        partnerKey: config.partnerKey,
      }),
    });

    const json = (await response.json()) as {
      success?: boolean;
      message?: string;
      data?: { creditedAmount?: number };
    };

    if (!response.ok || !json.success) {
      throw new Error(json.message ?? `Claim failed (${response.status})`);
    }

    claimedThisCycle = true;
    stopWaitTimer();

    const credited = json.data?.creditedAmount ?? rewardConfig.tier2Amount;
    box.replaceChildren();
    const success = document.createElement("p");
    success.className = "omni-success";
    success.textContent = `Claimed ${formatMoney(credited)}!`;
    box.append(success);

    window.setTimeout(() => {
      removeCard();
    }, 2500);
  } catch (error) {
    button.disabled = false;
    isClaiming = false;
    console.error("[Omni SDK] Claim failed:", error);
  }
}

function init(options: OmniInitOptions): void {
  const partnerKey = options.partnerKey?.trim();
  if (!partnerKey) {
    throw new Error("Omni.init() requires a partnerKey.");
  }

  config = {
    partnerKey,
    apiBase: options.apiBase?.replace(/\/$/, "") ?? DEFAULT_API_BASE,
    userId: options.userId?.trim() || getStoredUserId(),
  };

  void fetchConfig(config.apiBase);
}

async function onGenerationStart(): Promise<void> {
  if (!config) {
    throw new Error("Call Omni.init() before Omni.onGenerationStart().");
  }

  claimedThisCycle = false;
  isClaiming = false;
  generationStartedAt = Date.now();
  sessionToken = null;
  removeCard();

  const response = await fetch(`${config.apiBase}/api/v1/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: config.userId,
      partnerKey: config.partnerKey,
    }),
  });

  const json = (await response.json()) as {
    success?: boolean;
    message?: string;
    data?: { sessionToken?: string };
  };

  if (!response.ok || !json.success || !json.data?.sessionToken) {
    throw new Error(json.message ?? `Session start failed (${response.status})`);
  }

  sessionToken = json.data.sessionToken;
  showCard();
  startWaitTimer();
}

function onGenerationEnd(): void {
  generationStartedAt = null;
  stopWaitTimer();

  if (!claimedThisCycle) {
    removeCard();
  }
}

const Omni: OmniGlobal = {
  init,
  onGenerationStart,
  onGenerationEnd,
};

export default Omni;

declare global {
  interface Window {
    Omni: OmniGlobal;
  }
}

if (typeof window !== "undefined") {
  window.Omni = Omni;
}
