/**
 * Phase 4 Omni Ads: advertiser A/B RLS, campaign lifecycle, funding ledger,
 * surface targeting, creative validation, analytics. Never mutates
 * "ChatGPT live paid inventory".
 */
process.env.OMNI_TEST_MODE = "true";

import assert from "node:assert/strict";
import crypto from "node:crypto";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function main(): Promise<void> {
  const { assertPostgresExchangeReady, getServiceSupabase, getAnonSupabase, getSupabaseUrl } =
    await import("../src/exchange/supabaseClient.ts");
  assertPostgresExchangeReady();
  const {
    MANUAL_CHATGPT_CAMPAIGN_NAME,
    isOmniTestCampaignName,
  } = await import("../src/exchange/testIsolation.ts");
  const {
    createAdRequestPg,
    startWaitSessionPg,
    createFundedCampaignPg,
    setPaidInventoryEnabledPg,
  } = await import("../src/exchange/postgres.ts");
  const service = await import("../src/ads/service.ts");
  const { AdsValidationError, isHttpsUrl } = await import("../src/ads/validate.ts");
  const { AdsAuthError, loadOrgContext } = await import("../src/ads/auth.ts");

  assert.equal(isOmniTestCampaignName(MANUAL_CHATGPT_CAMPAIGN_NAME), false);
  assert.equal(isHttpsUrl("javascript:alert(1)"), false);
  assert.equal(isHttpsUrl("https://example.com"), true);

  const sb = getServiceSupabase();
  const { data: control } = await sb
    .from("campaigns")
    .select("id, status, spent_micropaise, cpm_micropaise, total_budget_micropaise, provider_key, review_status")
    .eq("name", MANUAL_CHATGPT_CAMPAIGN_NAME)
    .maybeSingle();
  const controlBefore = control
    ? {
        status: control.status,
        spent: Number(control.spent_micropaise),
        cpm: Number(control.cpm_micropaise),
        budget: Number(control.total_budget_micropaise),
        provider: control.provider_key,
        review: control.review_status,
      }
    : null;

  const stamp = Date.now();
  const runId = crypto.randomUUID().slice(0, 8);
  const password = `OmniAds_${runId}_Pass1`;

  async function createAuthed(email: string, opts?: { admin?: boolean }) {
    const { data: created, error } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !created.user) throw new Error(error?.message ?? "createUser failed");
    if (opts?.admin) {
      await sb.from("profiles").update({ role: "admin" }).eq("id", created.user.id);
    }
    const anon = createClient(getSupabaseUrl(), process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: session, error: signErr } = await anon.auth.signInWithPassword({ email, password });
    if (signErr || !session.session?.access_token) {
      throw new Error(signErr?.message ?? "signIn failed");
    }
    return {
      userId: created.user.id,
      token: session.session.access_token,
      email,
    };
  }

  const userA = await createAuthed(`__omni_test_ads_a_${runId}@example.com`);
  const userB = await createAuthed(`__omni_test_ads_b_${runId}@example.com`);
  const admin = await createAuthed(`__omni_test_ads_admin_${runId}@example.com`, { admin: true });

  const actorA = { profileId: userA.userId, email: userA.email, platformRole: "user" as const, isAdmin: false };
  const actorB = { profileId: userB.userId, email: userB.email, platformRole: "user" as const, isAdmin: false };
  const actorAdmin = { profileId: admin.userId, email: admin.email, platformRole: "admin" as const, isAdmin: true };

  const orgA = await service.onboardAdvertiser(actorA, `A Co ${runId}`);
  const orgB = await service.onboardAdvertiser(actorB, `B Co ${runId}`);
  assert.notEqual(orgA.advertiserId, orgB.advertiserId);

  await assert.rejects(
    () => loadOrgContext(actorA, orgB.advertiserId),
    (err: unknown) => err instanceof AdsAuthError && err.status === 403,
  );

  const anon = getAnonSupabase();
  const { data: leakCampaigns } = await anon.from("campaigns").select("id, name").eq("advertiser_id", orgB.advertiserId);
  assert.equal((leakCampaigns ?? []).length, 0, "anon cannot read advertiser B campaigns");

  const userAClient = createClient(getSupabaseUrl(), process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "", {
    global: { headers: { Authorization: `Bearer ${userA.token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: aSeesB } = await userAClient.from("advertisers").select("id").eq("id", orgB.advertiserId);
  assert.equal((aSeesB ?? []).length, 0, "A cannot read B advertiser");
  const { error: walletHack } = await userAClient
    .from("advertiser_wallets")
    .update({ cached_balance_micropaise: 99_000_000 })
    .eq("advertiser_id", orgA.advertiserId);
  void walletHack;
  const { data: walletAfterHack } = await sb
    .from("advertiser_wallets")
    .select("cached_balance_micropaise")
    .eq("advertiser_id", orgA.advertiserId)
    .single();
  assert.equal(Number(walletAfterHack?.cached_balance_micropaise), 0, "advertiser cannot credit own wallet via client");
  const { error: approveHack } = await userAClient
    .from("campaigns")
    .update({ status: "active", review_status: "approved" })
    .eq("advertiser_id", orgA.advertiserId);
  void approveHack;
  const { count: approvedCount } = await sb
    .from("campaigns")
    .select("id", { count: "exact", head: true })
    .eq("advertiser_id", orgA.advertiserId)
    .eq("status", "active");
  assert.equal(approvedCount ?? 0, 0, "advertiser cannot self-approve via client");
  const { error: settleHack } = await userAClient.rpc("settle_impression", {
    p_impression_id: crypto.randomUUID(),
  });
  assert.ok(settleHack, "advertiser cannot settle impressions");

  const fundA = await service.requestFunding(actorA, orgA, 5_000_000, "pilot");
  await assert.rejects(
    () => service.resolveFunding(actorA, fundA.id as string, "confirmed"),
    (err: unknown) => err instanceof AdsAuthError,
  );
  const confirmed = await service.resolveFunding(actorAdmin, fundA.id as string, "confirmed");
  assert.equal(confirmed.status, "confirmed");
  const billingA = await service.getBilling(orgA);
  assert.equal(billingA.availableMicropaise, 5_000_000);
  assert.equal(billingA.lifetimeFundedMicropaise, 5_000_000);

  await assert.rejects(
    () =>
      service.createCampaign(actorA, orgA, {
        name: `bad url ${runId}`,
        advertiserName: "Acme",
        headline: "Hi",
        body: "Body",
        ctaLabel: "Go",
        ctaUrl: "javascript:alert(1)",
        cpmMicropaise: 1_000_000,
        budgetMicropaise: 50_000,
        targetingMode: "all_enabled",
      }),
    (err: unknown) => err instanceof AdsValidationError,
  );

  const draft = await service.createCampaign(actorA, orgA, {
    name: `__omni_test_${runId}_draft`,
    destinationUrl: "https://example.com/a",
    advertiserName: "Acme A",
    headline: "Verified attention",
    body: "Buy AI wait time",
    ctaLabel: "Learn more",
    ctaUrl: "https://example.com/a",
    cpmMicropaise: 1_000_000,
    budgetMicropaise: 50_000,
    targetingMode: "specific",
    surfaces: ["chatgpt.com"],
  });
  assert.equal(draft.status, "draft");
  const saved = await service.updateCampaign(actorA, orgA, draft.id, {
    headline: "Verified attention v2",
  });
  assert.equal(saved.creative?.headline, "Verified attention v2");

  const logo = await service.uploadLogo(actorA, orgA, draft.id, PNG_1X1, "image/png");
  assert.ok(logo.logoUrl.includes("campaign-creatives"));

  await assert.rejects(
    () => service.createCampaign(actorA, orgA, {
      name: `claude spend ${runId}`,
      advertiserName: "Acme",
      headline: "Nope",
      body: "x",
      ctaLabel: "Go",
      ctaUrl: "https://example.com",
      cpmMicropaise: 1_000_000,
      budgetMicropaise: 50_000,
      targetingMode: "specific",
      surfaces: ["claude.ai"],
    }),
    (err: unknown) => err instanceof AdsValidationError,
  );

  const pending = await service.submitCampaign(actorA, orgA, draft.id);
  assert.equal(pending.status, "pending_review");

  const waitPending = await startWaitSessionPg(`ads_pending_${stamp}`, "chatgpt.com");
  const pendingAd = await createAdRequestPg({
    waitSessionId: waitPending.id,
    userId: `ads_pending_${stamp}`,
    restrictToCampaignIds: [draft.id],
  });
  assert.equal(pendingAd.ok, true);
  if (pendingAd.ok) assert.equal(pendingAd.source, "house", "pending cannot serve");

  await assert.rejects(
    () => service.moderateCampaign(actorA, draft.id, "approve"),
    (err: unknown) => err instanceof AdsAuthError,
  );

  await service.moderateCampaign(actorAdmin, draft.id, "approve", "looks good");
  const live = await service.loadCampaign(orgA, draft.id);
  assert.equal(live.status, "active");
  assert.equal(live.reviewStatus, "approved");

  const waitLive = await startWaitSessionPg(`ads_live_${stamp}`, "chatgpt.com");
  const liveAd = await createAdRequestPg({
    waitSessionId: waitLive.id,
    userId: `ads_live_${stamp}`,
    restrictToCampaignIds: [draft.id],
  });
  assert.equal(liveAd.ok, true);
  if (liveAd.ok) {
    assert.equal(liveAd.source, "paid_campaign");
    assert.equal(liveAd.campaignId, draft.id);
  }

  const waitClaude = await startWaitSessionPg(`ads_claude_${stamp}`, "claude.ai");
  const claudeAd = await createAdRequestPg({
    waitSessionId: waitClaude.id,
    userId: `ads_claude_${stamp}`,
    restrictToCampaignIds: [draft.id],
  });
  assert.equal(claudeAd.ok, true);
  if (claudeAd.ok) assert.equal(claudeAd.source, "house", "ChatGPT-only cannot serve Claude");

  await service.pauseCampaign(actorA, orgA, draft.id);
  const waitPaused = await startWaitSessionPg(`ads_paused_${stamp}`, "chatgpt.com");
  const pausedAd = await createAdRequestPg({
    waitSessionId: waitPaused.id,
    userId: `ads_paused_${stamp}`,
    restrictToCampaignIds: [draft.id],
  });
  assert.equal(pausedAd.ok, true);
  if (pausedAd.ok) assert.equal(pausedAd.source, "house", "paused cannot serve");
  await service.resumeCampaign(actorA, orgA, draft.id);

  const rejected = await service.createCampaign(actorA, orgA, {
    name: `__omni_test_${runId}_rej`,
    advertiserName: "Acme A",
    headline: "Reject me",
    body: "x",
    ctaLabel: "Go",
    ctaUrl: "https://example.com/r",
    cpmMicropaise: 1_000_000,
    budgetMicropaise: 10_000,
    targetingMode: "all_enabled",
  });
  await service.submitCampaign(actorA, orgA, rejected.id);
  await service.moderateCampaign(actorAdmin, rejected.id, "reject", "no");
  const waitRej = await startWaitSessionPg(`ads_rej_${stamp}`, "chatgpt.com");
  const rejAd = await createAdRequestPg({
    waitSessionId: waitRej.id,
    userId: `ads_rej_${stamp}`,
    restrictToCampaignIds: [rejected.id],
  });
  assert.equal(rejAd.ok, true);
  if (rejAd.ok) assert.equal(rejAd.source, "house", "rejected cannot serve");

  const expired = await service.createCampaign(actorA, orgA, {
    name: `__omni_test_${runId}_exp`,
    advertiserName: "Acme A",
    headline: "Expired",
    body: "x",
    ctaLabel: "Go",
    ctaUrl: "https://example.com/e",
    cpmMicropaise: 1_000_000,
    budgetMicropaise: 10_000,
    targetingMode: "all_enabled",
    startsAt: new Date(Date.now() - 86_400_000).toISOString(),
    endsAt: new Date(Date.now() - 3_600_000).toISOString(),
  });
  await service.submitCampaign(actorA, orgA, expired.id);
  await service.moderateCampaign(actorAdmin, expired.id, "approve");
  const waitExp = await startWaitSessionPg(`ads_exp_${stamp}`, "chatgpt.com");
  const expAd = await createAdRequestPg({
    waitSessionId: waitExp.id,
    userId: `ads_exp_${stamp}`,
    restrictToCampaignIds: [expired.id],
  });
  assert.equal(expAd.ok, true);
  if (expAd.ok) assert.equal(expAd.source, "house", "expired cannot serve");

  await sb.from("inventory_surfaces").update({ serving_enabled: true }).eq("surface_key", "claude.ai");
  try {
    const claudeOnly = await service.createCampaign(actorA, orgA, {
      name: `__omni_test_${runId}_claude`,
      advertiserName: "Acme A",
      headline: "Claude only",
      body: "x",
      ctaLabel: "Go",
      ctaUrl: "https://example.com/c",
      cpmMicropaise: 1_000_000,
      budgetMicropaise: 10_000,
      targetingMode: "specific",
      surfaces: ["claude.ai"],
    });
    await service.submitCampaign(actorA, orgA, claudeOnly.id);
    await service.moderateCampaign(actorAdmin, claudeOnly.id, "approve");
    const waitGptVsClaude = await startWaitSessionPg(`ads_gvc_${stamp}`, "chatgpt.com");
    const gptVsClaude = await createAdRequestPg({
      waitSessionId: waitGptVsClaude.id,
      userId: `ads_gvc_${stamp}`,
      restrictToCampaignIds: [claudeOnly.id],
    });
    assert.equal(gptVsClaude.ok, true);
    if (gptVsClaude.ok) assert.equal(gptVsClaude.source, "house", "Claude-only cannot serve ChatGPT");
    const waitClaudeOk = await startWaitSessionPg(`ads_cok_${stamp}`, "claude.ai");
    const claudeOk = await createAdRequestPg({
      waitSessionId: waitClaudeOk.id,
      userId: `ads_cok_${stamp}`,
      restrictToCampaignIds: [claudeOnly.id],
    });
    assert.equal(claudeOk.ok, true);
    if (claudeOk.ok) assert.equal(claudeOk.source, "paid_campaign");
  } finally {
    await sb.from("inventory_surfaces").update({ serving_enabled: false }).eq("surface_key", "claude.ai");
  }

  const emptySurf = await service.createCampaign(actorA, orgA, {
    name: `__omni_test_${runId}_empty`,
    advertiserName: "Acme A",
    headline: "Empty specific",
    body: "x",
    ctaLabel: "Go",
    ctaUrl: "https://example.com/z",
    cpmMicropaise: 1_000_000,
    budgetMicropaise: 10_000,
    targetingMode: "specific",
    surfaces: ["chatgpt.com"],
  });
  await sb.from("campaign_surfaces").delete().eq("campaign_id", emptySurf.id);
  await sb.from("campaigns").update({ targeting_mode: "specific", status: "active", review_status: "approved" }).eq("id", emptySurf.id);
  const waitEmpty = await startWaitSessionPg(`ads_empty_${stamp}`, "chatgpt.com");
  const emptyAd = await createAdRequestPg({
    waitSessionId: waitEmpty.id,
    userId: `ads_empty_${stamp}`,
    restrictToCampaignIds: [emptySurf.id],
  });
  assert.equal(emptyAd.ok, true);
  if (emptyAd.ok) assert.equal(emptyAd.source, "house", "specific targeting with zero surfaces serves nowhere");

  const { campaignId: exhaustedId } = await createFundedCampaignPg({
    advertiserEmail: `__omni_test_exh_${runId}@example.com`,
    name: `__omni_test_${runId}_exh`,
    providerKey: "omni_direct",
    cpmMicropaise: 1_000_000,
    totalBudgetMicropaise: 1000,
    headline: "Exh",
    body: "x",
    ctaLabel: "Go",
    ctaUrl: "https://example.com/x",
    status: "active",
  });
  await sb.from("campaigns").update({ spent_micropaise: 1000, targeting_mode: "all_enabled" }).eq("id", exhaustedId);
  const waitExh = await startWaitSessionPg(`ads_exh_${stamp}`, "chatgpt.com");
  const exhAd = await createAdRequestPg({
    waitSessionId: waitExh.id,
    userId: `ads_exh_${stamp}`,
    restrictToCampaignIds: [exhaustedId],
  });
  assert.equal(exhAd.ok, true);
  if (exhAd.ok) assert.equal(exhAd.source, "house", "budget exhausted cannot serve");

  await setPaidInventoryEnabledPg(false);
  try {
    const waitKill = await startWaitSessionPg(`ads_kill_${stamp}`, "chatgpt.com");
    const killAd = await createAdRequestPg({
      waitSessionId: waitKill.id,
      userId: `ads_kill_${stamp}`,
      restrictToCampaignIds: [draft.id],
    });
    assert.equal(killAd.ok, true);
    if (killAd.ok) {
      assert.equal(killAd.source, "house", "paid kill switch must not serve paid inventory");
    }
  } finally {
    await setPaidInventoryEnabledPg(true);
  }
  const waitKillOn = await startWaitSessionPg(`ads_killon_${stamp}`, "chatgpt.com");
  const killOnAd = await createAdRequestPg({
    waitSessionId: waitKillOn.id,
    userId: `ads_killon_${stamp}`,
    restrictToCampaignIds: [draft.id],
  });
  assert.equal(killOnAd.ok, true);
  if (killOnAd.ok) {
    assert.equal(killOnAd.source, "paid_campaign", "paid inventory resumes after kill switch re-enabled");
  }

  await sb
    .from("inventory_surfaces")
    .update({ serving_enabled: true })
    .in("surface_key", ["gemini.google.com", "claude.ai"]);
  try {
    const geminiOnly = await service.createCampaign(actorA, orgA, {
      name: `__omni_test_${runId}_gemini`,
      advertiserName: "Acme A",
      headline: "Gemini only",
      body: "x",
      ctaLabel: "Go",
      ctaUrl: "https://example.com/g",
      cpmMicropaise: 1_000_000,
      budgetMicropaise: 10_000,
      targetingMode: "specific",
      surfaces: ["gemini.google.com"],
    });
    await service.submitCampaign(actorA, orgA, geminiOnly.id);
    await service.moderateCampaign(actorAdmin, geminiOnly.id, "approve");
    const waitGemClaude = await startWaitSessionPg(`ads_gcl_${stamp}`, "claude.ai");
    const gemOnClaude = await createAdRequestPg({
      waitSessionId: waitGemClaude.id,
      userId: `ads_gcl_${stamp}`,
      restrictToCampaignIds: [geminiOnly.id],
    });
    assert.equal(gemOnClaude.ok, true);
    if (gemOnClaude.ok) {
      assert.equal(gemOnClaude.source, "house", "Gemini-only must not serve Claude");
    }
    const waitGemOk = await startWaitSessionPg(`ads_gok_${stamp}`, "gemini.google.com");
    const gemOk = await createAdRequestPg({
      waitSessionId: waitGemOk.id,
      userId: `ads_gok_${stamp}`,
      restrictToCampaignIds: [geminiOnly.id],
    });
    assert.equal(gemOk.ok, true);
    if (gemOk.ok) {
      assert.equal(gemOk.source, "paid_campaign", "Gemini-only may serve Gemini when enabled");
    }
  } finally {
    await sb
      .from("inventory_surfaces")
      .update({ serving_enabled: false })
      .in("surface_key", ["gemini.google.com", "claude.ai"]);
  }

  const metrics = await service.campaignAnalytics(orgA, draft.id);
  assert.equal(typeof metrics.totals.qualifiedImpressions, "number");
  assert.equal(metrics.totals.verifiedAttentionSeconds >= 0, true);

  const { data: bSeesACampaigns } = await userAClient.from("campaigns").select("id").eq("id", draft.id);
  assert.ok((bSeesACampaigns ?? []).length >= 1, "A can read own campaign");
  const userBClient = createClient(getSupabaseUrl(), process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "", {
    global: { headers: { Authorization: `Bearer ${userB.token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: bReadA } = await userBClient.from("campaigns").select("id").eq("id", draft.id);
  assert.equal((bReadA ?? []).length, 0, "B cannot read A campaigns");
  const { data: bWallet } = await userBClient.from("advertiser_wallets").select("cached_balance_micropaise").eq("advertiser_id", orgA.advertiserId);
  assert.equal((bWallet ?? []).length, 0, "B cannot see A wallet");
  const { data: bFund } = await userBClient.from("advertiser_funding_requests").select("id").eq("advertiser_id", orgA.advertiserId);
  assert.equal((bFund ?? []).length, 0, "B cannot see A funding");

  if (control && controlBefore) {
    const { data: after } = await sb
      .from("campaigns")
      .select("status, spent_micropaise, cpm_micropaise, total_budget_micropaise, provider_key, review_status")
      .eq("id", control.id)
      .single();
    assert.equal(after?.status, controlBefore.status);
    assert.equal(Number(after?.spent_micropaise), controlBefore.spent);
    assert.equal(Number(after?.cpm_micropaise), controlBefore.cpm);
    assert.equal(Number(after?.total_budget_micropaise), controlBefore.budget);
    assert.equal(after?.provider_key, controlBefore.provider);
    assert.equal(after?.review_status, controlBefore.review);
  }

  console.log("PASS: Omni Ads lifecycle, targeting, funding, A/B RLS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
