/**
 * Omni Exchange — Demand Provider types & policy.
 * External networks are placeholders only (Phase 2 does not integrate them).
 */

export type ProviderType =
  | "omni_direct"
  | "seed_sponsor"
  | "house"
  | "external_network"
  | "admob_mobile"
  | "applovin_mobile"
  | "meta_audience_network_mobile"
  | "future_programmatic_provider";

export type SettlementMode =
  | "instant"
  | "pending"
  | "external_reconciliation";

export type DemandProviderKey =
  | "omni_direct"
  | "seed_sponsor"
  | "house"
  | "external_network"
  | "admob_mobile"
  | "applovin_mobile"
  | "meta_audience_network_mobile";

export interface DemandProviderPolicy {
  providerKey: DemandProviderKey;
  providerType: ProviderType;
  enabled: boolean;
  cashRevenueShareAllowed: boolean;
  settlementMode: SettlementMode;
  supportsBrowserExtension: boolean;
  supportsWeb: boolean;
  supportsMobile: boolean;
  supportsIde: boolean;
  supportsAgent: boolean;
  supportsPublisherSdk: boolean;
  clawbackSupported: boolean;
  policyVersion: number;
}

export const BUILTIN_PROVIDERS: readonly DemandProviderPolicy[] = [
  {
    providerKey: "omni_direct",
    providerType: "omni_direct",
    enabled: true,
    cashRevenueShareAllowed: true,
    settlementMode: "instant",
    supportsBrowserExtension: true,
    supportsWeb: true,
    supportsMobile: false,
    supportsIde: false,
    supportsAgent: false,
    supportsPublisherSdk: false,
    clawbackSupported: false,
    policyVersion: 1,
  },
  {
    providerKey: "seed_sponsor",
    providerType: "seed_sponsor",
    enabled: true,
    cashRevenueShareAllowed: true,
    settlementMode: "instant",
    supportsBrowserExtension: true,
    supportsWeb: true,
    supportsMobile: false,
    supportsIde: false,
    supportsAgent: false,
    supportsPublisherSdk: false,
    clawbackSupported: false,
    policyVersion: 1,
  },
  {
    providerKey: "house",
    providerType: "house",
    enabled: true,
    cashRevenueShareAllowed: false,
    settlementMode: "instant",
    supportsBrowserExtension: true,
    supportsWeb: true,
    supportsMobile: false,
    supportsIde: false,
    supportsAgent: false,
    supportsPublisherSdk: false,
    clawbackSupported: false,
    policyVersion: 1,
  },
  {
    providerKey: "external_network",
    providerType: "external_network",
    enabled: false,
    cashRevenueShareAllowed: false,
    settlementMode: "external_reconciliation",
    supportsBrowserExtension: true,
    supportsWeb: true,
    supportsMobile: true,
    supportsIde: false,
    supportsAgent: false,
    supportsPublisherSdk: true,
    clawbackSupported: true,
    policyVersion: 1,
  },
  {
    providerKey: "admob_mobile",
    providerType: "admob_mobile",
    enabled: false,
    cashRevenueShareAllowed: false,
    settlementMode: "external_reconciliation",
    supportsBrowserExtension: false,
    supportsWeb: false,
    supportsMobile: true,
    supportsIde: false,
    supportsAgent: false,
    supportsPublisherSdk: false,
    clawbackSupported: true,
    policyVersion: 1,
  },
  {
    providerKey: "applovin_mobile",
    providerType: "applovin_mobile",
    enabled: false,
    cashRevenueShareAllowed: false,
    settlementMode: "external_reconciliation",
    supportsBrowserExtension: false,
    supportsWeb: false,
    supportsMobile: true,
    supportsIde: false,
    supportsAgent: false,
    supportsPublisherSdk: false,
    clawbackSupported: true,
    policyVersion: 1,
  },
  {
    providerKey: "meta_audience_network_mobile",
    providerType: "meta_audience_network_mobile",
    enabled: false,
    cashRevenueShareAllowed: false,
    settlementMode: "external_reconciliation",
    supportsBrowserExtension: false,
    supportsWeb: false,
    supportsMobile: true,
    supportsIde: false,
    supportsAgent: false,
    supportsPublisherSdk: false,
    clawbackSupported: true,
    policyVersion: 1,
  },
] as const;

export function getProviderPolicy(
  key: string,
): DemandProviderPolicy | undefined {
  return BUILTIN_PROVIDERS.find((p) => p.providerKey === key);
}

export function isCashPayingProvider(key: string): boolean {
  const p = getProviderPolicy(key);
  return Boolean(p?.enabled && p.cashRevenueShareAllowed);
}
