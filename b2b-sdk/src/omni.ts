/**
 * Omni Monetize B2B SDK (Phase 1 cleanup).
 * Fixed-reward claim UX removed. Partners start wait sessions and show a
 * Sponsored Wait card; advertiser settlement arrives in later phases.
 */
const DEFAULT_API_BASE = "http://localhost:3001";
const BOX_ID = "omni-wait-ad";
const STYLE_ID = "omni-b2b-styles";

type PlatformConfig = {
  symbol: string;
  minWaitSeconds: number;
  userRevenueShareBps: number;
};

type OmniInitOptions = {
  partnerKey: string;
  /** Required for non-local deployments. Defaults to http://localhost:3001 */
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

let platformConfig: PlatformConfig = {
  symbol: "₹",
  minWaitSeconds: 5,
  userRevenueShareBps: 6000,
};

let sessionToken: string | null = null;
let generationStartedAt: number | null = null;
let waitTimerInterval: ReturnType<typeof setInterval> | null = null;

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
      data?: Partial<PlatformConfig>;
    };

    if (!json.success || !json.data) {
      return;
    }

    platformConfig = {
      symbol: json.data.symbol ?? platformConfig.symbol,
      minWaitSeconds:
        json.data.minWaitSeconds ?? platformConfig.minWaitSeconds,
      userRevenueShareBps:
        json.data.userRevenueShareBps ?? platformConfig.userRevenueShareBps,
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
      margin: 0 0 8px;
      font-size: 15px;
      font-weight: 600;
      color: #ffffff;
    }

    #${BOX_ID} .omni-body {
      margin: 0 0 8px;
      font-size: 13px;
      line-height: 1.45;
      color: #a1a1aa;
    }

    #${BOX_ID} .omni-counter {
      margin: 0 0 8px;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0.05em;
      color: #71717a;
    }

    #${BOX_ID} .omni-share-note {
      margin: 0;
      font-size: 11px;
      color: #71717a;
    }
  `;
  document.head.appendChild(style);
}

function removeCard(): void {
  document.getElementById(BOX_ID)?.remove();
  document.getElementById("omni-b2b-card")?.remove();
}

function updateCard(): void {
  const box = document.getElementById(BOX_ID);
  if (!box) {
    return;
  }

  const title = box.querySelector<HTMLElement>(".omni-title");
  const body = box.querySelector<HTMLElement>(".omni-body");
  const counter = box.querySelector<HTMLElement>(".omni-counter");
  const shareNote = box.querySelector<HTMLElement>(".omni-share-note");
  if (!title || !body || !counter || !shareNote) {
    return;
  }

  const elapsed = getElapsedSeconds();
  const userPct = Math.floor(platformConfig.userRevenueShareBps / 100);
  title.textContent = "Sponsored Wait";
  shareNote.textContent = `Omni · Partner inventory · ${userPct}% user share model`;

  if (elapsed < platformConfig.minWaitSeconds) {
    body.textContent = "Loading sponsored placement while AI generates…";
    counter.textContent = `${elapsed}s`;
    counter.hidden = false;
  } else {
    body.textContent =
      "Wait qualified for inventory. Settlement uses advertiser-funded revenue (no fixed claim).";
    counter.hidden = true;
  }
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

  const shareNote = document.createElement("p");
  shareNote.className = "omni-share-note";

  box.append(title, body, counter, shareNote);
  document.body.appendChild(box);
  updateCard();
}

function startWaitTimer(): void {
  if (waitTimerInterval !== null) {
    clearInterval(waitTimerInterval);
  }

  waitTimerInterval = setInterval(() => {
    if (!generationStartedAt) {
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
  removeCard();
  sessionToken = null;
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
