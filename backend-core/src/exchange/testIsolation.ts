/**
 * Guards so automated Exchange tests never mutate manual/dev campaigns.
 * Destructive campaign updates are allowed only when OMNI_TEST_MODE=true
 * and the campaign name is a known test marker.
 */
import { getServiceSupabase } from "./supabaseClient.js";

export const OMNI_TEST_CAMPAIGN_PREFIX = "__omni_test_";

/** Stable manual campaign used for live ChatGPT retest — never a test marker. */
export const MANUAL_CHATGPT_CAMPAIGN_NAME = "ChatGPT live paid inventory";

/** Historical names created by older test:exchange:pg runs (unprefixed). */
const LEGACY_TEST_CAMPAIGN_NAMES = new Set([
  "PG Direct Pilot",
  "Seed Sponsor",
  "Race Budget",
]);

export function isOmniTestMode(): boolean {
  return process.env.OMNI_TEST_MODE === "true";
}

export function isOmniTestCampaignName(name: string): boolean {
  const n = name.trim();
  return n.startsWith(OMNI_TEST_CAMPAIGN_PREFIX) || LEGACY_TEST_CAMPAIGN_NAMES.has(n);
}

export function omniTestCampaignName(runId: string, label: string): string {
  const safe = label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  return `${OMNI_TEST_CAMPAIGN_PREFIX}${runId}_${safe}`;
}

export function assertOmniTestMode(): void {
  if (!isOmniTestMode()) {
    throw new Error(
      "Refusing campaign mutation: OMNI_TEST_MODE must be true for automated tests.",
    );
  }
}

export function assertSafeToMutateCampaign(name: string, id: string): void {
  assertOmniTestMode();
  if (!isOmniTestCampaignName(name)) {
    throw new Error(
      `Refusing to mutate non-test campaign ${id} (${name}). Automated tests may only touch ${OMNI_TEST_CAMPAIGN_PREFIX}* records.`,
    );
  }
}

export async function pauseTestCampaignsById(ids: string[]): Promise<void> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return;
  assertOmniTestMode();
  const sb = getServiceSupabase();
  const { data, error } = await sb
    .from("campaigns")
    .select("id, name")
    .in("id", unique);
  if (error) throw new Error(error.message);
  const found = data ?? [];
  if (found.length !== unique.length) {
    throw new Error("Refusing pause: one or more campaign ids were not found.");
  }
  for (const row of found) {
    assertSafeToMutateCampaign(String(row.name), String(row.id));
  }
  const { error: updErr } = await sb
    .from("campaigns")
    .update({ status: "paused" })
    .in(
      "id",
      found.map((r) => r.id as string),
    );
  if (updErr) throw new Error(updErr.message);
}

/** Pause leftover automated-test campaigns only. Never touches manual names. */
export async function pauseLeftoverTestCampaigns(): Promise<number> {
  assertOmniTestMode();
  const sb = getServiceSupabase();
  const { data, error } = await sb
    .from("campaigns")
    .select("id, name")
    .eq("status", "active");
  if (error) throw new Error(error.message);
  const ids = (data ?? [])
    .filter((row) => isOmniTestCampaignName(String(row.name)))
    .map((row) => row.id as string);
  await pauseTestCampaignsById(ids);
  return ids.length;
}
