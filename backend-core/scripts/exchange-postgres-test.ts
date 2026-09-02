/**
 * Phase 2.1 — Exchange financial tests against live local Supabase/Postgres.
 * Requires: npx supabase start + backend-core/.env with service role.
 * Run: npm run test:exchange:pg
 *
 * Isolation: tests never UPDATE campaigns SET status='paused' across all
 * active rows. Paid selection is scoped to campaigns this run created.
 * House fill uses forceHouse. Leftover __omni_test_* / legacy test names
 * may be paused. An existing manual ChatGPT campaign is never mutated
 * (status, spend, creatives, provider). Bootstrap-create only if missing.
 */
process.env.OMNI_TEST_MODE = "true";

import assert from "node:assert/strict";
import crypto from "node:crypto";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

type CampaignSnapshot = {
  id: string;
  name: string;
  status: string;
  provider_key: string | null;
  review_status: string | null;
  cpm_micropaise: number;
  total_budget_micropaise: number;
  spent_micropaise: number;
};

async function main(): Promise<void> {
  const { assertPostgresExchangeReady, getServiceSupabase, getAnonSupabase } =
    await import("../src/exchange/supabaseClient.ts");
  assertPostgresExchangeReady();

  const {
    startWaitSessionPg,
    createAdRequestPg,
    qualifyAndSettlePg,
    getWalletPg,
    createFundedCampaignPg,
    backdateWaitSessionPg,
    profileIdFromUserId,
    expireStaleExchangeRowsPg,
    endWaitSessionPg,
  } = await import("../src/exchange/postgres.ts");
  const {
    MANUAL_CHATGPT_CAMPAIGN_NAME,
    assertSafeToMutateCampaign,
    isOmniTestCampaignName,
    omniTestCampaignName,
    pauseLeftoverTestCampaigns,
    pauseTestCampaignsById,
  } = await import("../src/exchange/testIsolation.ts");
  const money = await import("../src/money/micropaise.ts");

  assert.equal(isOmniTestCampaignName("__omni_test_abc_pilot"), true);
  assert.equal(isOmniTestCampaignName("PG Direct Pilot"), true);
  assert.equal(isOmniTestCampaignName(MANUAL_CHATGPT_CAMPAIGN_NAME), false);
  assert.throws(() =>
    assertSafeToMutateCampaign(MANUAL_CHATGPT_CAMPAIGN_NAME, "control-id"),
  );

  assert.equal(money.cpmInrToMicropaisePerImpression(10), 1000);
  const split = money.splitRevenueMicropaise(1000, 6000);
  assert.equal(split.user, 600);
  assert.equal(split.omni, 400);

  const leftoverPaused = await pauseLeftoverTestCampaigns();

  const sb = getServiceSupabase();
  const control = await ensureManualChatGptCampaign(sb, createFundedCampaignPg);
  const controlBefore = await snapshotCampaign(sb, control.id);

  const stamp = Date.now();
  const runId = crypto.randomUUID().slice(0, 8);
  const createdTestCampaignIds: string[] = [];
  const userId = `pg_user_${stamp}`;
  const email = `__omni_test_${runId}@example.com`;

  const { campaignId } = await createFundedCampaignPg({
    advertiserEmail: email,
    name: omniTestCampaignName(runId, "pilot"),
    providerKey: "omni_direct",
    cpmMicropaise: 1_000_000,
    totalBudgetMicropaise: 3_000,
    headline: "Funded Direct Ad",
    body: "Real budget",
    ctaLabel: "Open",
    ctaUrl: "https://example.com/pg",
    status: "active",
  });
  createdTestCampaignIds.push(campaignId);

  const wait = await startWaitSessionPg(userId, "chatgpt.com");
  await backdateWaitSessionPg(
    wait.id,
    new Date(Date.now() - 15_000).toISOString(),
  );

  const ad = await createAdRequestPg({
    waitSessionId: wait.id,
    userId,
    restrictToCampaignIds: [campaignId],
  });
  assert.equal(ad.ok, true);
  if (!ad.ok) throw new Error(ad.reason);
  assert.equal(ad.source, "paid_campaign");
  assert.equal(ad.campaignId, campaignId);
  assert.ok(ad.creative.advertiser_name);

  const settled = await qualifyAndSettlePg({
    impressionId: ad.impressionId,
    userId,
    reportedViewMs: 6000,
  });
  assert.equal(settled.ok, true);
  if (!settled.ok) throw new Error(settled.reason);
  assert.equal(settled.duplicate, false);
  assert.equal(settled.grossMicropaise, 1000);
  assert.equal(settled.userShareMicropaise, 600);
  assert.equal(settled.omniShareMicropaise, 400);
  assert.equal(settled.userShareMicropaise + settled.omniShareMicropaise, 1000);

  const dup = await qualifyAndSettlePg({
    impressionId: ad.impressionId,
    userId,
    reportedViewMs: 6000,
  });
  assert.equal(dup.ok, true);
  if (!dup.ok) throw new Error(dup.reason);
  assert.equal(dup.duplicate, true);

  const wallet = await getWalletPg(userId);
  assert.equal(wallet.availableMicropaise, 600);

  const { count: revCount } = await sb
    .from("revenue_events")
    .select("id", { count: "exact", head: true })
    .eq("impression_id", ad.impressionId);
  assert.equal(revCount, 1);

  // House: forceHouse — do not pause any campaigns
  const houseUser = `pg_house_${stamp}`;
  const waitH = await startWaitSessionPg(houseUser, "chatgpt.com");
  await backdateWaitSessionPg(
    waitH.id,
    new Date(Date.now() - 15_000).toISOString(),
  );
  const houseAd = await createAdRequestPg({
    waitSessionId: waitH.id,
    userId: houseUser,
    forceHouse: true,
  });
  assert.equal(houseAd.ok, true);
  if (!houseAd.ok) throw new Error(houseAd.reason);
  assert.equal(houseAd.source, "house");
  assert.equal(houseAd.creative.headline, "Omni");
  assert.equal(
    /earn|revenue|share|₹|\+₹|60%/i.test(
      `${houseAd.creative.headline} ${houseAd.creative.body}`,
    ),
    false,
  );
  const houseSettle = await qualifyAndSettlePg({
    impressionId: houseAd.impressionId,
    userId: houseUser,
    reportedViewMs: 6000,
  });
  assert.equal(houseSettle.ok, true);
  if (!houseSettle.ok) throw new Error(houseSettle.reason);
  assert.equal(houseSettle.grossMicropaise, 0);
  assert.equal(houseSettle.house, true);
  const { count: houseRev } = await sb
    .from("revenue_events")
    .select("id", { count: "exact", head: true })
    .eq("impression_id", houseAd.impressionId);
  assert.equal(houseRev, 0);
  const houseWallet = await getWalletPg(houseUser);
  assert.equal(houseWallet.availableMicropaise, 0);

  const seedEmail = `__omni_test_seed_${runId}@example.com`;
  const { campaignId: seedId } = await createFundedCampaignPg({
    advertiserEmail: seedEmail,
    name: omniTestCampaignName(runId, "seed"),
    providerKey: "seed_sponsor",
    cpmMicropaise: 1_000_000,
    totalBudgetMicropaise: 2_000,
    headline: "Seed",
    body: "Funded seed",
    ctaLabel: "Go",
    ctaUrl: "https://example.com/seed",
    status: "active",
  });
  createdTestCampaignIds.push(seedId);
  const seedUser = `pg_seed_${stamp}`;
  const waitS = await startWaitSessionPg(seedUser, "claude.ai");
  await backdateWaitSessionPg(
    waitS.id,
    new Date(Date.now() - 15_000).toISOString(),
  );
  const seedAd = await createAdRequestPg({
    waitSessionId: waitS.id,
    userId: seedUser,
    preferredProvider: "seed_sponsor",
    restrictToCampaignIds: [seedId],
  });
  assert.equal(seedAd.ok, true);
  if (!seedAd.ok) throw new Error(seedAd.reason);
  assert.equal(seedAd.providerKey, "seed_sponsor");
  const seedSettle = await qualifyAndSettlePg({
    impressionId: seedAd.impressionId,
    userId: seedUser,
    reportedViewMs: 6000,
  });
  assert.equal(seedSettle.ok, true);
  if (!seedSettle.ok) throw new Error(seedSettle.reason);
  assert.equal(seedSettle.grossMicropaise, 1000);
  assert.equal(seedSettle.userShareMicropaise, 600);
  assert.equal(seedSettle.omniShareMicropaise, 400);

  const { campaignId: raceId } = await createFundedCampaignPg({
    advertiserEmail: `__omni_test_race_${runId}@example.com`,
    name: omniTestCampaignName(runId, "race"),
    providerKey: "omni_direct",
    cpmMicropaise: 1_000_000,
    totalBudgetMicropaise: 1_000,
    headline: "Race",
    body: "One left",
    ctaLabel: "Go",
    ctaUrl: "https://example.com/race",
    status: "active",
  });
  createdTestCampaignIds.push(raceId);

  const uA = `pg_race_a_${stamp}`;
  const uB = `pg_race_b_${stamp}`;
  const wA = await startWaitSessionPg(uA, "chatgpt.com");
  const wB = await startWaitSessionPg(uB, "chatgpt.com");
  await backdateWaitSessionPg(wA.id, new Date(Date.now() - 15_000).toISOString());
  await backdateWaitSessionPg(wB.id, new Date(Date.now() - 15_000).toISOString());
  const adA = await createAdRequestPg({
    waitSessionId: wA.id,
    userId: uA,
    restrictToCampaignIds: [raceId],
  });
  const adB = await createAdRequestPg({
    waitSessionId: wB.id,
    userId: uB,
    restrictToCampaignIds: [raceId],
  });
  assert.equal(adA.ok && adB.ok, true);
  if (!adA.ok || !adB.ok) throw new Error("race ad failed");
  assert.equal(adA.campaignId, raceId);
  assert.equal(adB.campaignId, raceId);

  const [rA, rB] = await Promise.all([
    qualifyAndSettlePg({
      impressionId: adA.impressionId,
      userId: uA,
      reportedViewMs: 6000,
    }),
    qualifyAndSettlePg({
      impressionId: adB.impressionId,
      userId: uB,
      reportedViewMs: 6000,
    }),
  ]);

  const successes = [rA, rB].filter((r) => r.ok && !r.ok === false && (r as { ok: true }).grossMicropaise > 0);
  const paid = [rA, rB].filter(
    r => r.ok && "grossMicropaise" in r && r.grossMicropaise === 1000 && !r.duplicate,
  );
  const failedOrZero = [rA, rB].filter(
    (r) => !r.ok || (r.ok && r.grossMicropaise === 0 && !r.duplicate),
  );

  assert.equal(
    paid.length,
    1,
    `expected exactly one paid settle, got paid=${paid.length} A=${JSON.stringify(rA)} B=${JSON.stringify(rB)}`,
  );
  assert.ok(
    failedOrZero.length >= 1 ||
      [rA, rB].some((r) => !r.ok || (r.ok && r.duplicate === false && r.grossMicropaise === 0)),
    "second concurrent settle must fail or pay zero",
  );

  const { data: raceCamp } = await sb
    .from("campaigns")
    .select("spent_micropaise, total_budget_micropaise, status")
    .eq("id", raceId)
    .single();
  assert.equal(Number(raceCamp?.spent_micropaise), 1000);
  assert.ok(Number(raceCamp?.spent_micropaise) <= Number(raceCamp?.total_budget_micropaise));

  const { data: revs } = await sb
    .from("revenue_events")
    .select("gross_micropaise, user_share_micropaise, omni_share_micropaise")
    .eq("campaign_id", raceId);
  let g = 0;
  let u = 0;
  let o = 0;
  for (const row of revs ?? []) {
    g += Number(row.gross_micropaise);
    u += Number(row.user_share_micropaise);
    o += Number(row.omni_share_micropaise);
  }
  assert.equal(u + o, g);
  assert.equal(g, 1000);

  const anon = getAnonSupabase();
  const profileId = profileIdFromUserId(userId);
  const ledgerInsert = await anon.from("ledger_entries").insert({
    wallet_id: randomUuid(),
    entry_type: "hack",
    amount_micropaise: 999,
    balance_after_micropaise: 999,
    idempotency_key: `hack:${stamp}`,
  });
  assert.ok(ledgerInsert.error, "anon must not insert ledger_entries");

  const walletUpdate = await anon
    .from("wallets")
    .update({ available_micropaise: 9_999_999 })
    .eq("profile_id", profileId);
  const { data: walletAfter } = await sb
    .from("wallets")
    .select("available_micropaise")
    .eq("profile_id", profileId)
    .single();
  assert.equal(Number(walletAfter?.available_micropaise), 600);

  const settleRpc = await anon.rpc("settle_impression", {
    p_impression_id: ad.impressionId,
  });
  assert.ok(settleRpc.error, "anon must not execute settle_impression");

  const configHack = await anon
    .from("app_config")
    .update({ value: 1 })
    .eq("key", "user_revenue_share_bps");
  void configHack;
  const { data: cfg } = await sb
    .from("app_config")
    .select("value")
    .eq("key", "user_revenue_share_bps")
    .single();
  assert.equal(Number(cfg?.value), 6000);

  // Stale unpaid impression expires with no money movement
  const staleUser = `pg_stale_${stamp}`;
  const waitStale = await startWaitSessionPg(staleUser, "chatgpt.com");
  const staleAd = await createAdRequestPg({
    waitSessionId: waitStale.id,
    userId: staleUser,
    forceHouse: true,
  });
  assert.equal(staleAd.ok, true);
  if (!staleAd.ok) throw new Error(staleAd.reason);
  await sb
    .from("impressions")
    .update({
      created_at: new Date(Date.now() - 120_000).toISOString(),
    })
    .eq("id", staleAd.impressionId);
  await expireStaleExchangeRowsPg(60);
  const { data: staleImp } = await sb
    .from("impressions")
    .select("status, financial_status")
    .eq("id", staleAd.impressionId)
    .single();
  assert.equal(staleImp?.status, "expired");
  assert.equal(staleImp?.financial_status, "none");
  const staleQualify = await qualifyAndSettlePg({
    impressionId: staleAd.impressionId,
    userId: staleUser,
    reportedViewMs: 6000,
  });
  assert.equal(staleQualify.ok, false);
  const { count: staleRev } = await sb
    .from("revenue_events")
    .select("id", { count: "exact", head: true })
    .eq("impression_id", staleAd.impressionId);
  assert.equal(staleRev, 0);
  const ended = await endWaitSessionPg(waitStale.id, staleUser);
  assert.equal(ended.ok, true);

  const controlAfter = await snapshotCampaign(sb, control.id);
  assert.equal(
    controlAfter.status,
    controlBefore.status,
    "manual control status must be unchanged by the test suite",
  );
  assert.equal(controlAfter.provider_key, controlBefore.provider_key);
  assert.equal(
    controlAfter.total_budget_micropaise,
    controlBefore.total_budget_micropaise,
  );
  assert.equal(
    controlAfter.spent_micropaise,
    controlBefore.spent_micropaise,
    "manual control spent must be unchanged by the test suite",
  );

  await pauseTestCampaignsById(createdTestCampaignIds);

  const controlFinal = await snapshotCampaign(sb, control.id);
  assert.equal(controlFinal.status, controlBefore.status);
  assert.equal(controlFinal.spent_micropaise, controlBefore.spent_micropaise);

  const verify = await loadManualVerify(sb, control.id);

  console.log("PASS: Postgres Exchange — 600/400, duplicate, house ₹0, seed, concurrency, RLS anon, isolation");
  console.log(`  leftovers_paused=${leftoverPaused} successes_paid=${paid.length} race_spent=${raceCamp?.spent_micropaise}`);
  console.log("MANUAL CAMPAIGN (unchanged by tests):");
  console.log(`  id=${verify.id}`);
  console.log(`  name=${verify.name}`);
  console.log(`  status=${verify.status}`);
  console.log(`  provider_key=${verify.provider_key}`);
  console.log(`  review_status=${verify.review_status}`);
  console.log(`  cpm_micropaise=${verify.cpm_micropaise}`);
  console.log(`  budget=${verify.total_budget_micropaise} spent=${verify.spent_micropaise}`);
  console.log(`  creative_status=${verify.creativeStatus} headline=${verify.creativeHeadline}`);
  console.log(`  surfaces=${verify.surfaces.length === 0 ? "(none — all surfaces eligible)" : verify.surfaces.join(",")}`);
  console.log("VERIFY before ChatGPT paid retest:");
  console.log(
    `  psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "select c.id, c.name, c.status, c.provider_key, c.review_status, c.cpm_micropaise, c.total_budget_micropaise, c.spent_micropaise, cr.status as creative_status, cr.headline, coalesce(string_agg(cs.surface, ','), '(all surfaces)') as surfaces from campaigns c left join creatives cr on cr.campaign_id = c.id left join campaign_surfaces cs on cs.campaign_id = c.id where c.name = '${MANUAL_CHATGPT_CAMPAIGN_NAME}' group by c.id, cr.status, cr.headline;"`,
  );
  void successes;
  void walletUpdate;
}

type FundedCreate = (input: {
  advertiserEmail: string;
  advertiserName?: string;
  name: string;
  providerKey: "omni_direct" | "seed_sponsor";
  cpmMicropaise: number;
  totalBudgetMicropaise: number;
  headline: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  status?: "draft" | "active" | "pending_review";
}) => Promise<{ campaignId: string; advertiserId: string }>;

async function ensureManualChatGptCampaign(
  sb: ReturnType<typeof import("../src/exchange/supabaseClient.ts").getServiceSupabase>,
  createFundedCampaignPg: FundedCreate,
): Promise<CampaignSnapshot> {
  const { MANUAL_CHATGPT_CAMPAIGN_NAME } = await import(
    "../src/exchange/testIsolation.ts"
  );
  const { data: existing } = await sb
    .from("campaigns")
    .select(
      "id, name, status, provider_key, review_status, cpm_micropaise, total_budget_micropaise, spent_micropaise",
    )
    .eq("name", MANUAL_CHATGPT_CAMPAIGN_NAME)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!existing?.id) {
    const created = await createFundedCampaignPg({
      advertiserEmail: "chatgpt-live-manual@portfoliobuilders.in",
      advertiserName: "Omni Manual ChatGPT",
      name: MANUAL_CHATGPT_CAMPAIGN_NAME,
      providerKey: "omni_direct",
      cpmMicropaise: 1_000_000,
      totalBudgetMicropaise: 50_000,
      headline: "Omni Direct — ChatGPT",
      body: "Funded wait-time inventory for ChatGPT live retest.",
      ctaLabel: "Learn more",
      ctaUrl: "https://portfoliobuilders.in",
      status: "active",
    });
    return snapshotCampaign(sb, created.campaignId);
  }

  // Existing manual campaign is operator-owned. Tests must not change
  // status, spend, budget, provider, or creatives.
  return snapshotCampaign(sb, existing.id as string);
}

async function snapshotCampaign(
  sb: ReturnType<typeof import("../src/exchange/supabaseClient.ts").getServiceSupabase>,
  id: string,
): Promise<CampaignSnapshot> {
  const { data, error } = await sb
    .from("campaigns")
    .select(
      "id, name, status, provider_key, review_status, cpm_micropaise, total_budget_micropaise, spent_micropaise",
    )
    .eq("id", id)
    .single();
  if (error || !data) throw new Error(error?.message ?? "campaign snapshot failed");
  return {
    id: data.id as string,
    name: String(data.name),
    status: String(data.status),
    provider_key: (data.provider_key as string | null) ?? null,
    review_status: (data.review_status as string | null) ?? null,
    cpm_micropaise: Number(data.cpm_micropaise),
    total_budget_micropaise: Number(data.total_budget_micropaise),
    spent_micropaise: Number(data.spent_micropaise),
  };
}

async function loadManualVerify(
  sb: ReturnType<typeof import("../src/exchange/supabaseClient.ts").getServiceSupabase>,
  id: string,
): Promise<
  CampaignSnapshot & {
    creativeStatus: string;
    creativeHeadline: string;
    surfaces: string[];
  }
> {
  const snap = await snapshotCampaign(sb, id);
  const { data: creative } = await sb
    .from("creatives")
    .select("status, headline")
    .eq("campaign_id", id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  const { data: surfaces } = await sb
    .from("campaign_surfaces")
    .select("surface")
    .eq("campaign_id", id);
  return {
    ...snap,
    creativeStatus: String(creative?.status ?? "missing"),
    creativeHeadline: String(creative?.headline ?? ""),
    surfaces: (surfaces ?? []).map((s) => String(s.surface)),
  };
}

function randomUuid(): string {
  return crypto.randomUUID();
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
