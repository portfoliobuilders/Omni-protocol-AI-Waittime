/**
 * Supabase service-role client — SERVER ONLY.
 * Never import this module from extension / client bundles.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getSupabaseUrl(): string {
  const url = process.env.SUPABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "SUPABASE_URL is required for Exchange settlement. SQLite is no longer the money runtime.",
    );
  }
  return url.replace(/\/$/, "");
}

export function getServiceRoleKey(): string {
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SECRET_KEY?.trim();
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required server-side. Never put this in the extension.",
    );
  }
  return key;
}

/** True when Postgres Exchange can run. */
export function isPostgresExchangeConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL?.trim() &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
        process.env.SUPABASE_SECRET_KEY?.trim()),
  );
}

/** Fail fast at process start — SQLite is not an Exchange money fallback. */
export function assertPostgresExchangeReady(): void {
  if (!isPostgresExchangeConfigured()) {
    throw new Error(
      "Omni Exchange requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. " +
        "SQLite settlement has been removed from the production runtime path.",
    );
  }
  // Touch client construction early so bad keys fail at boot.
  getServiceSupabase();
}

/**
 * Service-role client bypasses RLS — use only behind trusted API routes.
 * Do NOT expose settle_impression to browsers.
 */
export function getServiceSupabase(): SupabaseClient {
  if (client) return client;
  client = createClient(getSupabaseUrl(), getServiceRoleKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return client;
}

/** Publishable/anon key for RLS probes only (never for settlement). */
export function getAnonSupabase(): SupabaseClient {
  const url = getSupabaseUrl();
  const anon =
    process.env.SUPABASE_PUBLISHABLE_KEY?.trim() ||
    process.env.SUPABASE_ANON_KEY?.trim();
  if (!anon) {
    throw new Error("SUPABASE_PUBLISHABLE_KEY required for anon RLS probes.");
  }
  return createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
