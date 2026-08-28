/**
 * Server-authoritative Exchange configuration.
 * Defaults match migration 20260827130000 — never trust the client.
 */
import {
  DEFAULT_OMNI_REVENUE_SHARE_BPS,
  DEFAULT_USER_REVENUE_SHARE_BPS,
} from "../money/micropaise.js";

export interface ExchangeConfig {
  userRevenueShareBps: number;
  omniRevenueShareBps: number;
  minimumQualifiedViewMs: number;
  /** Minimum campaign CPM in micropaise per 1000 impressions (₹10 = 1_000_000). */
  minimumCpmMicropaise: number;
  maxImpressionsPerCampaignUserDay: number;
  minimumRepeatIntervalSeconds: number;
  selectionPriority: string[];
}

export const EXCHANGE_CONFIG_DEFAULTS: ExchangeConfig = {
  userRevenueShareBps: DEFAULT_USER_REVENUE_SHARE_BPS,
  omniRevenueShareBps: DEFAULT_OMNI_REVENUE_SHARE_BPS,
  minimumQualifiedViewMs: 5000,
  minimumCpmMicropaise: 1_000_000,
  maxImpressionsPerCampaignUserDay: 20,
  minimumRepeatIntervalSeconds: 30,
  selectionPriority: ["omni_direct", "seed_sponsor", "house"],
};

let cached: ExchangeConfig | null = null;

export function getExchangeConfig(): ExchangeConfig {
  if (cached) return cached;
  // Future: load overrides from app_config table / env. Defaults are production-safe.
  cached = { ...EXCHANGE_CONFIG_DEFAULTS };
  return cached;
}

/** Test helper — reset cache between tests. */
export function resetExchangeConfigCache(): void {
  cached = null;
}

export function setExchangeConfigForTests(partial: Partial<ExchangeConfig>): void {
  cached = { ...EXCHANGE_CONFIG_DEFAULTS, ...partial };
}
