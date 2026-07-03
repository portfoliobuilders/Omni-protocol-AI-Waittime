import cors from "cors";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  applyYield,
  consumeClaimSession,
  createClaimSession,
  DuplicateTransactionError,
  getBalance,
  getLedgerStats,
  getNextSurveyQuestion,
  getRecentTransactions,
  getSurveyResults,
  getTransactions,
  recordSurveyResponse,
} from "./db";

dotenv.config();

// Changed fallback port from 3000 to 3001 to bypass the blocked port issue
const PORT = Number(process.env.PORT ?? 3001);
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

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    service: "omni-backend-core",
    timestamp: new Date().toISOString(),
  });
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

app.get("/api/v1/admin/stats", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: getLedgerStats(),
  });
});

app.get("/api/v1/admin/surveys", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: { results: getSurveyResults() },
  });
});

app.get("/api/v1/admin/transactions", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: { transactions: getRecentTransactions(20) },
  });
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
    <button id="refreshBtn" type="button">Refresh</button>
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
    async function loadDashboard() {
      var btn = document.getElementById("refreshBtn");
      btn.disabled = true;
      hideError();
      try {
        var responses = await Promise.all([
          fetch("/api/v1/admin/stats"),
          fetch("/api/v1/admin/surveys"),
          fetch("/api/v1/admin/transactions"),
        ]);
        if (!responses[0].ok || !responses[1].ok || !responses[2].ok) {
          throw new Error("One or more API requests failed.");
        }
        var statsJson = await responses[0].json();
        var surveysJson = await responses[1].json();
        var txJson = await responses[2].json();
        if (!statsJson.success || !surveysJson.success || !txJson.success) {
          throw new Error("API returned an error response.");
        }
        renderStats(statsJson.data);
        renderSurveys(surveysJson.data.results);
        renderTransactions(txJson.data.transactions);
      } catch (err) {
        showError(err instanceof Error ? err.message : "Failed to load dashboard data.");
      } finally {
        btn.disabled = false;
      }
    }
    document.getElementById("refreshBtn").addEventListener("click", loadDashboard);
    loadDashboard();
  </script>
</body>
</html>`;

app.get("/admin", (_req: Request, res: Response) => {
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

app.listen(PORT, () => {
  console.info(`[Omni Backend] Server listening on http://localhost:${PORT}`);
  console.info(`[Omni Backend] Yield endpoint: POST http://localhost:${PORT}/api/v1/yield`);
});