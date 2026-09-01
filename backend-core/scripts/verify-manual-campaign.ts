import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function main(): Promise<void> {
  const { assertPostgresExchangeReady, getServiceSupabase } = await import(
    "../src/exchange/supabaseClient.ts"
  );
  const { MANUAL_CHATGPT_CAMPAIGN_NAME } = await import(
    "../src/exchange/testIsolation.ts"
  );

  assertPostgresExchangeReady();
  const sb = getServiceSupabase();
  const { data: c, error } = await sb
    .from("campaigns")
    .select(
      "id, name, status, provider_key, review_status, cpm_micropaise, total_budget_micropaise, spent_micropaise",
    )
    .eq("name", MANUAL_CHATGPT_CAMPAIGN_NAME)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !c) throw new Error(error?.message ?? "manual campaign missing");
  const { data: cr } = await sb
    .from("creatives")
    .select("status, headline")
    .eq("campaign_id", c.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  const { data: cs } = await sb
    .from("campaign_surfaces")
    .select("surface")
    .eq("campaign_id", c.id);
  const remainingImpressions = Math.floor(
    (Number(c.total_budget_micropaise) - Number(c.spent_micropaise)) /
      Math.max(1, Math.floor(Number(c.cpm_micropaise) / 1000)),
  );
  console.log(
    JSON.stringify(
      {
        campaign: c,
        creative: cr,
        surfaces: cs ?? [],
        remainingImpressions,
        surfaceEligibility:
          (cs ?? []).length === 0
            ? "no campaign_surfaces rows — pickPaidCampaign treats all surfaces as eligible"
            : (cs ?? []).map((row) => row.surface),
      },
      null,
      2,
    ),
  );
  if (c.status !== "active" || c.provider_key !== "omni_direct") {
    process.exit(1);
  }
  if (remainingImpressions < 1) {
    console.error("FAIL: budget remaining is below one impression");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
