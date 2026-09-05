/**
 * Campaign surface matching — pure, so isolation can be tested without Postgres.
 *
 * Non-empty campaign_surfaces always restrict, even if targeting_mode was left
 * as all_enabled. specific + zero rows means nowhere.
 */
export function campaignAllowsInventorySurface(input: {
  targetingMode?: string | null;
  listedSurfaces: readonly string[];
  requestSurface: string;
}): boolean {
  const request = input.requestSurface.trim();
  if (!request) return false;
  const listed = input.listedSurfaces
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const explicit =
    input.targetingMode === "specific" || input.targetingMode === "all_enabled"
      ? input.targetingMode
      : listed.length === 0
        ? "all_enabled"
        : "specific";

  if (listed.length > 0) {
    return listed.includes(request);
  }
  if (explicit === "specific") return false;
  return true;
}
