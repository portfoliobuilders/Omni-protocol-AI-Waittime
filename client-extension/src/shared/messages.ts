import type {
  AdCreative,
  ExchangeWallet,
  OmniConfig,
  QualifyResult,
  RecentEarning,
  Redemption,
  WaitAdData,
  WaitSessionData,
} from "./types";

export type BackgroundMessage =
  | { type: "START_WAIT_SESSION"; payload: { platform: string } }
  | { type: "REQUEST_WAIT_AD"; payload: { waitSessionId: string } }
  | {
      type: "QUALIFY_IMPRESSION";
      payload: { impressionId: string; reportedViewMs: number };
    }
  | { type: "END_WAIT_SESSION"; payload?: { waitSessionId?: string } }
  | {
      type: "TRACK_AD_CLICK";
      payload: { impressionId: string; ctaUrl: string };
    }
  | {
      type: "TRACK_TELEMETRY";
      payload: { host: string; event: string };
    }
  | { type: "GET_OMNI_CONFIG"; payload?: undefined }
  | { type: "GET_EXCHANGE_WALLET"; payload?: undefined }
  | { type: "GET_RECENT_EARNINGS"; payload?: { limit?: number } }
  | { type: "GET_HEALTH"; payload?: undefined }
  | {
      type: "REDEEM";
      payload: { method: "amazon_voucher" | "upi"; detail: string };
    }
  | { type: "GET_REDEMPTIONS"; payload?: undefined }
  | {
      type: "REPORT_AD";
      payload: { impressionId: string; reason?: string };
    };

export type BackgroundResponse =
  | { ok: true; data: unknown; status?: number }
  | { ok: false; error: string; status?: number };

export type SessionStartResponse = {
  success: boolean;
  data?: WaitSessionData;
};

export type AdRequestResponse = {
  success: boolean;
  data?: WaitAdData;
  message?: string;
};

export type QualifyResponse = {
  success: boolean;
  duplicate?: boolean;
  data?: QualifyResult;
  message?: string;
};

export type WalletResponse = {
  success: boolean;
  data?: ExchangeWallet;
};

export type RecentEarningsResponse = {
  success: boolean;
  data?: { earnings: RecentEarning[] };
};

export type ConfigResponse = {
  success: boolean;
  data?: OmniConfig & Record<string, unknown>;
};

export type RedemptionsResponse = {
  success: boolean;
  data?: { redemptions: Redemption[] };
};

export function isHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseAdRequest(data: unknown): WaitAdData | null {
  if (typeof data !== "object" || data === null) return null;
  const root = data as Record<string, unknown>;
  const payload = (root.data ?? root) as Record<string, unknown>;
  const creative = payload.creative as AdCreative | undefined;
  if (
    typeof payload.impressionId !== "string" ||
    !creative?.headline ||
    !creative?.cta_url
  ) {
    return null;
  }
  const advertiserName =
    typeof creative.advertiser_name === "string"
      ? creative.advertiser_name.trim()
      : "";
  return {
    adRequestId: String(payload.adRequestId ?? ""),
    impressionId: payload.impressionId,
    providerKey: String(payload.providerKey ?? "house"),
    source: payload.source === "paid_campaign" ? "paid_campaign" : "house",
    campaignId:
      typeof payload.campaignId === "string" ? payload.campaignId : null,
    creative: {
      headline: String(creative.headline),
      body: String(creative.body ?? ""),
      cta_label: String(creative.cta_label ?? "Learn more"),
      cta_url: String(creative.cta_url),
      logo_url:
        typeof creative.logo_url === "string" ? creative.logo_url : undefined,
      advertiser_name: advertiserName || undefined,
    },
    requiredViewMs: Number(payload.requiredViewMs ?? 5000),
    cashRevenueShareAllowed: Boolean(payload.cashRevenueShareAllowed),
    sponsoredLabel: String(payload.sponsoredLabel ?? "Sponsored"),
  };
}
