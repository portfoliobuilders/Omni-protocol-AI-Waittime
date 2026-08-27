/**
 * SQLite → Supabase migration helper (Phase 1).
 *
 * Default: --dry-run (safe). Counts rows and prints a reconciliation summary.
 * Upload only with --execute AND SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 *
 * Usage:
 *   npx tsx scripts/migrate-sqlite-to-supabase.ts
 *   npx tsx scripts/migrate-sqlite-to-supabase.ts --execute
 *   OMNI_DB_PATH=./backend-core/omni-ledger.db npx tsx scripts/migrate-sqlite-to-supabase.ts
 *
 * Refuses verify-test.db / test-backup.db.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const FORBIDDEN_DB_NAMES = new Set(["verify-test.db", "test-backup.db"]);

type CountMap = Record<string, number | string>;

function parseArgs(argv: string[]): { execute: boolean; dbPath?: string } {
  let execute = false;
  let dbPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") execute = true;
    else if (a === "--dry-run") execute = false;
    else if (a === "--db" && argv[i + 1]) {
      dbPath = argv[++i];
    }
  }
  return { execute, dbPath };
}

function resolveDbPath(cliPath?: string): string {
  if (cliPath) return path.resolve(cliPath);
  if (process.env.OMNI_DB_PATH) return path.resolve(process.env.OMNI_DB_PATH);
  const candidates = [
    path.resolve(process.cwd(), "backend-core", "omni-ledger.db"),
    path.resolve(process.cwd(), "omni-ledger.db"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function assertAllowedDbFile(dbPath: string): void {
  const base = path.basename(dbPath).toLowerCase();
  if (FORBIDDEN_DB_NAMES.has(base)) {
    throw new Error(
      `Refusing to migrate test/backup database file: ${base}. Use the production omni-ledger.db path.`,
    );
  }
}

function tableCount(
  db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } },
  table: string,
): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as
      | { c: number }
      | undefined;
    return row?.c ?? 0;
  } catch {
    return -1; // table missing
  }
}

function listTables(db: {
  prepare: (sql: string) => { all: () => unknown[] };
}): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function sumColumn(
  db: { prepare: (sql: string) => { get: () => unknown } },
  table: string,
  column: string,
): number | null {
  try {
    const row = db
      .prepare(`SELECT COALESCE(SUM(${column}), 0) AS s FROM ${table}`)
      .get() as { s: number };
    return Number(row.s);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const { execute, dbPath: cliDb } = parseArgs(process.argv.slice(2));
  const dbPath = resolveDbPath(cliDb);
  assertAllowedDbFile(dbPath);

  console.log("=== OmniPiggy SQLite → Supabase migration ===");
  console.log(`Mode: ${execute ? "EXECUTE (upload)" : "DRY-RUN (default)"}`);
  console.log(`SQLite: ${dbPath}`);

  if (!fs.existsSync(dbPath)) {
    console.error(`Database file not found: ${dbPath}`);
    process.exit(1);
  }

  let Database: new (filename: string, options?: object) => {
    prepare: (sql: string) => {
      get: (...args: unknown[]) => unknown;
      all: (...args: unknown[]) => unknown[];
    };
    close: () => void;
  };
  try {
    Database = require("better-sqlite3");
  } catch {
    try {
      Database = require(
        path.join(process.cwd(), "backend-core", "node_modules", "better-sqlite3"),
      );
    } catch {
      console.error(
        "better-sqlite3 is required. Run from repo root after: cd backend-core && npm install",
      );
      process.exit(1);
    }
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const tables = listTables(db);
  console.log(`\nSQLite tables (${tables.length}): ${tables.join(", ")}`);

  const counts: CountMap = {
    users: tableCount(db, "users"),
    transactions: tableCount(db, "transactions"),
    claim_sessions: tableCount(db, "claim_sessions"),
    campaigns: tableCount(db, "campaigns"),
    advertisers: tableCount(db, "advertisers"),
    redemptions: tableCount(db, "redemptions"),
    revenue_events: tableCount(db, "revenue_events"),
    ad_events: tableCount(db, "ad_events"),
    ads: tableCount(db, "ads"),
    topup_requests: tableCount(db, "topup_requests"),
    partners: tableCount(db, "partners"),
  };

  console.log("\n--- Row counts (-1 = table missing) ---");
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k}: ${v}`);
  }

  const sumTxAmount = sumColumn(db, "transactions", "amount");
  const sumUserBalance = sumColumn(db, "users", "balance");
  const sumSpentPaise = sumColumn(db, "campaigns", "spent_paise");
  const sumBudgetPaise = sumColumn(db, "campaigns", "total_budget_paise");
  const sumGrossPaise = sumColumn(db, "revenue_events", "gross_paise");
  const sumEarnerPaise = sumColumn(db, "revenue_events", "earner_paise");
  const sumPoolPaise = sumColumn(db, "revenue_events", "pool_paise");
  const sumPlatformPaise = sumColumn(db, "revenue_events", "platform_paise");

  console.log("\n--- Reconciliation summary (SQLite source) ---");
  console.log(`  users.balance SUM:           ${sumUserBalance}`);
  console.log(`  transactions.amount SUM:     ${sumTxAmount}`);
  console.log(`  campaigns.spent_paise SUM:   ${sumSpentPaise}`);
  console.log(`  campaigns.total_budget SUM:  ${sumBudgetPaise}`);
  console.log(`  revenue_events.gross SUM:    ${sumGrossPaise}`);
  console.log(`  revenue_events.earner SUM:   ${sumEarnerPaise}`);
  console.log(`  revenue_events.pool SUM:     ${sumPoolPaise}`);
  console.log(`  revenue_events.platform SUM: ${sumPlatformPaise}`);

  if (
    sumGrossPaise != null &&
    sumEarnerPaise != null &&
    sumPoolPaise != null &&
    sumPlatformPaise != null
  ) {
    const parts = sumEarnerPaise + sumPoolPaise + sumPlatformPaise;
    console.log(
      `  revenue split check: earner+pool+platform (${parts}) === gross (${sumGrossPaise}) → ${
        parts === sumGrossPaise ? "OK" : "MISMATCH"
      }`,
    );
  }

  console.log("\n--- Target mapping notes (Phase 1) ---");
  console.log("  users          → profiles + wallets (micropaise conversion TODO)");
  console.log("  transactions   → ledger_entries");
  console.log("  campaigns      → campaigns (paise → micropaise × 1000)");
  console.log("  advertisers    → advertisers (+ advertiser_wallets)");
  console.log("  revenue_events → revenue_events (schema differs: user/omni shares)");
  console.log("  redemptions    → redemptions (status enum remap)");
  console.log("  claim_sessions / ads / partners → review before migrate");

  db.close();

  if (!execute) {
    console.log(
      "\nDry-run complete. No data uploaded. Re-run with --execute to attempt upload.",
    );
    return;
  }

  // ---- EXECUTE path ----
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error(
      "\nEXECUTE aborted: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.",
    );
    console.error("Never commit these values. Prefer a local .env loaded by your shell.");
    process.exit(1);
  }

  // Dynamic import so dry-run works without @supabase/supabase-js installed.
  let createClient: (u: string, k: string) => {
    from: (table: string) => {
      select: (
        cols: string,
        opts?: { count?: string; head?: boolean },
      ) => Promise<{ count: number | null; error: { message: string } | null }>;
    };
  };
  try {
    const mod = await import("@supabase/supabase-js");
    createClient = mod.createClient as typeof createClient;
  } catch {
    // Try resolving from backend-core if present
    try {
      const candidate = path.join(
        process.cwd(),
        "backend-core",
        "node_modules",
        "@supabase",
        "supabase-js",
        "dist",
        "module",
        "index.js",
      );
      const mod = await import(pathToFileURL(candidate).href);
      createClient = mod.createClient as typeof createClient;
    } catch {
      console.error(
        "\nEXECUTE aborted: @supabase/supabase-js is not installed.",
      );
      console.error(
        "TODO: npm install @supabase/supabase-js (server-only; never ship to extension).",
      );
      console.error(
        "TODO: implement batched inserts for profiles, wallets, campaigns, ledger_entries,",
      );
      console.error(
        "      revenue_events with paise→micropaise conversion and idempotency keys.",
      );
      process.exit(1);
    }
  }

  const supabase = createClient(url, key);

  // Smoke connectivity check only — full row upload is intentionally stubbed.
  console.log("\nConnecting to Supabase (service role)…");
  const { error } = await supabase
    .from("app_config")
    .select("key", { count: "exact", head: true });

  if (error) {
    console.error(`Supabase connectivity check failed: ${error.message}`);
    process.exit(1);
  }

  console.log("Connectivity OK (app_config reachable).");
  console.log(
    "\nTODO [execute upload]: map SQLite rows → Postgres tables with BIGINT micropaise,",
  );
  console.log(
    "  generate UUIDs, preserve idempotency, and print post-upload reconciliation.",
  );
  console.log(
    "Upload of business rows is NOT implemented in Phase 1 — dry-run counts are authoritative for now.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
