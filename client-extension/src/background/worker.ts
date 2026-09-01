import type { BackgroundMessage, BackgroundResponse } from "../shared/messages";
import type { ExchangeWallet, OmniConfig, PlatformConfig } from "../shared/types";

// Override at build time: OMNI_API_BASE=http://localhost:3001 npm run build
declare const OMNI_API_BASE: string | undefined;
const API_BASE_URL =
  typeof OMNI_API_BASE !== "undefined" && OMNI_API_BASE
    ? OMNI_API_BASE.replace(/\/$/, "")
    : "http://localhost:3001";
const API_BASE = `${API_BASE_URL}/api/v1`;
const HEALTH_URL = `${API_BASE_URL}/health`;
const REQUEST_TIMEOUT_MS = 8000;
const USER_ID_KEY = "omniUserId";

let cachedUserId: string | null = null;

const DEFAULT_PLATFORM_CONFIG: PlatformConfig = {
  currency: "INR",
  symbol: "₹",
  minRedemption: 100,
  minWaitSeconds: 5,
  userRevenueShareBps: 6000,
  omniRevenueShareBps: 4000,
  minimumQualifiedViewMs: 5000,
};

class BackendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && /aborted/i.test(error.message);
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort("timeout"),
    REQUEST_TIMEOUT_MS,
  );
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.reason === "timeout") {
      throw new BackendError("Backend request timed out", 0);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
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
    } catch (error) {
      lastError = error;
      if (error instanceof BackendError) throw error;
      if (!isAbortError(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Backend request failed");
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

async function handleMessage(message: BackgroundMessage): Promise<BackgroundResponse> {
  const userId = await ensureUserId();

  switch (message.type) {
    case "START_WAIT_SESSION": {
      const data = await requestJson(`${API_BASE}/session/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          platform: message.payload.platform,
        }),
      });
      return { ok: true, data };
    }

    case "REQUEST_WAIT_AD": {
      const data = await requestJson(`${API_BASE}/ad/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          waitSessionId: message.payload.waitSessionId,
        }),
      });
      return { ok: true, data };
    }

    case "QUALIFY_IMPRESSION": {
      const data = await requestJson(`${API_BASE}/impression/qualify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          impressionId: message.payload.impressionId,
          reportedViewMs: message.payload.reportedViewMs,
        }),
      });
      return { ok: true, data };
    }

    case "END_WAIT_SESSION": {
      const waitSessionId = message.payload?.waitSessionId;
      if (!waitSessionId) return { ok: true, data: { ended: true } };
      await requestJson(`${API_BASE}/session/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, waitSessionId }),
      }).catch(() => undefined);
      return { ok: true, data: { ended: true } };
    }

    case "TRACK_AD_CLICK": {
      const impressionId = message.payload?.impressionId;
      if (impressionId) {
        await requestJson(`${API_BASE}/impression/click`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, impressionId }),
        }).catch(() => undefined);
      }
      return { ok: true, data: { tracked: true } };
    }

    case "TRACK_TELEMETRY": {
      const data = await requestJson(`${API_BASE}/telemetry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          host: message.payload.host,
          event: message.payload.event,
        }),
      });
      return { ok: true, data };
    }

    case "REPORT_AD": {
      const data = await requestJson(`${API_BASE}/telemetry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          host: "report",
          event: "error",
        }),
      }).catch(() => ({ success: true }));
      return { ok: true, data };
    }

    case "GET_OMNI_CONFIG": {
      const json = await requestJson<{ success: boolean; data: OmniConfig }>(
        `${API_BASE}/config`,
      );
      return { ok: true, data: json };
    }

    case "GET_EXCHANGE_WALLET": {
      const json = await requestJson<{ success: boolean; data: ExchangeWallet }>(
        `${API_BASE}/exchange/wallet/${encodeURIComponent(userId)}`,
      );
      return { ok: true, data: json };
    }

    case "GET_RECENT_EARNINGS": {
      const limit = message.payload?.limit ?? 10;
      const json = await requestJson(`${API_BASE}/exchange/recent/${encodeURIComponent(userId)}?limit=${limit}`);
      return { ok: true, data: json };
    }

    case "GET_HEALTH": {
      const response = await fetchWithTimeout(HEALTH_URL);
      const data = await response.json().catch(() => ({ ok: response.ok }));
      if (!response.ok) {
        throw new BackendError(`Health ${response.status}`, response.status);
      }
      return { ok: true, data };
    }

    case "REDEEM": {
      const data = await requestJson(`${API_BASE}/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          method: message.payload.method,
          detail: message.payload.detail,
        }),
      });
      return { ok: true, data };
    }

    case "GET_REDEMPTIONS": {
      const data = await requestJson(
        `${API_BASE}/redemptions/${encodeURIComponent(userId)}`,
      );
      return { ok: true, data };
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureUserId();
});

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
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

void DEFAULT_PLATFORM_CONFIG;
