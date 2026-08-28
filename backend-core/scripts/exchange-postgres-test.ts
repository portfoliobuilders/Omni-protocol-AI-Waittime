/**
 * Phase 2.1 — Exchange financial tests against live local Supabase/Postgres.
 * Requires: npx supabase start + backend-core/.env with service role.
 * Run: npm run test:exchange:pg
 */
import assert from "node:assert/strict";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

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
  } = await import("../src/exchange/postgres.ts");
  const money = await import("../src/money/micropaise.ts");

  assert.equal(money.cpmInrToMicropaisePerImpression(10), 1000);
  const split = money.splitRevenueMicropaise(1000, 6000);
  assert.equal(split.user, 600);
  assert.equal(split.omni, 400);

  const stamp = Date.now();
  const userId = `pg_user_${stamp}`;
  const email = `sponsor-${stamp}@example.com`;

  // ₹10 CPM = 1_000_000 micropaise / 1000; budget for ~3 impressions = 3000 micropaise gross
  // Wait: per imp gross = 1000 micropaise; budget 3000 → 3 impressions
  const { campaignId } = await createFundedCampaignPg({
    advertiserEmail: email,
    name: "PG Direct Pilot",
    providerKey: "omni_direct",
    cpmMicropaise: 1_000_000,
    totalBudgetMicropaise: 3_000,
    headline: "Funded Direct Ad",
    body: "Real budget",
    ctaLabel: "Open",
    ctaUrl: "https://example.com/pg",
    status: "active",
  });

  const wait = await startWaitSessionPg(userId, "chatgpt.com");
  await backdateWaitSessionPg(
    wait.id,
    new Date(Date.now() - 15_000).toISOString(),
  );

  const ad = await createAdRequestPg({ waitSessionId: wait.id, userId });
  assert.equal(ad.ok, true);
  if (!ad.ok) throw new Error(ad.reason);
  assert.equal(ad.source, "paid_campaign");
  assert.equal(ad.campaignId, campaignId);

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

  const sb = getServiceSupabase();
  const { count: revCount } = await sb
    .from("revenue_events")
    .select("id", { count: "exact", head: true })
    .eq("impression_id", ad.impressionId);
  assert.equal(revCount, 1);

  // House: pause ALL paid campaigns → house fill → zero money
  await sb.from("campaigns").update({ status: "paused" }).eq("status", "active");
  const houseUser = `pg_house_${stamp}`;
  const waitH = await startWaitSessionPg(houseUser, "chatgpt.com");
  await backdateWaitSessionPg(
    waitH.id,
    new Date(Date.now() - 15_000).toISOString(),
  );
  const houseAd = await createAdRequestPg({
    waitSessionId: waitH.id,
    userId: houseUser,
  });
  assert.equal(houseAd.ok, true);
  if (!houseAd.ok) throw new Error(houseAd.reason);
  assert.equal(houseAd.source, "house");
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

  // Seed sponsor: financially identical 60/40
  await sb.from("campaigns").update({ status: "paused" }).eq("status", "active");
  const seedEmail = `seed-${stamp}@example.com`;
  const { campaignId: seedId } = await createFundedCampaignPg({
    advertiserEmail: seedEmail,
    name: "Seed Sponsor",
    providerKey: "seed_sponsor",
    cpmMicropaise: 1_000_000,
    totalBudgetMicropaise: 2_000,
    headline: "Seed",
    body: "Funded seed",
    ctaLabel: "Go",
    ctaUrl: "https://example.com/seed",
    status: "active",
  });
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

  // Concurrent settlement for last impression of a tiny campaign
  await sb.from("campaigns").update({ status: "paused" }).eq("status", "active");
  const { campaignId: raceId } = await createFundedCampaignPg({
    advertiserEmail: `race-${stamp}@example.com`,
    name: "Race Budget",
    providerKey: "omni_direct",
    cpmMicropaise: 1_000_000,
    totalBudgetMicropaise: 1_000, // exactly one impression
    headline: "Race",
    body: "One left",
    ctaLabel: "Go",
    ctaUrl: "https://example.com/race",
    status: "active",
  });

  const uA = `pg_race_a_${stamp}`;
  const uB = `pg_race_b_${stamp}`;
  const wA = await startWaitSessionPg(uA, "chatgpt.com");
  const wB = await startWaitSessionPg(uB, "chatgpt.com");
  await backdateWaitSessionPg(wA.id, new Date(Date.now() - 15_000).toISOString());
  await backdateWaitSessionPg(wB.id, new Date(Date.now() - 15_000).toISOString());
  const adA = await createAdRequestPg({ waitSessionId: wA.id, userId: uA });
  const adB = await createAdRequestPg({ waitSessionId: wB.id, userId: uB });
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
    (r) => r.ok && "grossMicropaise" in r && r.grossMicropaise === 1000 && !r.duplicate,
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

  // Reconciliation: sum user+omni = gross for race campaign
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

  // RLS probes (anon)
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
  // With RLS, update should affect 0 rows or error
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

  console.log("PASS: Postgres Exchange — 600/400, duplicate, house ₹0, seed, concurrency, RLS anon");
  console.log(`  successes_paid=${paid.length} race_spent=${raceCamp?.spent_micropaise}`);
  void successes;
  void walletUpdate;
}

function randomUuid(): string {
  return crypto.randomUUID();
}

import crypto from "node:crypto";

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
