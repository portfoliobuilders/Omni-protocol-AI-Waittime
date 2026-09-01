/**
 * Session-start path used by the Chrome extension.
 * Unit cases always run. HTTP/Postgres cases require a running backend + local Supabase.
 *
 * Run: npm run test:session
 */
import assert from "node:assert/strict";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeInventoryPlatform,
  lookupInventoryPlatform,
} from "../src/exchange/platforms.ts";
import {
  classifySupabaseFailure,
  clientSafeExchangeMessage,
} from "../src/exchange/errors.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const BASE_URL = (process.env.SMOKE_URL ?? "http://localhost:3001").replace(
  /\/$/,
  "",
);

let failures = 0;
function pass(label: string, detail?: string): void {
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}
function fail(label: string, detail: string): void {
  failures += 1;
  console.log(`FAIL  ${label} — ${detail}`);
}

async function request(
  method: string,
  pathName: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}${pathName}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

function jsonHasSecretLeak(json: Record<string, unknown>): boolean {
  const blob = JSON.stringify(json).toLowerCase();
  return (
    blob.includes("service_role") ||
    blob.includes("eyj") ||
    blob.includes("create table") ||
    blob.includes("password")
  );
}

async function main(): Promise<void> {
  console.log("\nSession-start tests\n");

  {
    assert.equal(canonicalizeInventoryPlatform("chatgpt.com"), "chatgpt.com");
    assert.equal(canonicalizeInventoryPlatform("chatgpt"), "chatgpt.com");
    assert.equal(canonicalizeInventoryPlatform("ChatGPT.COM"), "chatgpt.com");
    assert.equal(canonicalizeInventoryPlatform("claude.ai"), "claude.ai");
    assert.equal(canonicalizeInventoryPlatform("not-a-site"), null);
    assert.equal(canonicalizeInventoryPlatform(""), null);
    assert.equal(canonicalizeInventoryPlatform(12), null);
    assert.equal(lookupInventoryPlatform("chatgpt")?.adapterId, "chatgpt");
    pass("1. platform canonicalize chatgpt.com / chatgpt → chatgpt.com");
  }

  {
    const err = classifySupabaseFailure(
      "profile",
      new Error("TypeError: fetch failed"),
    );
    assert.equal(err.code, "SUPABASE_UNAVAILABLE");
    const constraint = classifySupabaseFailure("wait_session", {
      message: "duplicate key",
      code: "23505",
      details: "Key (server_nonce)=(x) already exists.",
    });
    assert.equal(constraint.code, "DB_CONSTRAINT_ERROR");
    const safe = clientSafeExchangeMessage("SUPABASE_UNAVAILABLE");
    assert.equal(safe.includes("fetch"), false);
    assert.equal(safe.toLowerCase().includes("password"), false);
    pass("2. classify fetch failed → SUPABASE_UNAVAILABLE; no secret in client copy");
  }

  let backendUp = false;
  try {
    const health = await request("GET", "/health");
    backendUp = health.status === 200;
  } catch {
    backendUp = false;
  }
  if (!backendUp) {
    fail("3. GET /health", `backend not reachable at ${BASE_URL}`);
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  pass("3. GET /health");

  {
    const { status, json } = await request("POST", "/api/v1/session/start", {
      userId: `sess_test_${Date.now()}`,
      platform: "not-a-real-platform",
    });
    if (
      status === 400 &&
      json.code === "INVALID_PLATFORM" &&
      json.error === "session_start_failed" &&
      !jsonHasSecretLeak(json)
    ) {
      pass("4. invalid platform → 400 INVALID_PLATFORM");
    } else {
      fail("4. invalid platform", `${status} ${JSON.stringify(json)}`);
    }
  }

  {
    const { status, json } = await request("POST", "/api/v1/session/start", {
      platform: "chatgpt.com",
    });
    if (status === 400 && json.code === "INVALID_USER_ID" && !jsonHasSecretLeak(json)) {
      pass("5. missing userId → 400 INVALID_USER_ID");
    } else {
      fail("5. missing userId", `${status} ${JSON.stringify(json)}`);
    }
  }

  {
    const { status, json } = await request("POST", "/api/v1/session/start", {
      userId: "x".repeat(200),
      platform: "chatgpt.com",
    });
    if (status === 400 && json.code === "INVALID_USER_ID" && !jsonHasSecretLeak(json)) {
      pass("6. oversized userId → 400 INVALID_USER_ID");
    } else {
      fail("6. oversized userId", `${status} ${JSON.stringify(json)}`);
    }
  }

  const userId = crypto.randomUUID();
  let firstId: string | undefined;
  {
    const { status, json } = await request("POST", "/api/v1/session/start", {
      userId,
      platform: "chatgpt.com",
    });
    const data = (json.data ?? {}) as { waitSessionId?: string; platform?: string };
    if (
      status === 200 &&
      json.success === true &&
      typeof data.waitSessionId === "string" &&
      data.platform === "chatgpt.com"
    ) {
      firstId = data.waitSessionId;
      pass("7. valid ChatGPT hostname → session created", data.waitSessionId);
    } else if (status === 503 && json.code === "SUPABASE_UNAVAILABLE") {
      fail(
        "7. valid ChatGPT session",
        "SUPABASE_UNAVAILABLE — start local Supabase (npx supabase start)",
      );
    } else {
      fail("7. valid ChatGPT session", `${status} ${JSON.stringify(json)}`);
    }
  }

  {
    const { status, json } = await request("POST", "/api/v1/session/start", {
      userId: crypto.randomUUID(),
      platform: "chatgpt",
    });
    const data = (json.data ?? {}) as { platform?: string };
    if (status === 200 && data.platform === "chatgpt.com") {
      pass("8. adapter id chatgpt → stored as chatgpt.com");
    } else if (status === 503 && json.code === "SUPABASE_UNAVAILABLE") {
      fail("8. adapter id chatgpt", "SUPABASE_UNAVAILABLE");
    } else {
      fail("8. adapter id chatgpt", `${status} ${JSON.stringify(json)}`);
    }
  }

  {
    const { status, json } = await request("POST", "/api/v1/session/start", {
      userId,
      platform: "chatgpt.com",
    });
    const data = (json.data ?? {}) as { waitSessionId?: string };
    if (
      status === 200 &&
      typeof data.waitSessionId === "string" &&
      data.waitSessionId !== firstId
    ) {
      pass("9. second independent wait for same user → new session");
    } else if (status === 503 && json.code === "SUPABASE_UNAVAILABLE") {
      fail("9. second wait", "SUPABASE_UNAVAILABLE");
    } else {
      fail("9. second wait", `${status} ${JSON.stringify(json)}`);
    }
  }

  console.log(`\n${failures} failure(s)`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
