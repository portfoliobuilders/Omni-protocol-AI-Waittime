import cors from "cors";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyYield,
  backupDatabase,
  consumeClaimSession,
  createClaimSession,
  DuplicateTransactionError,
  getActiveAd,
  getAdStats,
  getBalance,
  getLedgerStats,
  getNextSurveyQuestion,
  getRecentTransactions,
  getSurveyResults,
  getTransactions,
  recordAdEvent,
  recordSurveyResponse,
} from "./db";

dotenv.config();

// Changed fallback port from 3000 to 3001 to bypass the blocked port issue
const PORT = Number(process.env.PORT ?? 3001);
const ADMIN_KEY = process.env.OMNI_ADMIN_KEY;
const VALID_LAYERS = new Set([
  "activeAiLayer",
  "behavioralLayer",
  "passiveDepinLayer",
]);

type YieldLayer =
  | "activeAiLayer"
  | "behavioralLayer"
  | "passiveDepinLayer";

interface YieldRequestBody {
  userId?: unknown;
  amount?: unknown;
  layer?: unknown;
  nonce?: unknown;
  sessionToken?: unknown;
  surveyQuestionId?: unknown;
  surveyAnswer?: unknown;
}

interface SessionStartRequestBody {
  userId?: unknown;
}

interface AdEventRequestBody {
  adId?: unknown;
  userId?: unknown;
  event?: unknown;
}

interface YieldTransaction {
  userId: string;
  amount: number;
  layer: YieldLayer;
  nonce: string;
  sessionToken: string;
  surveyQuestionId?: number;
  surveyAnswer?: string;
  timestamp: string;
}

const app = express();

app.disable("x-powered-by");

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "16kb" }));

function parseUserId(userIdValue: unknown): string {
  const userId =
    typeof userIdValue === "string" ? userIdValue.trim() : "";

  if (!userId) {
    throw new ValidationError("userId is required and must be a non-empty string.");
  }

  if (userId.length > 128) {
    throw new ValidationError("userId must be 128 characters or fewer.");
  }

  return userId;
}

function parseYieldRequest(body: YieldRequestBody): YieldTransaction {
  const userId = parseUserId(body.userId);

  const amount =
    typeof body.amount === "number"
      ? body.amount
      : typeof body.amount === "string"
        ? Number(body.amount)
        : NaN;

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError("amount must be a positive number.");
  }

  if (amount > 1_000_000) {
    throw new ValidationError("amount exceeds the allowed maximum for this endpoint.");
  }

  const layer =
    typeof body.layer === "string" ? body.layer.trim() : "";

  if (!VALID_LAYERS.has(layer)) {
    throw new ValidationError(
      `layer must be one of: ${[...VALID_LAYERS].join(", ")}.`,
    );
  }

  const nonce =
    typeof body.nonce === "string" ? body.nonce.trim() : "";

  if (!nonce) {
    throw new ValidationError("nonce is required and must be a non-empty string.");
  }

  if (nonce.length > 128) {
    throw new ValidationError("nonce must be 128 characters or fewer.");
  }

  const sessionToken =
    typeof body.sessionToken === "string" ? body.sessionToken.trim() : "";

  if (!sessionToken) {
    throw new ValidationError(
      "sessionToken is required and must be a non-empty string.",
    );
  }

  const hasSurveyQuestionId = body.surveyQuestionId !== undefined;
  const hasSurveyAnswer = body.surveyAnswer !== undefined;

  if (hasSurveyQuestionId !== hasSurveyAnswer) {
    throw new ValidationError(
      "surveyQuestionId and surveyAnswer must be provided together.",
    );
  }

  const surveyQuestionId =
    typeof body.surveyQuestionId === "number" ? body.surveyQuestionId : NaN;
  const surveyAnswer =
    typeof body.surveyAnswer === "string" ? body.surveyAnswer.trim() : "";

  if (
    hasSurveyQuestionId &&
    (!Number.isInteger(surveyQuestionId) || surveyQuestionId <= 0)
  ) {
    throw new ValidationError("surveyQuestionId must be a positive integer.");
  }

  if (hasSurveyAnswer && !surveyAnswer) {
    throw new ValidationError(
      "surveyAnswer must be a non-empty string when provided.",
    );
  }

  return {
    userId,
    amount: Math.round(amount * 100) / 100,
    layer: layer as YieldLayer,
    nonce,
    sessionToken,
    ...(hasSurveyQuestionId ? { surveyQuestionId, surveyAnswer } : {}),
    timestamp: new Date().toISOString(),
  };
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function requireAdminKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!ADMIN_KEY) {
    next();
    return;
  }

  if (req.query.key === ADMIN_KEY) {
    next();
    return;
  }

  res.status(401).json({
    success: false,
    message: "Unauthorized",
  });
}

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    service: "omni-backend-core",
    timestamp: new Date().toISOString(),
  });
});

app.get("/privacy", (_req: Request, res: Response) => {
  res.status(200).type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OmniPiggy Privacy Policy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: #0f0f11;
      color: #e4e4e7;
      line-height: 1.6;
      padding: 2rem 1.25rem 3rem;
    }
    main { max-width: 42rem; margin: 0 auto; }
    h1 { font-size: 1.5rem; font-weight: 600; color: #fff; margin-bottom: 0.25rem; }
    .effective { font-size: 0.875rem; color: #71717a; margin-bottom: 2rem; }
    h2 { font-size: 1rem; font-weight: 600; color: #a1a1aa; margin: 1.5rem 0 0.5rem; }
    p, li { font-size: 0.9375rem; color: #d4d4d8; margin-bottom: 0.75rem; }
    ul { padding-left: 1.25rem; margin-bottom: 0.75rem; }
    a { color: #22c55e; }
  </style>
</head>
<body>
  <main>
    <h1>OmniPiggy Privacy Policy</h1>
    <p class="effective">Effective date: July 3, 2026</p>
    <p>OmniPiggy is a browser extension that rewards you during AI wait time. This policy explains what we collect and what we do not.</p>

    <h2>What we collect</h2>
    <ul>
      <li>A random anonymous install ID generated on your device (stored locally and sent with API requests).</li>
      <li>Claim transactions (amount, layer, timestamp, and a unique nonce to prevent duplicates).</li>
      <li>Survey answers you choose to submit during wait-time prompts.</li>
      <li>Ad impression and click counts when you interact with optional ads.</li>
    </ul>

    <h2>What we do not collect</h2>
    <ul>
      <li>Your name, email address, or other personal identity information.</li>
      <li>Your browsing history outside supported AI chat pages.</li>
      <li>Any content of your AI conversations. The extension only detects loading states on ChatGPT and Claude — it never reads your chats.</li>
    </ul>

    <h2>Where data lives</h2>
    <p>Data is stored on our server (hosted on Railway). It is used to track your wallet balance, prevent duplicate claims, and improve the service.</p>

    <h2>Your rights</h2>
    <p>You may contact us to request deletion of your data. Uninstalling the extension stops all further collection from your browser.</p>

    <h2>Contact</h2>
    <p>Questions or deletion requests: <a href="mailto:contact@portfoliobuilders.in">contact@portfoliobuilders.in</a></p>
  </main>
</body>
</html>`);
});

app.post("/api/v1/session/start", (req: Request, res: Response) => {
  try {
    const userId = parseUserId((req.body as SessionStartRequestBody).userId);
    const sessionToken = createClaimSession(userId);

    res.status(200).json({
      success: true,
      data: { sessionToken },
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }

    console.error("[Omni Session] Unexpected error", error);
    res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

app.get("/api/v1/survey/next/:userId", (req: Request, res: Response) => {
  try {
    const userId = parseUserId(req.params.userId);
    const question = getNextSurveyQuestion(userId);

    res.status(200).json({
      success: true,
      data: { question },
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }

    console.error("[Omni Survey] Unexpected error", error);
    res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

app.post("/api/v1/yield", (req: Request, res: Response) => {
  try {
    const transaction = parseYieldRequest(req.body as YieldRequestBody);

    const sessionResult = consumeClaimSession(
      transaction.sessionToken,
      transaction.userId,
      5,
    );

    if (!sessionResult.ok) {
      if (sessionResult.reason === "invalid") {
        res.status(403).json({
          success: false,
          message: "Invalid or already used session.",
        });
        return;
      }

      res.status(403).json({
        success: false,
        message: "Wait period not satisfied.",
      });
      return;
    }

    if (
      transaction.surveyQuestionId !== undefined &&
      transaction.surveyAnswer !== undefined
    ) {
      const surveyResult = recordSurveyResponse(
        transaction.userId,
        transaction.surveyQuestionId,
        transaction.surveyAnswer,
      );

      if (!surveyResult.ok) {
        res.status(400).json({
          success: false,
          message:
            surveyResult.reason === "already_answered"
              ? "Survey question has already been answered."
              : "Survey response is invalid.",
        });
        return;
      }
    }

    const previousBalance = getBalance(transaction.userId);
    const updatedBalance = applyYield({
      userId: transaction.userId,
      amount: transaction.amount,
      layer: transaction.layer,
      nonce: transaction.nonce,
    });

    console.info("[Omni Yield] Transaction accepted", {
      ...transaction,
      previousBalance,
      updatedBalance,
    });

    res.status(200).json({
      success: true,
      message: "Yield transaction processed successfully.",
      data: {
        userId: transaction.userId,
        creditedAmount: transaction.amount,
        layer: transaction.layer,
        previousBalance,
        updatedBalance,
        processedAt: transaction.timestamp,
      },
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }

    if (error instanceof DuplicateTransactionError) {
      res.status(200).json({
        success: true,
        duplicate: true,
        message: error.message,
      });
      return;
    }

    console.error("[Omni Yield] Unexpected error", error);
    res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

app.get("/api/v1/balance/:userId", (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: {
      userId: req.params.userId,
      balance: getBalance(req.params.userId),
    },
  });
});

app.get("/api/v1/transactions/:userId", (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  res.status(200).json({
    success: true,
    data: {
      userId: req.params.userId,
      transactions: getTransactions(req.params.userId, limit),
    },
  });
});

app.get("/api/v1/ad/next", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: { ad: getActiveAd() },
  });
});

app.post("/api/v1/ad/event", (req: Request, res: Response) => {
  try {
    const body = req.body as AdEventRequestBody;

    const adId =
      typeof body.adId === "number"
        ? body.adId
        : typeof body.adId === "string"
          ? Number(body.adId)
          : NaN;

    if (!Number.isInteger(adId) || adId <= 0) {
      throw new ValidationError("adId must be a positive integer.");
    }

    const userId = parseUserId(body.userId);

    const event =
      typeof body.event === "string" ? body.event.trim() : "";

    if (event !== "impression" && event !== "click") {
      throw new ValidationError("event must be 'impression' or 'click'.");
    }

    const result = recordAdEvent(adId, userId, event);

    if (!result.ok) {
      res.status(400).json({
        success: false,
        message: "Invalid ad event.",
      });
      return;
    }

    res.status(200).json({ success: true });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }

    console.error("[Omni Ad] Unexpected error", error);
    res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

app.get("/api/v1/admin/stats", requireAdminKey, (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: getLedgerStats(),
  });
});

app.get("/api/v1/admin/surveys", requireAdminKey, (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: { results: getSurveyResults() },
  });
});

app.get("/api/v1/admin/transactions", requireAdminKey, (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: { transactions: getRecentTransactions(20) },
  });
});

app.get("/api/v1/admin/ads", requireAdminKey, (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: getAdStats(),
  });
});

app.get("/api/v1/admin/backup", requireAdminKey, async (_req: Request, res: Response) => {
  const tempPath = path.join(os.tmpdir(), `omni-backup-${Date.now()}.db`);
  const downloadName = `omni-ledger-backup-${new Date().toISOString().slice(0, 10)}.db`;

  try {
    await backupDatabase(tempPath);
    res.download(tempPath, downloadName, (err) => {
      fs.unlink(tempPath, () => {});
      if (err && !res.headersSent) {
        console.error("[Omni Admin] Backup download error", err);
        res.status(500).json({
          success: false,
          message: "Internal server error.",
        });
      }
    });
  } catch (error) {
    fs.unlink(tempPath, () => {});
    console.error("[Omni Admin] Backup error", error);
    res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

const ADMIN_DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Omni Admin Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0c0c0e;
      color: #e4e4e7;
      min-height: 100vh;
      padding: 24px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
    }
    .header-actions {
      display: flex;
      gap: 8px;
    }
    h1 { font-size: 1.5rem; font-weight: 600; color: #fafafa; }
    h2 {
      font-size: 1.125rem;
      font-weight: 600;
      color: #fafafa;
      margin-bottom: 16px;
    }
    button {
      background: #22c55e;
      color: #0c0c0e;
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #16a34a; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error {
      background: #450a0a;
      color: #fca5a5;
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 16px;
      display: none;
    }
    .stats-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .stat-card {
      background: #141416;
      border-radius: 10px;
      padding: 20px;
      border: 1px solid #27272a;
    }
    .stat-label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #a1a1aa;
      margin-bottom: 8px;
    }
    .stat-value {
      font-size: 1.75rem;
      font-weight: 700;
      color: #22c55e;
    }
    .section { margin-bottom: 32px; }
    .survey-card {
      background: #141416;
      border-radius: 10px;
      padding: 20px;
      border: 1px solid #27272a;
      margin-bottom: 16px;
    }
    .survey-question {
      font-weight: 600;
      margin-bottom: 4px;
      color: #fafafa;
    }
    .survey-meta {
      font-size: 0.8125rem;
      color: #71717a;
      margin-bottom: 16px;
    }
    .bar-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }
    .bar-label {
      width: 140px;
      font-size: 0.8125rem;
      color: #d4d4d8;
      flex-shrink: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bar-track {
      flex: 1;
      height: 22px;
      background: #27272a;
      border-radius: 4px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      background: #22c55e;
      border-radius: 4px;
      min-width: 0;
      transition: width 0.3s ease;
    }
    .bar-count {
      width: 80px;
      font-size: 0.8125rem;
      color: #a1a1aa;
      text-align: right;
      flex-shrink: 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #141416;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid #27272a;
    }
    th, td {
      padding: 12px 16px;
      text-align: left;
      font-size: 0.875rem;
    }
    th {
      background: #1c1c1f;
      color: #a1a1aa;
      font-weight: 600;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    td { border-top: 1px solid #27272a; }
    .amount { color: #22c55e; font-weight: 600; }
    .empty { color: #71717a; font-style: italic; padding: 20px; text-align: center; }
  </style>
</head>
<body>
  <header>
    <h1>Omni Admin Dashboard</h1>
    <div class="header-actions">
      <button id="backupBtn" type="button">Download Backup</button>
      <button id="refreshBtn" type="button">Refresh</button>
    </div>
  </header>
  <div id="error" class="error"></div>
  <div class="stats-row" id="statsRow">
    <div class="stat-card"><div class="stat-label">Users</div><div class="stat-value" id="statUsers">—</div></div>
    <div class="stat-card"><div class="stat-label">Transactions</div><div class="stat-value" id="statTx">—</div></div>
    <div class="stat-card"><div class="stat-label">Total Paid Out</div><div class="stat-value" id="statPaid">—</div></div>
    <div class="stat-card"><div class="stat-label">Survey Responses</div><div class="stat-value" id="statSurvey">—</div></div>
  </div>
  <div class="section">
    <h2>Survey Results</h2>
    <div id="surveyResults"></div>
  </div>
  <div class="section">
    <h2>Ad Performance</h2>
    <div id="adStatsTable"></div>
  </div>
  <div class="section">
    <h2>Recent Transactions</h2>
    <div id="transactionsTable"></div>
  </div>
  <script>
    function esc(text) {
      var d = document.createElement("div");
      d.textContent = text;
      return d.innerHTML;
    }
    function fmtMoney(n) {
      return "$" + Number(n).toFixed(2);
    }
    function fmtTime(iso) {
      try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
    }
    function shortId(id) {
      return id.length > 8 ? id.slice(0, 8) + "…" : id;
    }
    function showError(msg) {
      var el = document.getElementById("error");
      el.textContent = msg;
      el.style.display = "block";
    }
    function hideError() {
      document.getElementById("error").style.display = "none";
    }
    function renderStats(data) {
      document.getElementById("statUsers").textContent = data.totalUsers;
      document.getElementById("statTx").textContent = data.totalTransactions;
      document.getElementById("statPaid").textContent = fmtMoney(data.totalPaidOut);
      document.getElementById("statSurvey").textContent = data.totalSurveyResponses;
    }
    function renderSurveys(results) {
      var container = document.getElementById("surveyResults");
      if (!results.length) {
        container.innerHTML = '<div class="empty">No survey questions yet.</div>';
        return;
      }
      container.innerHTML = results.map(function(q) {
        var maxCount = Math.max.apply(null, q.breakdown.map(function(b) { return b.count; }).concat([1]));
        var bars = q.breakdown.map(function(b) {
          var pct = (b.count / maxCount) * 100;
          return '<div class="bar-row">' +
            '<div class="bar-label" title="' + esc(b.answer) + '">' + esc(b.answer) + '</div>' +
            '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
            '<div class="bar-count">' + esc(b.answer) + ' — ' + b.count + '</div>' +
            '</div>';
        }).join("");
        return '<div class="survey-card">' +
          '<div class="survey-question">' + esc(q.question) + '</div>' +
          '<div class="survey-meta">' + q.totalResponses + ' response' + (q.totalResponses !== 1 ? 's' : '') +
          (q.active ? '' : ' · inactive') + '</div>' +
          bars + '</div>';
      }).join("");
    }
    function renderTransactions(transactions) {
      var container = document.getElementById("transactionsTable");
      if (!transactions.length) {
        container.innerHTML = '<div class="empty">No transactions yet.</div>';
        return;
      }
      var rows = transactions.map(function(tx) {
        return '<tr>' +
          '<td>' + esc(fmtTime(tx.created_at)) + '</td>' +
          '<td>' + esc(shortId(tx.user_id)) + '</td>' +
          '<td>' + esc(tx.layer) + '</td>' +
          '<td class="amount">+' + esc(fmtMoney(tx.amount)) + '</td>' +
          '</tr>';
      }).join("");
      container.innerHTML = '<table><thead><tr><th>Time</th><th>User</th><th>Layer</th><th>Amount</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    function renderAdStats(ads) {
      var container = document.getElementById("adStatsTable");
      if (!ads.length) {
        container.innerHTML = '<div class="empty">No ads yet.</div>';
        return;
      }
      var rows = ads.map(function(ad) {
        var ctr = ad.impressions > 0
          ? ((ad.clicks / ad.impressions) * 100).toFixed(1) + "%"
          : "0%";
        return '<tr>' +
          '<td>' + esc(ad.headline) + '</td>' +
          '<td>' + ad.impressions + '</td>' +
          '<td>' + ad.clicks + '</td>' +
          '<td>' + ctr + '</td>' +
          '</tr>';
      }).join("");
      container.innerHTML = '<table><thead><tr><th>Headline</th><th>Impressions</th><th>Clicks</th><th>CTR</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    function adminUrl(path) {
      var key = new URLSearchParams(window.location.search).get("key");
      return key ? path + "?key=" + encodeURIComponent(key) : path;
    }
    async function loadDashboard() {
      var btn = document.getElementById("refreshBtn");
      btn.disabled = true;
      hideError();
      try {
        var responses = await Promise.all([
          fetch(adminUrl("/api/v1/admin/stats")),
          fetch(adminUrl("/api/v1/admin/surveys")),
          fetch(adminUrl("/api/v1/admin/transactions")),
          fetch(adminUrl("/api/v1/admin/ads")),
        ]);
        if (!responses[0].ok || !responses[1].ok || !responses[2].ok || !responses[3].ok) {
          throw new Error("One or more API requests failed.");
        }
        var statsJson = await responses[0].json();
        var surveysJson = await responses[1].json();
        var txJson = await responses[2].json();
        var adsJson = await responses[3].json();
        if (!statsJson.success || !surveysJson.success || !txJson.success || !adsJson.success) {
          throw new Error("API returned an error response.");
        }
        renderStats(statsJson.data);
        renderSurveys(surveysJson.data.results);
        renderAdStats(adsJson.data);
        renderTransactions(txJson.data.transactions);
      } catch (err) {
        showError(err instanceof Error ? err.message : "Failed to load dashboard data.");
      } finally {
        btn.disabled = false;
      }
    }
    document.getElementById("backupBtn").addEventListener("click", function() {
      window.location.href = adminUrl("/api/v1/admin/backup");
    });
    document.getElementById("refreshBtn").addEventListener("click", loadDashboard);
    loadDashboard();
  </script>
</body>
</html>`;

app.get("/admin", requireAdminKey, (_req: Request, res: Response) => {
  res.status(200).type("html").send(ADMIN_DASHBOARD_HTML);
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: "Route not found.",
  });
});

app.use(
  (error: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof SyntaxError && "body" in error) {
      res.status(400).json({
        success: false,
        message: "Invalid JSON payload.",
      });
      return;
    }

    console.error("[Omni Yield] Unhandled middleware error", error);
    res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  },
);

app.listen(PORT, "0.0.0.0", () => {
  console.info(`[Omni Backend] Server listening on http://localhost:${PORT}`);
  console.info(`[Omni Backend] Yield endpoint: POST http://localhost:${PORT}/api/v1/yield`);
});