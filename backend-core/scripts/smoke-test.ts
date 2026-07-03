/**
 * Omni Protocol backend smoke test suite.
 * Run: npm run smoke
 * Env: SMOKE_URL (default http://localhost:3001), SMOKE_ADMIN_KEY (optional)
 */

const BASE_URL = (process.env.SMOKE_URL ?? "http://localhost:3001").replace(/\/$/, "");
const ADMIN_KEY = process.env.SMOKE_ADMIN_KEY?.trim() || "";

const userId = `smoke_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

let failures = 0;

function pass(label: string, detail?: string): void {
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label: string, detail: string): void {
  failures += 1;
  console.log(`FAIL  ${label} — ${detail}`);
}

function warn(label: string, detail: string): void {
  console.log(`WARN  ${label} — ${detail}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function adminUrl(path: string): string {
  if (!ADMIN_KEY) return `${BASE_URL}${path}`;
  const sep = path.includes("?") ? "&" : "?";
  return `${BASE_URL}${path}${sep}key=${encodeURIComponent(ADMIN_KEY)}`;
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  useAdmin = false,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = useAdmin ? adminUrl(path) : `${BASE_URL}${path}`;
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

async function getBalance(): Promise<number> {
  const { status, json } = await request("GET", `/api/v1/balance/${userId}`);
  if (status !== 200 || json.success !== true) {
    throw new Error(`balance fetch failed: ${status}`);
  }
  const data = json.data as { balance?: number };
  return Number(data.balance ?? 0);
}

async function startSession(partnerKey?: string): Promise<string> {
  const body: Record<string, string> = { userId };
  if (partnerKey) body.partnerKey = partnerKey;
  const { status, json } = await request("POST", "/api/v1/session/start", body);
  if (status !== 200 || json.success !== true) {
    throw new Error(`session/start failed: ${status} ${JSON.stringify(json)}`);
  }
  const data = json.data as { sessionToken?: string };
  if (!data.sessionToken) throw new Error("missing sessionToken");
  return data.sessionToken;
}

async function yieldClaim(opts: {
  sessionToken: string;
  nonce: string;
  surveyQuestionId?: number;
  surveyAnswer?: string;
  partnerKey?: string;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  const body: Record<string, unknown> = {
    userId,
    layer: "activeAiLayer",
    nonce: opts.nonce,
    sessionToken: opts.sessionToken,
  };
  if (opts.surveyQuestionId !== undefined) {
    body.surveyQuestionId = opts.surveyQuestionId;
    body.surveyAnswer = opts.surveyAnswer;
  }
  if (opts.partnerKey) body.partnerKey = opts.partnerKey;
  return request("POST", "/api/v1/yield", body);
}

async function checkHealth(): Promise<void> {
  const label = "1. GET /health";
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const json = (await res.json()) as { status?: string };
    if (res.status === 200 && json.status === "ok") {
      pass(label);
    } else {
      fail(label, `status=${res.status} body=${JSON.stringify(json)}`);
    }
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
  }
}

async function checkConfig(): Promise<void> {
  const label = "2. GET /api/v1/config (INR)";
  const { status, json } = await request("GET", "/api/v1/config");
  const data = json.data as Record<string, unknown> | undefined;
  if (
    status === 200 &&
    json.success === true &&
    data?.currency === "INR" &&
    data?.symbol === "₹"
  ) {
    pass(label);
  } else {
    fail(label, `status=${status} data=${JSON.stringify(data)}`);
  }
}

async function checkClaimCycle(): Promise<{
  sessionToken: string;
  nonce: string;
}> {
  const label = "3. Claim cycle: session → 6s wait → yield credits 2";
  try {
    const sessionToken = await startSession();
    await sleep(6000);
    const nonce = `nonce_${Date.now()}_a`;
    const before = await getBalance();
    const { status, json } = await yieldClaim({ sessionToken, nonce });
    const after = await getBalance();
    const data = json.data as { creditedAmount?: number } | undefined;
    if (
      status === 200 &&
      json.success === true &&
      data?.creditedAmount === 2 &&
      after === before + 2
    ) {
      pass(label, `balance=${after}`);
      return { sessionToken, nonce };
    }
    fail(
      label,
      `status=${status} credited=${data?.creditedAmount} balance ${before}→${after}`,
    );
    return { sessionToken, nonce };
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
    return { sessionToken: "", nonce: "" };
  }
}

async function checkNonceReplay(nonce: string): Promise<void> {
  const label = "4. Same-nonce replay → duplicate:true, balance unchanged";
  try {
    const sessionToken = await startSession();
    await sleep(6000);
    const before = await getBalance();
    const { status, json } = await yieldClaim({ sessionToken, nonce });
    const after = await getBalance();
    if (status === 200 && json.duplicate === true && after === before) {
      pass(label);
    } else {
      fail(
        label,
        `status=${status} duplicate=${String(json.duplicate)} balance ${before}→${after}`,
      );
    }
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
  }
}

async function checkTooFast(): Promise<void> {
  const label = "5. Immediate yield after fresh session → 403";
  try {
    const sessionToken = await startSession();
    const { status, json } = await yieldClaim({
      sessionToken,
      nonce: `nonce_${Date.now()}_fast`,
    });
    if (status === 403 && json.success === false) {
      pass(label);
    } else {
      fail(label, `status=${status} body=${JSON.stringify(json)}`);
    }
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
  }
}

async function checkReusedToken(usedToken: string): Promise<void> {
  const label = "6. Reused session token → 403 invalid";
  try {
    const { status, json } = await yieldClaim({
      sessionToken: usedToken,
      nonce: `nonce_${Date.now()}_reuse`,
    });
    const msg = typeof json.message === "string" ? json.message : "";
    if (status === 403 && json.success === false && msg.includes("session")) {
      pass(label);
    } else {
      fail(label, `status=${status} message=${msg}`);
    }
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
  }
}

async function checkSurvey(): Promise<void> {
  const label = "7. Survey flow";
  try {
    let questionId: number | undefined;
    let answer: string | undefined;

    const { status, json } = await request(
      "GET",
      `/api/v1/survey/next/${userId}`,
    );
    if (status !== 200 || json.success !== true) {
      fail(label, `survey/next status=${status}`);
      return;
    }
    const data = json.data as { question?: { id: number; options: string[] } | null };
    if (!data.question) {
      if (ADMIN_KEY) {
        const created = await request(
          "POST",
          "/api/v1/admin/surveys",
          {
            question: `Smoke test ${Date.now()}`,
            options: ["A", "B"],
          },
          true,
        );
        const createdData = created.json.data as { id?: number; options?: string[] };
        if (created.status === 201 && createdData.id) {
          await request(
            "PATCH",
            `/api/v1/admin/surveys/${createdData.id}/active`,
            { active: true },
            true,
          );
          const retry = await request("GET", `/api/v1/survey/next/${userId}`);
          const retryData = retry.json.data as {
            question?: { id: number; options: string[] };
          };
          if (retryData.question) {
            questionId = retryData.question.id;
            answer = retryData.question.options[0];
          }
        }
      }
      if (!questionId) {
        warn(label, "no survey question available — skipping credit/repeat checks");
        return;
      }
    } else {
      questionId = data.question.id;
      answer = data.question.options[0];
    }

    const sessionToken = await startSession();
    await sleep(16000);
    const before = await getBalance();
    const { status: yStatus, json: yJson } = await yieldClaim({
      sessionToken,
      nonce: `nonce_${Date.now()}_survey`,
      surveyQuestionId: questionId,
      surveyAnswer: answer,
    });
    const after = await getBalance();
    const yData = yJson.data as { creditedAmount?: number } | undefined;
    if (
      yStatus !== 200 ||
      yJson.success !== true ||
      yData?.creditedAmount !== 10 ||
      after !== before + 10
    ) {
      fail(
        label,
        `survey yield status=${yStatus} credited=${yData?.creditedAmount} balance ${before}→${after}`,
      );
      return;
    }

    const sessionToken2 = await startSession();
    await sleep(16000);
    const { status: rStatus, json: rJson } = await yieldClaim({
      sessionToken: sessionToken2,
      nonce: `nonce_${Date.now()}_survey_repeat`,
      surveyQuestionId: questionId,
      surveyAnswer: answer,
    });
    if (rStatus === 400 && rJson.success === false) {
      pass(label, `credited 10, repeat → 400`);
    } else {
      fail(label, `repeat answer status=${rStatus} body=${JSON.stringify(rJson)}`);
    }
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
  }
}

async function checkAds(): Promise<void> {
  const label = "8. Ad next + events";
  try {
    const { status, json } = await request("GET", "/api/v1/ad/next");
    if (status !== 200 || json.success !== true) {
      fail(label, `ad/next status=${status}`);
      return;
    }
    const data = json.data as { ad?: { id: number } | null };
    if (!data.ad) {
      pass(label, "no active ad (null tolerated)");
      return;
    }
    const imp = await request("POST", "/api/v1/ad/event", {
      adId: data.ad.id,
      userId,
      event: "impression",
    });
    const clk = await request("POST", "/api/v1/ad/event", {
      adId: data.ad.id,
      userId,
      event: "click",
    });
    if (imp.status === 200 && imp.json.success === true && clk.status === 200 && clk.json.success === true) {
      pass(label, `ad id=${data.ad.id}`);
    } else {
      fail(label, `imp=${imp.status} click=${clk.status}`);
    }
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
  }
}

async function checkRedemption(): Promise<void> {
  const label = "9. Redemption below minimum";
  try {
    const { status, json } = await request("POST", "/api/v1/redeem", {
      userId,
      method: "upi",
      detail: "smoke@example.com",
    });
    if (status === 400 && json.reason === "below_minimum") {
      pass(label);
    } else {
      fail(label, `status=${status} body=${JSON.stringify(json)}`);
      return;
    }

    if (!ADMIN_KEY) {
      warn("9b. Admin redemptions", "SMOKE_ADMIN_KEY not set — skipping");
      return;
    }

    const adminLabel = "9b. GET /api/v1/admin/redemptions";
    const { status: aStatus, json: aJson } = await request(
      "GET",
      "/api/v1/admin/redemptions",
      undefined,
      true,
    );
    if (aStatus === 200 && aJson.success === true) {
      pass(adminLabel);
    } else {
      fail(adminLabel, `status=${aStatus}`);
    }
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
  }
}

async function checkAdminEndpoints(): Promise<void> {
  const label = "10. Admin endpoints";
  if (!ADMIN_KEY) {
    warn(label, "SMOKE_ADMIN_KEY not set — skipping");
    return;
  }
  const paths = [
    "/api/v1/admin/stats",
    "/api/v1/admin/surveys",
    "/api/v1/admin/ads",
    "/api/v1/admin/partners",
    "/api/v1/admin/transactions",
  ];
  for (const path of paths) {
    const { status, json } = await request("GET", path, undefined, true);
    if (status === 200 && json.success === true) {
      pass(`10. ${path}`);
    } else {
      fail(`10. ${path}`, `status=${status}`);
    }
  }
}

async function checkPartnerFlow(): Promise<void> {
  const label = "11. Partner attributed claim cycle";
  if (!ADMIN_KEY) {
    warn(label, "SMOKE_ADMIN_KEY not set — skipping");
    return;
  }
  try {
    const partnerName = `Smoke Partner ${Date.now()}`;
    const created = await request(
      "POST",
      "/api/v1/admin/partners",
      { name: partnerName },
      true,
    );
    const partner = created.json.data as {
      id?: number;
      partner_key?: string;
    };
    if (created.status !== 201 || !partner.id || !partner.partner_key) {
      fail(label, `create partner status=${created.status}`);
      return;
    }

    const sessionToken = await startSession(partner.partner_key);
    await sleep(6000);
    const { status, json } = await yieldClaim({
      sessionToken,
      nonce: `nonce_${Date.now()}_partner`,
      partnerKey: partner.partner_key,
    });
    if (status !== 200 || json.success !== true) {
      fail(label, `partner yield status=${status}`);
      return;
    }

    const statsRes = await request("GET", "/api/v1/admin/partners", undefined, true);
    const stats = statsRes.json.data as Array<{
      id: number;
      transactions: number;
    }>;
    const row = Array.isArray(stats)
      ? stats.find((p) => p.id === partner.id)
      : undefined;
    if (!row || row.transactions < 1) {
      fail(label, `partner not in stats or transactions=0`);
      return;
    }

    await request(
      "PATCH",
      `/api/v1/admin/partners/${partner.id}/active`,
      { active: false },
      true,
    );
    pass(label, `partner id=${partner.id} transactions=${row.transactions}`);
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
  }
}

async function checkResetLedgerBlocked(): Promise<void> {
  const label = "12. reset-ledger blocked without admin key";
  const { status } = await request("POST", "/api/v1/admin/reset-ledger", {});
  if (status === 403 || status === 401) {
    pass(label, `status=${status}`);
  } else {
    fail(label, `expected 403/401, got ${status}`);
  }
}

async function main(): Promise<void> {
  console.log(`\nOmni smoke test — ${BASE_URL}`);
  console.log(`userId: ${userId}`);
  console.log(`admin key: ${ADMIN_KEY ? "(set)" : "(not set)"}\n`);

  await checkHealth();
  await checkConfig();
  const { sessionToken, nonce } = await checkClaimCycle();
  await checkNonceReplay(nonce);
  await checkTooFast();
  if (sessionToken) await checkReusedToken(sessionToken);
  await checkSurvey();
  await checkAds();
  await checkRedemption();
  await checkAdminEndpoints();
  await checkPartnerFlow();
  await checkResetLedgerBlocked();

  console.log(`\n--- ${failures === 0 ? "ALL PASSED" : `${failures} FAILED`} ---\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
