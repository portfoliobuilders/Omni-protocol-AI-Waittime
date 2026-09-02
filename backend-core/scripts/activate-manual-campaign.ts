import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const NAME = "ChatGPT live paid inventory";

async function main(): Promise<void> {
  const { assertPostgresExchangeReady, getServiceSupabase } = await import(
    "../src/exchange/supabaseClient.ts"
  );
  assertPostgresExchangeReady();
  const sb = getServiceSupabase();
  const { error: updErr } = await sb
    .from("campaigns")
    .update({ status: "active" })
    .eq("name", NAME);
  if (updErr) throw new Error(updErr.message);
  const { data, error } = await sb
    .from("campaigns")
    .select("name, status, spent_micropaise, total_budget_micropaise")
    .eq("name", NAME)
    .maybeSingle();
  if (error) throw new Error(error.message);
  console.log(JSON.stringify(data, null, 2));
  if (!data || data.status !== "active") {
    throw new Error("manual campaign was not activated");
  }
  if (Number(data.spent_micropaise) !== 3000) {
    console.warn(
      `WARNING: spent_micropaise is ${data.spent_micropaise}, expected 3000 (history must not be reset)`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
