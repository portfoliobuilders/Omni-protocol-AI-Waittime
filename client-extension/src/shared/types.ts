export interface PlatformConfig {
  currency: string;
  symbol: string;
  minRedemption: number;
  minWaitSeconds: number;
  userRevenueShareBps: number;
  omniRevenueShareBps: number;
  minimumQualifiedViewMs?: number;
}

export interface PlatformStatus {
  id: string;
  name: string;
  enabled: boolean;
  sponsoredWaitEnabled: boolean;
  hosts: string[];
}

export interface OmniConfig {
  platform: PlatformConfig;
  platforms: PlatformStatus[];
}

export interface WaitSessionData {
  sessionToken: string;
  waitSessionId: string;
  serverNonce: string;
  startedAt: string;
  platform: string;
}

export interface AdCreative {
  headline: string;
  body: string;
  cta_label: string;
  cta_url: string;
  logo_url?: string;
  advertiser_name?: string;
}

export interface WaitAdData {
  adRequestId: string;
  impressionId: string;
  providerKey: string;
  source: "paid_campaign" | "house";
  campaignId: string | null;
  creative: AdCreative;
  requiredViewMs: number;
  cashRevenueShareAllowed: boolean;
  sponsoredLabel: string;
}

export interface QualifyResult {
  impressionId: string;
  house: boolean;
  duplicate: boolean;
  grossMicropaise: number;
  userShareMicropaise: number;
  omniShareMicropaise: number;
  availableMicropaise: number;
}

export interface ExchangeWallet {
  availableMicropaise: number;
  pendingMicropaise: number;
  lifetimeEarnedMicropaise: number;
  lifetimePaidMicropaise: number;
  availableRupeesDisplay: number;
}

export interface RecentEarning {
  id: string;
  entryType: string;
  amountMicropaise: number;
  platform: string | null;
  createdAt: string;
}

export interface Redemption {
  id: string;
  amount_micropaise: number;
  method: string;
  status: string;
  created_at: string;
}

export type WaitState =
  | "IDLE"
  | "GENERATION_DETECTED"
  | "SESSION_STARTING"
  | "AD_REQUESTING"
  | "AD_RENDERED"
  | "VIEWABILITY_PENDING"
  | "QUALIFIED"
  | "SETTLED"
  | "GENERATION_COMPLETE"
  | "CLEANUP"
  | "NO_FILL"
  | "DISMISSED"
  | "SHORT_WAIT"
  | "ERROR"
  | "PLATFORM_DISABLED";
