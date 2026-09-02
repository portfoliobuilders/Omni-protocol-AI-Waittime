import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const NAME = "ChatGPT live paid inventory";
const SURFACE = "chatgpt.com";

async function main(): Promise<void> {
  const { assertPostgresExchangeReady, getServiceSupabase } = await import(
    "../src/exchange/supabaseClient.ts"
  );
  assertPostgresExchangeReady();
  const sb = getServiceSupabase();

  const { data: campaign, error: campErr } = await sb
    .from("campaigns")
    .select(
      "id, name, status, provider_key, review_status, cpm_micropaise, total_budget_micropaise, spent_micropaise",
    )
    .eq("name", NAME)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (campErr || !campaign?.id) {
    throw new Error(campErr?.message ?? "manual campaign missing");
  }

  const before = {
    status: campaign.status,
    spent_micropaise: Number(campaign.spent_micropaise),
    total_budget_micropaise: Number(campaign.total_budget_micropaise),
    cpm_micropaise: Number(campaign.cpm_micropaise),
    provider_key: campaign.provider_key,
    review_status: campaign.review_status,
  };

  const { data: existing, error: surfErr } = await sb
    .from("campaign_surfaces")
    .select("surface")
    .eq("campaign_id", campaign.id);
  if (surfErr) throw new Error(surfErr.message);

  const have = new Set((existing ?? []).map((row) => String(row.surface)));
  if (!have.has(SURFACE)) {
    const { error: insErr } = await sb.from("campaign_surfaces").insert({
      campaign_id: campaign.id,
      surface: SURFACE,
    });
    if (insErr) throw new Error(insErr.message);
  }

  const { data: afterCamp, error: afterErr } = await sb
    .from("campaigns")
    .select(
      "name, status, provider_key, review_status, cpm_micropaise, total_budget_micropaise, spent_micropaise",
    )
    .eq("id", campaign.id)
    .single();
  if (afterErr || !afterCamp) throw new Error(afterErr?.message ?? "reload failed");

  const { data: afterSurf, error: afterSurfErr } = await sb
    .from("campaign_surfaces")
    .select("surface")
    .eq("campaign_id", campaign.id);
  if (afterSurfErr) throw new Error(afterSurfErr.message);
  const surfaces = (afterSurf ?? []).map((row) => String(row.surface)).sort();

  if (afterCamp.status !== before.status) {
    throw new Error("status must not change");
  }
  if (Number(afterCamp.spent_micropaise) !== before.spent_micropaise) {
    throw new Error("spent_micropaise must not change");
  }
  if (Number(afterCamp.total_budget_micropaise) !== before.total_budget_micropaise) {
    throw new Error("budget must not change");
  }
  if (Number(afterCamp.cpm_micropaise) !== before.cpm_micropaise) {
    throw new Error("CPM must not change");
  }
  if (afterCamp.provider_key !== before.provider_key) {
    throw new Error("provider_key must not change");
  }
  if (afterCamp.review_status !== before.review_status) {
    throw new Error("review_status must not change");
  }
  if (!surfaces.includes(SURFACE) || surfaces.length !== 1) {
    throw new Error(`expected only ${SURFACE}, got ${surfaces.join(",")}`);
  }

  console.log(
    JSON.stringify(
      {
        campaign: afterCamp,
        surfaces,
        chatgptEligible: surfaces.includes("chatgpt.com"),
        claudeEligible: surfaces.includes("claude.ai"),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
