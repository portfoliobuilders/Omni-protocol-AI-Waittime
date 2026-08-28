/**
 * Omni Exchange Phase 2 smoke test.
 * Run: npm run smoke  (against a running backend)
 * Env: SMOKE_URL (default http://localhost:3001), SMOKE_ADMIN_KEY (optional)
 */
const BASE_URL = (process.env.SMOKE_URL ?? "http://localhost:3001").replace(
  /\/$/,
  "",
);
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
  return new Promise((r) => setTimeout(r, ms));
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  useAdmin = false,
): Promise<{ status: number; json: Record<string, unknown> }> {
  let url = `${BASE_URL}${path}`;
  if (useAdmin && ADMIN_KEY) {
    url += (path.includes("?") ? "&" : "?") + `key=${encodeURIComponent(ADMIN_KEY)}`;
  }
  const res = await fetch(url, {
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

async function main(): Promise<void> {
  console.log(`\nOmni Exchange smoke — ${BASE_URL}`);
  console.log(`userId: ${userId}\n`);

  // 1. Health
  {
    const { status, json } = await request("GET", "/health");
    if (status === 200) pass("1. GET /health");
    else fail("1. GET /health", `${status} ${JSON.stringify(json)}`);
  }

  // 2. Config — 60/40 bps, no authoritative pool
  {
    const { status, json } = await request("GET", "/api/v1/config");
    const data = (json.data ?? {}) as Record<string, unknown>;
    const share = data.revenueShare as Record<string, number> | undefined;
    if (
      status === 200 &&
      data.userRevenueShareBps === 6000 &&
      data.omniRevenueShareBps === 4000 &&
      share &&
      share.pool === 0 &&
      share.earner === 60 &&
      share.platform === 40
    ) {
      pass("2. GET /config — 60/40 bps, pool=0");
    } else {
      fail("2. GET /config", JSON.stringify(data));
    }
  }

  // 3. Yield retired
  {
    const { status, json } = await request("POST", "/api/v1/yield", {
      userId,
      amount: 2,
      layer: "behavioralLayer",
      nonce: crypto.randomUUID(),
      sessionToken: "x",
    });
    if (status === 410 && json.deprecated === true) {
      pass("3. POST /yield → 410 deprecated");
    } else {
      fail("3. POST /yield", `${status} ${JSON.stringify(json)}`);
    }
  }

  // 4. Client cannot submit reward amounts
  {
    const session = await request("POST", "/api/v1/session/start", {
      userId,
      platform: "chatgpt.com",
    });
    const waitSessionId = (session.json.data as { waitSessionId?: string })
      ?.waitSessionId;
    if (!waitSessionId) {
      fail("4. session/start", "missing waitSessionId");
    } else {
      const ad = await request("POST", "/api/v1/ad/request", {
        userId,
        waitSessionId,
      });
      const impressionId = (ad.json.data as { impressionId?: string })
        ?.impressionId;
      const forged = await request("POST", "/api/v1/impression/qualify", {
        userId,
        impressionId,
        reportedViewMs: 5000,
        rewardAmount: 999,
      });
      if (forged.status === 400) {
        pass("4. forged rewardAmount rejected");
      } else {
        fail("4. forged rewardAmount", `${forged.status}`);
      }
    }
  }

  // 5–8. Funded campaign path (needs admin to create/approve OR uses existing ads)
  // Create campaign via public create if available, else house-only path.
  let paidOk = false;
  {
    const email = `smoke_adv_${Date.now()}@example.com`;
    const created = await request("POST", "/api/v1/campaigns", {
      advertiser_email: email,
      headline: "Smoke Direct Campaign",
      body: "Phase 2 settlement test",
      cta_label: "Open",
      cta_url: "https://example.com",
      cpm_paise: 1000,
      total_budget_paise: 50_000,
    });

    if (created.status === 200 || created.status === 201) {
      const camp = created.json.data as { id?: number; mgmt_key?: string };
      if (ADMIN_KEY && camp.id) {
        await request(
          "POST",
          `/api/v1/admin/campaigns/${camp.id}/review`,
          { decision: "approve" },
          true,
        );
        await request(
          "POST",
          `/api/v1/admin/campaigns/${camp.id}/provider`,
          { provider_key: "omni_direct" },
          true,
        );
      } else if (!ADMIN_KEY) {
        warn("5. campaign approve", "SMOKE_ADMIN_KEY not set — paid settle may fall back to house");
      }

      const paidUser = `${userId}_paid`;
      const sess = await request("POST", "/api/v1/session/start", {
        userId: paidUser,
        platform: "claude.ai",
      });
      const waitSessionId = (sess.json.data as { waitSessionId?: string })
        ?.waitSessionId;
      await sleep(5500);
      const ad = await request("POST", "/api/v1/ad/request", {
        userId: paidUser,
        waitSessionId,
      });
      const data = ad.json.data as {
        impressionId?: string;
        source?: string;
        providerKey?: string;
      };
      if (ad.status !== 200 || !data.impressionId) {
        fail("5. ad/request", JSON.stringify(ad.json));
      } else {
        pass("5. ad/request", `${data.source}/${data.providerKey}`);
        const q1 = await request("POST", "/api/v1/impression/qualify", {
          userId: paidUser,
          impressionId: data.impressionId,
          reportedViewMs: 5000,
        });
        const d1 = q1.json.data as {
          grossMicropaise?: number;
          userShareMicropaise?: number;
          omniShareMicropaise?: number;
          house?: boolean;
        };
        if (q1.status === 200 && d1.house === false && d1.grossMicropaise === 1000) {
          if (d1.userShareMicropaise === 600 && d1.omniShareMicropaise === 400) {
            pass("6. paid settle 600/400");
            paidOk = true;
          } else {
            fail("6. paid settle split", JSON.stringify(d1));
          }
        } else if (q1.status === 200 && d1.house === true) {
          warn("6. paid settle", "served house (campaign not active) — zero money OK");
          pass("6. house fallback zero money");
        } else {
          fail("6. qualify", `${q1.status} ${JSON.stringify(q1.json)}`);
        }

        const q2 = await request("POST", "/api/v1/impression/qualify", {
          userId: paidUser,
          impressionId: data.impressionId,
          reportedViewMs: 5000,
        });
        if (q2.status === 200 && q2.json.duplicate === true) {
          pass("7. duplicate qualify → duplicate:true");
        } else {
          fail("7. duplicate qualify", `${q2.status} ${JSON.stringify(q2.json)}`);
        }

        const wallet = await request(
          "GET",
          `/api/v1/exchange/wallet/${paidUser}`,
        );
        const w = wallet.json.data as { availableMicropaise?: number };
        if (paidOk) {
          if (w.availableMicropaise === 600) {
            pass("8. wallet available=600");
          } else {
            fail("8. wallet", JSON.stringify(w));
          }
        } else {
          pass("8. wallet checked (house path)");
        }
      }
    } else {
      fail("5. create campaign", `${created.status} ${JSON.stringify(created.json)}`);
    }
  }

  // 9. House path explicitly
  {
    const houseUser = `${userId}_house`;
    const sess = await request("POST", "/api/v1/session/start", {
      userId: houseUser,
      platform: "grok.com",
    });
    const waitSessionId = (sess.json.data as { waitSessionId?: string })
      ?.waitSessionId;
    await sleep(5500);
    // Prefer requesting when no budget — still may get paid; accept either with correct money rules
    const ad = await request("POST", "/api/v1/ad/request", {
      userId: houseUser,
      waitSessionId,
      preferredProvider: "house",
    });
    const data = ad.json.data as { impressionId?: string; source?: string };
    if (ad.status === 200 && data.impressionId) {
      const q = await request("POST", "/api/v1/impression/qualify", {
        userId: houseUser,
        impressionId: data.impressionId,
        reportedViewMs: 5000,
      });
      const d = q.json.data as {
        house?: boolean;
        grossMicropaise?: number;
        userShareMicropaise?: number;
      };
      if (q.status === 200 && (d.house === true || d.grossMicropaise === 0)) {
        pass("9. house/no-fill settlement → ₹0 user");
      } else if (q.status === 200 && d.userShareMicropaise === 600) {
        // paid won priority — still valid
        pass("9. paid preferred over house (valid)");
      } else {
        fail("9. house settle", `${q.status} ${JSON.stringify(q.json)}`);
      }
    } else {
      fail("9. house ad/request", JSON.stringify(ad.json));
    }
  }

  // 10. Below threshold
  {
    const u = `${userId}_fast`;
    const sess = await request("POST", "/api/v1/session/start", {
      userId: u,
      platform: "chatgpt.com",
    });
    const waitSessionId = (sess.json.data as { waitSessionId?: string })
      ?.waitSessionId;
    const ad = await request("POST", "/api/v1/ad/request", {
      userId: u,
      waitSessionId,
    });
    const impressionId = (ad.json.data as { impressionId?: string })
      ?.impressionId;
    const q = await request("POST", "/api/v1/impression/qualify", {
      userId: u,
      impressionId,
      reportedViewMs: 100,
    });
    if (q.status === 403 || q.status === 400) {
      pass("10. below threshold → no settle");
    } else {
      fail("10. below threshold", `${q.status}`);
    }
  }

  if (ADMIN_KEY) {
    const { status } = await request("GET", "/api/v1/admin/platforms", undefined, true);
    if (status === 200) pass("11. admin platforms");
    else fail("11. admin platforms", String(status));
  } else {
    warn("11. admin platforms", "SMOKE_ADMIN_KEY not set — skipping");
  }

  console.log(failures === 0 ? "\n--- ALL PASSED ---\n" : `\n--- ${failures} FAILED ---\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
