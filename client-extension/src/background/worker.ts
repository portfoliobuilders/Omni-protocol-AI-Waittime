// Local dev: set API_BASE_URL to http://localhost:3001 and re-add
// "http://localhost:3001/*" to host_permissions in public/manifest.json.
const API_BASE_URL = "https://omni-protocol-ai-waittime-production.up.railway.app";
const API_BASE = `${API_BASE_URL}/api/v1`;
const HEALTH_URL = `${API_BASE_URL}/health`;
const REQUEST_TIMEOUT_MS = 5000;
const EARNINGS_KEY = "omniEarnings";
const USER_ID_KEY = "omniUserId";

let cachedUserId: string | null = null;

export interface RewardConfig {
  currency: string;
  symbol: string;
  tier2Amount: number;
  tier3Amount: number;
  minRedemption: number;
  minWaitSeconds: number;
  tier3Seconds: number;
}

const DEFAULT_REWARD_CONFIG: RewardConfig = {
  currency: "INR",
  symbol: "₹",
  tier2Amount: 2,
  tier3Amount: 10,
  minRedemption: 100,
  minWaitSeconds: 5,
  tier3Seconds: 15,
};

const CONFIG_TTL_MS = 10 * 60 * 1000;
let cachedRewardConfig: RewardConfig | null = null;
let configFetchedAt = 0;

export interface ClaimYieldPayload {
  userId: string;
  amount: number;
  layer: string;
  nonce: string;
  sessionToken: string | null;
  surveyQuestionId?: number;
  surveyAnswer?: string;
}

type ClaimYieldClientPayload = Omit<ClaimYieldPayload, "userId">;

interface Transaction {
  id: number;
  user_id: string;
  amount: number;
  layer: string;
  nonce: string;
  created_at: string;
}

interface Redemption {
  id: number;
  user_id: string;
  amount: number;
  method: string;
  detail: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

type ApiMessage =
  | { type: "SESSION_START"; payload?: undefined }
  | { type: "CLAIM_YIELD"; payload: ClaimYieldClientPayload }
  | { type: "GET_SURVEY"; payload?: undefined }
  | { type: "GET_AD"; payload?: undefined }
  | {
      type: "AD_EVENT";
      payload: { adId: number; event: "impression" | "click" };
    }
  | { type: "GET_WALLET"; payload?: { limit?: number } }
  | { type: "GET_HEALTH"; payload?: undefined }
  | {
      type: "REDEEM";
      payload: { method: "amazon_voucher" | "upi"; detail: string };
    }
  | { type: "GET_REDEMPTIONS"; payload?: undefined }
  | { type: "GET_CONFIG"; payload?: undefined };

type ApiResponse =
  | { ok: true; data: unknown; status?: number }
  | { ok: false; error: string; status?: number };

class BackendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetchWithTimeout(input, init);
  const data = (await response.json()) as T;

  if (!response.ok) {
    let message = `Backend responded with ${response.status}`;
    if (typeof data === "object" && data !== null) {
      const serverMessage = (data as Record<string, unknown>).message;
      if (typeof serverMessage === "string" && serverMessage) {
        message = serverMessage;
      }
    }
    throw new BackendError(message, response.status);
  }

  return data;
}

export function startSession(userId: string): Promise<unknown> {
  return requestJson(`${API_BASE}/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
}

export function claimYield(payload: ClaimYieldPayload): Promise<unknown> {
  return requestJson(`${API_BASE}/yield`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function getBalance(userId: string): Promise<unknown> {
  return requestJson(`${API_BASE}/balance/${encodeURIComponent(userId)}`);
}

export function getSurveyNext(userId: string): Promise<unknown> {
  return requestJson(`${API_BASE}/survey/next/${encodeURIComponent(userId)}`);
}

export function getAdNext(): Promise<unknown> {
  return requestJson(`${API_BASE}/ad/next`);
}

export function postAdEvent(
  adId: number,
  userId: string,
  event: "impression" | "click",
): Promise<unknown> {
  return requestJson(`${API_BASE}/ad/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ adId, userId, event }),
  });
}

export function getTransactions(
  userId: string,
  limit: number,
): Promise<unknown> {
  const params = new URLSearchParams({ limit: String(limit) });
  return requestJson(
    `${API_BASE}/transactions/${encodeURIComponent(userId)}?${params}`,
  );
}

export function postRedeem(
  userId: string,
  method: "amazon_voucher" | "upi",
  detail: string,
): Promise<unknown> {
  return requestJson(`${API_BASE}/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, method, detail }),
  });
}

export function getRedemptions(userId: string): Promise<unknown> {
  return requestJson(
    `${API_BASE}/redemptions/${encodeURIComponent(userId)}`,
  );
}

function parseConfigResponse(json: unknown): RewardConfig {
  const raw =
    typeof json === "object" && json !== null
      ? ((json as Record<string, unknown>).data ?? json)
      : null;

  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_REWARD_CONFIG;
  }

  const obj = raw as Record<string, unknown>;
  const pick = <K extends keyof RewardConfig>(
    key: K,
    fallback: RewardConfig[K],
  ): RewardConfig[K] => {
    const value = obj[key];
    return typeof value === typeof fallback ? (value as RewardConfig[K]) : fallback;
  };

  return {
    currency: pick("currency", DEFAULT_REWARD_CONFIG.currency),
    symbol: pick("symbol", DEFAULT_REWARD_CONFIG.symbol),
    tier2Amount: pick("tier2Amount", DEFAULT_REWARD_CONFIG.tier2Amount),
    tier3Amount: pick("tier3Amount", DEFAULT_REWARD_CONFIG.tier3Amount),
    minRedemption: pick("minRedemption", DEFAULT_REWARD_CONFIG.minRedemption),
    minWaitSeconds: pick("minWaitSeconds", DEFAULT_REWARD_CONFIG.minWaitSeconds),
    tier3Seconds: pick("tier3Seconds", DEFAULT_REWARD_CONFIG.tier3Seconds),
  };
}

export async function getRewardConfig(): Promise<RewardConfig> {
  if (cachedRewardConfig && Date.now() - configFetchedAt < CONFIG_TTL_MS) {
    return cachedRewardConfig;
  }

  try {
    const json = await requestJson<unknown>(`${API_BASE}/config`);
    const config = parseConfigResponse(json);
    cachedRewardConfig = config;
    configFetchedAt = Date.now();
    return config;
  } catch {
    return DEFAULT_REWARD_CONFIG;
  }
}

export async function getHealth(): Promise<unknown> {
  const response = await fetchWithTimeout(HEALTH_URL);
  const data = await response.json().catch(() => ({ ok: response.ok }));

  if (!response.ok) {
    throw new BackendError(
      `Health endpoint responded with ${response.status}`,
      response.status,
    );
  }

  return data;
}

function parseBalanceResponse(json: unknown): number {
  if (typeof json === "object" && json !== null) {
    const obj = json as Record<string, unknown>;
    if (typeof obj.balance === "number") return obj.balance;
    if (typeof obj.data === "object" && obj.data !== null) {
      const data = obj.data as Record<string, unknown>;
      if (typeof data.balance === "number") return data.balance;
    }
  }

  throw new BackendError("Unexpected balance response shape");
}

function parseTransactionsResponse(json: unknown): Transaction[] {
  if (Array.isArray(json)) return json as Transaction[];
  if (typeof json === "object" && json !== null) {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data as Transaction[];
    if (Array.isArray(obj.transactions)) return obj.transactions as Transaction[];
    if (typeof obj.data === "object" && obj.data !== null) {
      const data = obj.data as Record<string, unknown>;
      if (Array.isArray(data.transactions)) {
        return data.transactions as Transaction[];
      }
    }
  }

  throw new BackendError("Unexpected transactions response shape");
}

function parseRedemptionsResponse(json: unknown): Redemption[] {
  if (typeof json === "object" && json !== null) {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj.redemptions)) return obj.redemptions as Redemption[];
    if (typeof obj.data === "object" && obj.data !== null) {
      const data = obj.data as Record<string, unknown>;
      if (Array.isArray(data.redemptions)) {
        return data.redemptions as Redemption[];
      }
    }
  }

  throw new BackendError("Unexpected redemptions response shape");
}

function storageGetNumber(key: string): Promise<number> {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(Number(result[key] ?? 0));
    });
  });
}

function storageSet(values: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, () => resolve());
  });
}

function storageGetString(key: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      const value = result[key];
      resolve(typeof value === "string" ? value : undefined);
    });
  });
}

export async function ensureUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;

  const stored = await storageGetString(USER_ID_KEY);
  if (stored) {
    cachedUserId = stored;
    return stored;
  }

  const userId = crypto.randomUUID();
  await storageSet({ [USER_ID_KEY]: userId });
  cachedUserId = userId;
  return userId;
}

async function updateStoredEarnings(amount: number): Promise<void> {
  const current = await storageGetNumber(EARNINGS_KEY);
  const next = Math.round((current + amount) * 100) / 100;
  await storageSet({ [EARNINGS_KEY]: next });
}

async function handleMessage(message: ApiMessage): Promise<ApiResponse> {
  const userId = await ensureUserId();

  switch (message.type) {
    case "SESSION_START":
      return { ok: true, data: await startSession(userId) };

    case "CLAIM_YIELD": {
      const data = await claimYield({ ...message.payload, userId });
      await updateStoredEarnings(message.payload.amount);
      return { ok: true, data };
    }

    case "GET_SURVEY":
      return { ok: true, data: await getSurveyNext(userId) };

    case "GET_AD":
      return { ok: true, data: await getAdNext() };

    case "AD_EVENT":
      return {
        ok: true,
        data: await postAdEvent(
          message.payload.adId,
          userId,
          message.payload.event,
        ),
      };

    case "GET_WALLET": {
      const limit = message.payload?.limit ?? 10;
      const [balanceJson, transactionsJson] = await Promise.all([
        getBalance(userId),
        getTransactions(userId, limit),
      ]);

      return {
        ok: true,
        data: {
          balance: parseBalanceResponse(balanceJson),
          transactions: parseTransactionsResponse(transactionsJson),
        },
      };
    }

    case "GET_HEALTH":
      return { ok: true, data: await getHealth() };

    case "REDEEM": {
      const data = await postRedeem(userId, message.payload.method, message.payload.detail);
      await storageSet({ [EARNINGS_KEY]: 0 });
      return { ok: true, data };
    }

    case "GET_REDEMPTIONS":
      return {
        ok: true,
        data: {
          redemptions: parseRedemptionsResponse(await getRedemptions(userId)),
        },
      };

    case "GET_CONFIG":
      return { ok: true, data: await getRewardConfig() };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureUserId();
});

chrome.runtime.onMessage.addListener((message: ApiMessage, _sender, sendResponse) => {
  void handleMessage(message)
    .then(sendResponse)
    .catch((error: unknown) => {
      const backendError = error instanceof BackendError ? error : null;
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown background error",
        status: backendError?.status,
      });
    });

  return true;
});
