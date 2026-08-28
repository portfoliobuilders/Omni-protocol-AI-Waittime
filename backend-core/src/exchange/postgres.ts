/**
 * Postgres-backed Omni Exchange (authoritative money path).
 * All financial writes go through service-role + settle_impression() RPC.
 * Never call settle_impression from the browser.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  cpmPaiseToCpmMicropaise,
  paiseToMicropaise,
} from "../money/micropaise.js";
import { getExchangeConfig } from "./config.js";
import { getProviderPolicy, isCashPayingProvider } from "./providers.js";
import { getServiceSupabase } from "./supabaseClient.js";

export type CreativePayload = {
  headline: string;
  body: string;
  cta_label: string;
  cta_url: string;
};

export type WaitSessionRow = {
  id: string;
  profile_id: string;
  platform: string;
  server_nonce: string;
  status: string;
  started_at: string;
};

const HOUSE_CREATIVE: CreativePayload = {
  headline: "Omni — Earn from AI wait time",
  body: "Sponsored waits share advertiser revenue. No fixed rewards.",
  cta_label: "Learn more",
  cta_url: "https://portfoliobuilders.in",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Map extension userId (any string) → stable profile UUID for Postgres. */
export function profileIdFromUserId(userId: string): string {
  const trimmed = userId.trim();
  if (!trimmed) throw new Error("userId required");
  if (UUID_RE.test(trimmed)) return trimmed.toLowerCase();

  const hash = createHash("sha256")
    .update(`omni:profile:${trimmed}`)
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function ensureProfileAndInstallation(userId: string): Promise<{
  profileId: string;
  installationId: string;
}> {
  const sb = getServiceSupabase();
  const profileId = profileIdFromUserId(userId);

  const { error: profileErr } = await sb.from("profiles").upsert(
    { id: profileId, role: "user", display_name: null },
    { onConflict: "id" },
  );
  if (profileErr) {
    throw new Error(`profile_upsert_failed: ${profileErr.message}`);
  }

  const { data: existing } = await sb
    .from("installations")
    .select("id")
    .eq("extension_install_id", profileId)
    .maybeSingle();

  if (existing?.id) {
    return { profileId, installationId: existing.id as string };
  }

  const { data: created, error } = await sb
    .from("installations")
    .insert({
      profile_id: profileId,
      extension_install_id: profileId,
      platform_info: "chrome_extension",
    })
    .select("id")
    .single();

  if (error || !created) {
    throw new Error(`installation_create_failed: ${error?.message}`);
  }
  return { profileId, installationId: created.id as string };
}

export async function startWaitSessionPg(
  userId: string,
  platform: string,
): Promise<WaitSessionRow> {
  const sb = getServiceSupabase();
  const { profileId, installationId } = await ensureProfileAndInstallation(userId);
  const serverNonce = randomUUID();

  const { data, error } = await sb
    .from("wait_sessions")
    .insert({
      installation_id: installationId,
      profile_id: profileId,
      platform: platform.slice(0, 64) || "unknown",
      status: "open",
      server_nonce: serverNonce,
      started_at: new Date().toISOString(),
    })
    .select("id, profile_id, platform, server_nonce, status, started_at")
    .single();

  if (error || !data) {
    throw new Error(`wait_session_failed: ${error?.message}`);
  }

  return data as WaitSessionRow;
}

type CampaignRow = {
  id: string;
  advertiser_id: string;
  provider_key: string | null;
  cpm_micropaise: number;
  total_budget_micropaise: number;
  spent_micropaise: number;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
};

async function settledTodayForProfile(
  campaignId: string,
  profileId: string,
): Promise<number> {
  const sb = getServiceSupabase();
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const { data: sessions } = await sb
    .from("wait_sessions")
    .select("id")
    .eq("profile_id", profileId);
  const sessionIds = (sessions ?? []).map((s) => s.id as string);
  if (sessionIds.length === 0) return 0;

  const { count } = await sb
    .from("impressions")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "settled")
    .gte("created_at", dayStart.toISOString())
    .in("wait_session_id", sessionIds);

  return count ?? 0;
}

async function pickPaidCampaign(
  profileId: string,
  preferredProvider?: string,
): Promise<(CampaignRow & { creative: CreativePayload }) | null> {
  const sb = getServiceSupabase();
  const cfg = getExchangeConfig();
  const priority = preferredProvider
    ? [
        preferredProvider,
        ...cfg.selectionPriority.filter((p) => p !== preferredProvider),
      ]
    : cfg.selectionPriority;

  const now = new Date().toISOString();
  const maxPerDay = cfg.maxImpressionsPerCampaignUserDay;

  for (const providerKey of priority) {
    if (providerKey === "house") continue;
    const policy = getProviderPolicy(providerKey);
    if (!policy?.enabled || !policy.cashRevenueShareAllowed) continue;

    const { data: campaigns } = await sb
      .from("campaigns")
      .select(
        "id, advertiser_id, provider_key, cpm_micropaise, total_budget_micropaise, spent_micropaise, status, starts_at, ends_at",
      )
      .eq("status", "active")
      .eq("provider_key", providerKey)
      .order("cpm_micropaise", { ascending: false });

    for (const raw of campaigns ?? []) {
      const c = raw as CampaignRow;
      if (c.cpm_micropaise < cfg.minimumCpmMicropaise) continue;
      const perImp = Math.floor(c.cpm_micropaise / 1000);
      if (perImp <= 0) continue;
      if (c.spent_micropaise + perImp > c.total_budget_micropaise) continue;
      if (c.starts_at && c.starts_at > now) continue;
      if (c.ends_at && c.ends_at < now) continue;

      const todayCount = await settledTodayForProfile(c.id, profileId);
      if (todayCount >= maxPerDay) continue;

      const { data: creative } = await sb
        .from("creatives")
        .select("headline, description, cta_label, cta_url")
        .eq("campaign_id", c.id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();

      if (!creative?.headline || !creative.cta_url) continue;

      return {
        ...c,
        creative: {
          headline: creative.headline as string,
          body: (creative.description as string) ?? "",
          cta_label: (creative.cta_label as string) ?? "Learn more",
          cta_url: creative.cta_url as string,
        },
      };
    }
  }
  return null;
}

export type AdRequestPgResult =
  | {
      ok: true;
      adRequestId: string;
      impressionId: string;
      providerKey: string;
      source: "paid_campaign" | "house";
      campaignId: string | null;
      creative: CreativePayload;
      requiredViewMs: number;
      cashRevenueShareAllowed: boolean;
    }
  | { ok: false; reason: string };

export async function createAdRequestPg(input: {
  waitSessionId: string;
  userId: string;
  preferredProvider?: string;
}): Promise<AdRequestPgResult> {
  const sb = getServiceSupabase();
  const profileId = profileIdFromUserId(input.userId);
  const cfg = getExchangeConfig();

  const { data: session, error: sessErr } = await sb
    .from("wait_sessions")
    .select("id, profile_id, status")
    .eq("id", input.waitSessionId)
    .maybeSingle();

  if (sessErr || !session) return { ok: false, reason: "invalid_session" };
  if (session.profile_id !== profileId) return { ok: false, reason: "user_mismatch" };
  if (session.status !== "open") return { ok: false, reason: "session_closed" };

  const { installationId } = await ensureProfileAndInstallation(input.userId);
  const paid = await pickPaidCampaign(profileId, input.preferredProvider);

  if (!paid) {
    const { data: adReq, error: arErr } = await sb
      .from("ad_requests")
      .insert({
        wait_session_id: input.waitSessionId,
        installation_id: installationId,
        campaign_id: null,
        creative_id: null,
        source: "house",
        provider_key: "house",
      })
      .select("id")
      .single();
    if (arErr || !adReq) return { ok: false, reason: arErr?.message ?? "ad_request_failed" };

    const { data: imp, error: impErr } = await sb
      .from("impressions")
      .insert({
        ad_request_id: adReq.id,
        wait_session_id: input.waitSessionId,
        campaign_id: null,
        creative_id: null,
        source: "house",
        provider_key: "house",
        status: "pending",
        financial_status: "none",
        required_view_ms: cfg.minimumQualifiedViewMs,
        served_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (impErr || !imp) return { ok: false, reason: impErr?.message ?? "impression_failed" };

    return {
      ok: true,
      adRequestId: adReq.id as string,
      impressionId: imp.id as string,
      providerKey: "house",
      source: "house",
      campaignId: null,
      creative: HOUSE_CREATIVE,
      requiredViewMs: cfg.minimumQualifiedViewMs,
      cashRevenueShareAllowed: false,
    };
  }

  let creativeId: string | null = null;
  const { data: existingCreative } = await sb
    .from("creatives")
    .select("id")
    .eq("campaign_id", paid.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  creativeId = (existingCreative?.id as string) ?? null;

  const providerKey = paid.provider_key || "omni_direct";
  const { data: adReq, error: arErr } = await sb
    .from("ad_requests")
    .insert({
      wait_session_id: input.waitSessionId,
      installation_id: installationId,
      campaign_id: paid.id,
      creative_id: creativeId,
      source: "paid_campaign",
      provider_key: providerKey,
    })
    .select("id")
    .single();
  if (arErr || !adReq) return { ok: false, reason: arErr?.message ?? "ad_request_failed" };

  const { data: imp, error: impErr } = await sb
    .from("impressions")
    .insert({
      ad_request_id: adReq.id,
      wait_session_id: input.waitSessionId,
      campaign_id: paid.id,
      creative_id: creativeId,
      source: "paid_campaign",
      provider_key: providerKey,
      status: "pending",
      financial_status: "none",
      required_view_ms: cfg.minimumQualifiedViewMs,
      served_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (impErr || !imp) {
    return { ok: false, reason: impErr?.message ?? "impression_failed" };
  }

  return {
    ok: true,
    adRequestId: adReq.id as string,
    impressionId: imp.id as string,
    providerKey,
    source: "paid_campaign",
    campaignId: paid.id,
    creative: paid.creative,
    requiredViewMs: cfg.minimumQualifiedViewMs,
    cashRevenueShareAllowed: isCashPayingProvider(providerKey),
  };
}

export type SettlePgResult =
  | {
      ok: true;
      duplicate: boolean;
      house: boolean;
      impressionId: string;
      grossMicropaise: number;
      userShareMicropaise: number;
      omniShareMicropaise: number;
      availableMicropaise: number;
    }
  | { ok: false; reason: string };

export async function qualifyAndSettlePg(input: {
  impressionId: string;
  userId: string;
  reportedViewMs: number;
}): Promise<SettlePgResult> {
  const sb = getServiceSupabase();
  const profileId = profileIdFromUserId(input.userId);
  const cfg = getExchangeConfig();
  const reported = Math.max(0, Math.floor(input.reportedViewMs));

  const { data: imp, error: impErr } = await sb
    .from("impressions")
    .select(
      "id, ad_request_id, wait_session_id, campaign_id, source, provider_key, status, financial_status, required_view_ms",
    )
    .eq("id", input.impressionId)
    .maybeSingle();

  if (impErr || !imp) return { ok: false, reason: "impression_not_found" };

  const { data: session } = await sb
    .from("wait_sessions")
    .select("id, profile_id, started_at, status")
    .eq("id", imp.wait_session_id as string)
    .maybeSingle();

  if (!session || session.profile_id !== profileId) {
    return { ok: false, reason: "user_mismatch" };
  }

  if (imp.status === "settled") {
    const { data: rev } = await sb
      .from("revenue_events")
      .select("gross_micropaise, user_share_micropaise, omni_share_micropaise")
      .eq("impression_id", imp.id)
      .maybeSingle();
    const wallet = await getWalletPg(profileId);
    return {
      ok: true,
      duplicate: true,
      house: imp.source === "house" || Number(rev?.gross_micropaise ?? 0) === 0,
      impressionId: imp.id as string,
      grossMicropaise: Number(rev?.gross_micropaise ?? 0),
      userShareMicropaise: Number(rev?.user_share_micropaise ?? 0),
      omniShareMicropaise: Number(rev?.omni_share_micropaise ?? 0),
      availableMicropaise: wallet.availableMicropaise,
    };
  }

  if (reported < Number(imp.required_view_ms ?? cfg.minimumQualifiedViewMs)) {
    return { ok: false, reason: "view_below_threshold" };
  }

  const startedAt = session.started_at
    ? Date.parse(session.started_at as string)
    : NaN;
  if (
    Number.isFinite(startedAt) &&
    Date.now() - startedAt < cfg.minimumQualifiedViewMs
  ) {
    return { ok: false, reason: "wait_below_threshold" };
  }

  await sb
    .from("impressions")
    .update({
      reported_view_ms: reported,
      status: "qualified",
      qualified_at: new Date().toISOString(),
    })
    .eq("id", imp.id);

  // Authoritative settlement — Postgres function only (service role).
  const { data: rpcResult, error: rpcErr } = await sb.rpc("settle_impression", {
    p_impression_id: imp.id,
  });

  if (rpcErr) {
    return { ok: false, reason: rpcErr.message };
  }

  const result = rpcResult as {
    ok?: boolean;
    duplicate?: boolean;
    house?: boolean;
    impression_id?: string;
    gross_micropaise?: number;
    user_share_micropaise?: number;
    omni_share_micropaise?: number;
  };

  if (!result?.ok) {
    return { ok: false, reason: "settlement_failed" };
  }

  const wallet = await getWalletPg(profileId);
  return {
    ok: true,
    duplicate: Boolean(result.duplicate),
    house: Boolean(result.house) || Number(result.gross_micropaise ?? 0) === 0,
    impressionId: (result.impression_id as string) ?? (imp.id as string),
    grossMicropaise: Number(result.gross_micropaise ?? 0),
    userShareMicropaise: Number(result.user_share_micropaise ?? 0),
    omniShareMicropaise: Number(result.omni_share_micropaise ?? 0),
    availableMicropaise: wallet.availableMicropaise,
  };
}

export async function getWalletPg(profileIdOrUserId: string): Promise<{
  availableMicropaise: number;
  pendingMicropaise: number;
  lifetimeEarnedMicropaise: number;
  lifetimePaidMicropaise: number;
  availableRupeesDisplay: number;
}> {
  const sb = getServiceSupabase();
  const id = profileIdFromUserId(profileIdOrUserId);

  const { data: existing } = await sb
    .from("wallets")
    .select(
      "available_micropaise, pending_micropaise, lifetime_earned_micropaise, lifetime_paid_micropaise",
    )
    .eq("profile_id", id)
    .maybeSingle();

  if (!existing) {
    await sb.from("wallets").insert({
      profile_id: id,
      cached_balance_micropaise: 0,
      available_micropaise: 0,
      pending_micropaise: 0,
    });
  }

  const { data } = await sb
    .from("wallets")
    .select(
      "available_micropaise, pending_micropaise, lifetime_earned_micropaise, lifetime_paid_micropaise",
    )
    .eq("profile_id", id)
    .single();

  const available = Number(data?.available_micropaise ?? 0);
  return {
    availableMicropaise: available,
    pendingMicropaise: Number(data?.pending_micropaise ?? 0),
    lifetimeEarnedMicropaise: Number(data?.lifetime_earned_micropaise ?? 0),
    lifetimePaidMicropaise: Number(data?.lifetime_paid_micropaise ?? 0),
    availableRupeesDisplay: available / 100_000,
  };
}

/** Create campaign stored only in micropaise (preferred Exchange API). */
export async function createFundedCampaignPg(input: {
  advertiserEmail: string;
  advertiserName?: string;
  name: string;
  providerKey: "omni_direct" | "seed_sponsor";
  /** CPM as micropaise per 1000 impressions (₹10 CPM = 1_000_000). */
  cpmMicropaise: number;
  totalBudgetMicropaise: number;
  headline: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  status?: "draft" | "active" | "pending_review";
}): Promise<{ campaignId: string; advertiserId: string }> {
  const sb = getServiceSupabase();
  if (
    !Number.isSafeInteger(input.cpmMicropaise) ||
    input.cpmMicropaise <= 0 ||
    !Number.isSafeInteger(input.totalBudgetMicropaise) ||
    input.totalBudgetMicropaise <= 0
  ) {
    throw new Error("cpm/budget must be positive safe integers in micropaise");
  }

  const email = input.advertiserEmail.trim().toLowerCase();
  let advertiserId: string | null = null;

  const { data: existingProfile } = await sb
    .from("profiles")
    .select("id")
    .eq("display_name", email)
    .eq("role", "advertiser")
    .maybeSingle();

  if (existingProfile?.id) {
    const { data: adv } = await sb
      .from("advertisers")
      .select("id")
      .eq("profile_id", existingProfile.id)
      .maybeSingle();
    advertiserId = (adv?.id as string) ?? null;
  }

  if (!advertiserId) {
    const advertiserProfileId = randomUUID();
    const { error: pErr } = await sb.from("profiles").insert({
      id: advertiserProfileId,
      role: "advertiser",
      display_name: email,
    });
    if (pErr) throw new Error(pErr.message);

    const { data: adv, error: advErr } = await sb
      .from("advertisers")
      .insert({
        profile_id: advertiserProfileId,
        name: input.advertiserName ?? email,
        status: "active",
      })
      .select("id")
      .single();
    if (advErr || !adv) throw new Error(advErr?.message ?? "advertiser_failed");
    advertiserId = adv.id as string;

    await sb.from("advertiser_wallets").insert({
      advertiser_id: advertiserId,
      cached_balance_micropaise: 0,
    });
  }

  // Fund wallet to cover budget (idempotent per campaign create call)
  const fundKey = `funding:${advertiserId}:${input.totalBudgetMicropaise}:${randomUUID()}`;
  const { data: wallet } = await sb
    .from("advertiser_wallets")
    .select("cached_balance_micropaise")
    .eq("advertiser_id", advertiserId)
    .single();
  const bal = Number(wallet?.cached_balance_micropaise ?? 0);
  const next = bal + input.totalBudgetMicropaise;
  await sb.from("advertiser_ledger_entries").insert({
    advertiser_id: advertiserId,
    entry_type: "funding_credit",
    amount_micropaise: input.totalBudgetMicropaise,
    balance_after_micropaise: next,
    reference_type: "pilot_funding",
    idempotency_key: fundKey,
  });
  await sb
    .from("advertiser_wallets")
    .update({ cached_balance_micropaise: next, updated_at: new Date().toISOString() })
    .eq("advertiser_id", advertiserId);

  const status = input.status ?? "active";
  const { data: camp, error: campErr } = await sb
    .from("campaigns")
    .insert({
      advertiser_id: advertiserId,
      name: input.name,
      status,
      provider_key: input.providerKey,
      cpm_micropaise: input.cpmMicropaise,
      total_budget_micropaise: input.totalBudgetMicropaise,
      spent_micropaise: 0,
      review_status: status === "active" ? "approved" : "pending",
      reviewed_at: status === "active" ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  if (campErr || !camp) throw new Error(campErr?.message ?? "campaign_failed");

  await sb.from("creatives").insert({
    campaign_id: camp.id,
    headline: input.headline,
    description: input.body,
    cta_label: input.ctaLabel,
    cta_url: input.ctaUrl,
    status: "active",
  });

  return { campaignId: camp.id as string, advertiserId };
}

/** Legacy portal fields (paise) → micropaise storage only. */
export async function createCampaignFromPaiseInput(input: {
  advertiserEmail: string;
  headline: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  cpmPaise: number;
  totalBudgetPaise: number;
  providerKey?: "omni_direct" | "seed_sponsor";
}): Promise<{ campaignId: string; advertiserId: string; cpmMicropaise: number; totalBudgetMicropaise: number }> {
  const cpmMicropaise = cpmPaiseToCpmMicropaise(input.cpmPaise);
  const totalBudgetMicropaise = paiseToMicropaise(input.totalBudgetPaise);
  const created = await createFundedCampaignPg({
    advertiserEmail: input.advertiserEmail,
    name: input.headline.slice(0, 80),
    providerKey: input.providerKey ?? "omni_direct",
    cpmMicropaise,
    totalBudgetMicropaise,
    headline: input.headline,
    body: input.body,
    ctaLabel: input.ctaLabel,
    ctaUrl: input.ctaUrl,
    status: "pending_review",
  });
  return { ...created, cpmMicropaise, totalBudgetMicropaise };
}

export async function confirmAdvertiserFundingPg(input: {
  advertiserEmail: string;
  amountMicropaise: number;
  idempotencyKey: string;
}): Promise<
  | { ok: true; balanceMicropaise: number; duplicate?: boolean }
  | { ok: false; reason: string }
> {
  const sb = getServiceSupabase();
  const email = input.advertiserEmail.trim().toLowerCase();
  if (!Number.isSafeInteger(input.amountMicropaise) || input.amountMicropaise <= 0) {
    return { ok: false, reason: "invalid_amount" };
  }

  const { data: profile } = await sb
    .from("profiles")
    .select("id")
    .eq("display_name", email)
    .eq("role", "advertiser")
    .maybeSingle();
  if (!profile?.id) return { ok: false, reason: "advertiser_not_found" };

  const { data: adv } = await sb
    .from("advertisers")
    .select("id")
    .eq("profile_id", profile.id)
    .maybeSingle();
  if (!adv?.id) return { ok: false, reason: "advertiser_not_found" };

  const { data: existing } = await sb
    .from("advertiser_ledger_entries")
    .select("id, balance_after_micropaise")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (existing) {
    const { data: w } = await sb
      .from("advertiser_wallets")
      .select("cached_balance_micropaise")
      .eq("advertiser_id", adv.id)
      .single();
    return {
      ok: true,
      duplicate: true,
      balanceMicropaise: Number(w?.cached_balance_micropaise ?? 0),
    };
  }

  const { data: wallet } = await sb
    .from("advertiser_wallets")
    .select("cached_balance_micropaise")
    .eq("advertiser_id", adv.id)
    .single();
  const bal = Number(wallet?.cached_balance_micropaise ?? 0);
  const next = bal + input.amountMicropaise;

  const { error: ledErr } = await sb.from("advertiser_ledger_entries").insert({
    advertiser_id: adv.id,
    entry_type: "funding_credit",
    amount_micropaise: input.amountMicropaise,
    balance_after_micropaise: next,
    reference_type: "admin_funding",
    idempotency_key: input.idempotencyKey,
  });
  if (ledErr) {
    if (ledErr.message.includes("duplicate") || ledErr.code === "23505") {
      const { data: w } = await sb
        .from("advertiser_wallets")
        .select("cached_balance_micropaise")
        .eq("advertiser_id", adv.id)
        .single();
      return {
        ok: true,
        duplicate: true,
        balanceMicropaise: Number(w?.cached_balance_micropaise ?? 0),
      };
    }
    return { ok: false, reason: ledErr.message };
  }

  await sb
    .from("advertiser_wallets")
    .update({
      cached_balance_micropaise: next,
      updated_at: new Date().toISOString(),
    })
    .eq("advertiser_id", adv.id);

  return { ok: true, balanceMicropaise: next };
}

export async function setCampaignProviderPg(
  campaignId: string,
  providerKey: string,
): Promise<boolean> {
  const policy = getProviderPolicy(providerKey);
  if (!policy) return false;
  const sb = getServiceSupabase();
  const { data, error } = await sb
    .from("campaigns")
    .update({ provider_key: providerKey })
    .eq("id", campaignId)
    .select("id")
    .maybeSingle();
  return !error && Boolean(data?.id);
}

export async function recordPlatformEventPg(
  userId: string,
  host: string,
  event: string,
): Promise<{ ok: true } | { ok: false; reason: "invalid" }> {
  const allowed = [
    "detected",
    "shown",
    "rendered",
    "qualified",
    "settled",
    "wait_ended",
    "error",
  ];
  if (!allowed.includes(event)) return { ok: false, reason: "invalid" };
  const sb = getServiceSupabase();
  const { profileId, installationId } = await ensureProfileAndInstallation(userId);
  await sb.from("platform_events").insert({
    host: host.trim().toLowerCase().slice(0, 128),
    event,
    installation_id: installationId,
    profile_id: profileId,
  });
  return { ok: true };
}

export async function getPlatformHealthPg(): Promise<
  Array<{ host: string; events: number; last_at: string | null }>
> {
  const sb = getServiceSupabase();
  const { data } = await sb
    .from("platform_events")
    .select("host, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  const map = new Map<string, { events: number; last_at: string | null }>();
  for (const row of data ?? []) {
    const host = row.host as string;
    const cur = map.get(host) ?? { events: 0, last_at: null };
    cur.events += 1;
    if (!cur.last_at) cur.last_at = row.created_at as string;
    map.set(host, cur);
  }
  return [...map.entries()].map(([host, v]) => ({ host, ...v }));
}

export async function requestRedemptionPg(input: {
  userId: string;
  amountMicropaise: number;
  method: string;
  detail?: string;
}): Promise<
  | { ok: true; redemptionId: string; availableMicropaise: number }
  | { ok: false; reason: string }
> {
  const sb = getServiceSupabase();
  const profileId = profileIdFromUserId(input.userId);
  await ensureProfileAndInstallation(input.userId);

  const { data, error } = await sb.rpc("request_redemption", {
    p_profile_id: profileId,
    p_amount_micropaise: input.amountMicropaise,
    p_method: input.method,
    p_detail: input.detail ?? null,
  });

  if (error) {
    return { ok: false, reason: error.message };
  }
  const result = data as {
    ok?: boolean;
    redemption_id?: string;
    available_micropaise?: number;
  };
  if (!result?.ok || !result.redemption_id) {
    return { ok: false, reason: "redemption_failed" };
  }
  return {
    ok: true,
    redemptionId: result.redemption_id,
    availableMicropaise: Number(result.available_micropaise ?? 0),
  };
}

export async function listUserRedemptionsPg(userId: string): Promise<
  Array<{
    id: string;
    amount_micropaise: number;
    method: string;
    status: string;
    created_at: string;
  }>
> {
  const sb = getServiceSupabase();
  const profileId = profileIdFromUserId(userId);
  const { data } = await sb
    .from("redemptions")
    .select("id, amount_micropaise, method, status, created_at")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: false })
    .limit(50);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    amount_micropaise: Number(r.amount_micropaise),
    method: r.method as string,
    status: r.status as string,
    created_at: r.created_at as string,
  }));
}

export async function getRecentEarningsPg(
  userId: string,
  limit = 10,
): Promise<
  Array<{
    id: string;
    entryType: string;
    amountMicropaise: number;
    platform: string | null;
    createdAt: string;
  }>
> {
  const sb = getServiceSupabase();
  const profileId = profileIdFromUserId(userId);
  const { data: wallet } = await sb
    .from("wallets")
    .select("id")
    .eq("profile_id", profileId)
    .maybeSingle();
  if (!wallet?.id) return [];

  const { data } = await sb
    .from("ledger_entries")
    .select("id, entry_type, amount_micropaise, created_at")
    .eq("wallet_id", wallet.id)
    .gt("amount_micropaise", 0)
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, 50));

  return (data ?? []).map((row) => ({
    id: row.id as string,
    entryType: row.entry_type as string,
    amountMicropaise: Number(row.amount_micropaise),
    platform: null,
    createdAt: row.created_at as string,
  }));
}

export async function reviewCampaignPg(
  campaignId: string,
  decision: "approve" | "reject",
): Promise<
  | { ok: true; status: string }
  | { ok: false; reason: "not_found" | "not_pending" }
> {
  const sb = getServiceSupabase();
  const { data: camp } = await sb
    .from("campaigns")
    .select("id, status")
    .eq("id", campaignId)
    .maybeSingle();
  if (!camp?.id) return { ok: false, reason: "not_found" };
  if (camp.status !== "pending_review" && camp.status !== "draft") {
    return { ok: false, reason: "not_pending" };
  }
  const status = decision === "approve" ? "active" : "rejected";
  const { error } = await sb
    .from("campaigns")
    .update({
      status,
      review_status: decision === "approve" ? "approved" : "rejected",
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", campaignId);
  if (error) return { ok: false, reason: "not_found" };
  return { ok: true, status };
}

export async function listCampaignsAdminPg(): Promise<
  Array<Record<string, unknown>>
> {
  const sb = getServiceSupabase();
  const { data } = await sb
    .from("campaigns")
    .select(
      "id, name, status, provider_key, cpm_micropaise, total_budget_micropaise, spent_micropaise, review_status, created_at, advertiser_id",
    )
    .order("created_at", { ascending: false })
    .limit(200);
  return (data ?? []) as Array<Record<string, unknown>>;
}

/** Backdate wait session started_at (tests only). */
export async function backdateWaitSessionPg(
  waitSessionId: string,
  startedAtIso: string,
): Promise<void> {
  const sb = getServiceSupabase();
  await sb
    .from("wait_sessions")
    .update({ started_at: startedAtIso })
    .eq("id", waitSessionId);
}
