/**
 * Phase 2.1 — RLS probes against local Supabase (anon + authenticated).
 * Run: npm run test:rls
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import dotenv from "dotenv";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function main(): Promise<void> {
  const { getAnonSupabase, getServiceSupabase, assertPostgresExchangeReady } =
    await import("../src/exchange/supabaseClient.ts");
  assertPostgresExchangeReady();

  const anon = getAnonSupabase();
  const sb = getServiceSupabase();
  const stamp = Date.now();

  const profileId = crypto.randomUUID();
  await sb.from("profiles").upsert({ id: profileId, role: "user" });
  await sb.from("wallets").upsert({
    profile_id: profileId,
    cached_balance_micropaise: 1000,
    available_micropaise: 1000,
  });

  const cases: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "anon cannot insert ledger_entries",
      run: async () => {
        const { error } = await anon.from("ledger_entries").insert({
          wallet_id: crypto.randomUUID(),
          entry_type: "hack",
          amount_micropaise: 1,
          balance_after_micropaise: 1,
          idempotency_key: `rls-ledger:${stamp}`,
        });
        assert.ok(error, "expected error");
      },
    },
    {
      name: "anon cannot credit wallets",
      run: async () => {
        await anon
          .from("wallets")
          .update({ available_micropaise: 99_000_000 })
          .eq("profile_id", profileId);
        const { data } = await sb
          .from("wallets")
          .select("available_micropaise")
          .eq("profile_id", profileId)
          .single();
        assert.equal(Number(data?.available_micropaise), 1000);
      },
    },
    {
      name: "anon cannot call settle_impression",
      run: async () => {
        const { error } = await anon.rpc("settle_impression", {
          p_impression_id: crypto.randomUUID(),
        });
        assert.ok(error, "expected RPC denial");
      },
    },
    {
      name: "anon cannot call request_redemption",
      run: async () => {
        const { error } = await anon.rpc("request_redemption", {
          p_profile_id: profileId,
          p_amount_micropaise: 1,
          p_method: "upi",
          p_detail: "hack",
        });
        assert.ok(error, "expected RPC denial");
      },
    },
    {
      name: "anon cannot modify app_config",
      run: async () => {
        await anon
          .from("app_config")
          .update({ value: 1 })
          .eq("key", "user_revenue_share_bps");
        const { data } = await sb
          .from("app_config")
          .select("value")
          .eq("key", "user_revenue_share_bps")
          .single();
        assert.equal(Number(data?.value), 6000);
      },
    },
    {
      name: "anon cannot force-settle impressions",
      run: async () => {
        const { data: imp } = await sb
          .from("impressions")
          .select("id, status")
          .limit(1)
          .maybeSingle();
        if (!imp?.id) return;
        await anon
          .from("impressions")
          .update({ status: "settled", financial_status: "settled" })
          .eq("id", imp.id);
        const { data: after } = await sb
          .from("impressions")
          .select("status, financial_status")
          .eq("id", imp.id)
          .single();
        assert.equal(after?.status, imp.status);
      },
    },
    {
      name: "anon cannot insert advertiser_ledger_entries",
      run: async () => {
        const { error } = await anon.from("advertiser_ledger_entries").insert({
          advertiser_id: crypto.randomUUID(),
          entry_type: "funding_credit",
          amount_micropaise: 1,
          balance_after_micropaise: 1,
          idempotency_key: `rls-adv:${stamp}`,
        });
        assert.ok(error, "expected error");
      },
    },
    {
      name: "authenticated user cannot insert ledger_entries",
      run: async () => {
        const email = `rls-user-${stamp}@example.com`;
        const password = "test-password-rls-123";
        const url = process.env.SUPABASE_URL!;
        const key =
          process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY!;
        const userClient = createClient(url, key, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: signed, error: signErr } = await userClient.auth.signUp({
          email,
          password,
        });
        let token = signed.session?.access_token;
        if (!token) {
          const { data: inData, error: inErr } =
            await userClient.auth.signInWithPassword({ email, password });
          if (inErr || !inData.session) {
            console.log(
              `  SKIP authenticated signup (${signErr?.message ?? inErr?.message})`,
            );
            return;
          }
          token = inData.session.access_token;
        }
        const authed = createClient(url, key, {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { error } = await authed.from("ledger_entries").insert({
          wallet_id: crypto.randomUUID(),
          entry_type: "hack",
          amount_micropaise: 1,
          balance_after_micropaise: 1,
          idempotency_key: `rls-auth-ledger:${stamp}`,
        });
        assert.ok(error, "authenticated must not insert ledger");

        const { error: settleErr } = await authed.rpc("settle_impression", {
          p_impression_id: crypto.randomUUID(),
        });
        assert.ok(settleErr, "authenticated must not settle");
      },
    },
  ];

  for (const c of cases) {
    await c.run();
    console.log(`  OK — ${c.name}`);
  }
  console.log("PASS: RLS probes");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
