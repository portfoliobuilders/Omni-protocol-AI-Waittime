import cors from "cors";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addAd,
  addSurveyQuestion,
  applyYield,
  backupDatabase,
  consumeClaimSession,
  ContentValidationError,
  createClaimSession,
  createPartner,
  DuplicateTransactionError,
  getActiveAd,
  getAdStats,
  getBalance,
  getLedgerStats,
  getNextSurveyQuestion,
  getPartnerByKey,
  getPartnerStats,
  getRecentTransactions,
  getRedemptions,
  getSurveyResults,
  getTransactions,
  getUserRedemptions,
  recordAdEvent,
  recordSurveyResponse,
  requestRedemption,
  resetLedger,
  resolveRedemption,
  setAdActive,
  setPartnerActive,
  setSurveyQuestionActive,
} from "./db";

dotenv.config();

// Single source of truth for reward economics (INR).
const REWARD_ECONOMICS = {
  currency: "INR",
  symbol: "₹",
  tier2Amount: 2,
  tier3Amount: 10,
  minRedemption: 100,
  minWaitSeconds: 5,
  tier3Seconds: 15,
} as const;

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
  partnerKey?: unknown;
}

interface SessionStartRequestBody {
  userId?: unknown;
  partnerKey?: unknown;
}

interface AdEventRequestBody {
  adId?: unknown;
  userId?: unknown;
  event?: unknown;
}

interface RedeemRequestBody {
  userId?: unknown;
  method?: unknown;
  detail?: unknown;
}

interface ResolveRedemptionBody {
  status?: unknown;
}

interface YieldTransaction {
  userId: string;
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
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "16kb" }));

// In-memory POST rate limiter (resets on process restart; move to Redis at scale).
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_POSTS = 30;
const rateLimitByIp = new Map<string, number[]>();
const RATE_LIMITED_POST_PATHS = new Set([
  "/api/v1/session/start",
  "/api/v1/yield",
  "/api/v1/redeem",
  "/api/v1/ad/event",
]);

function postRateLimiter(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "POST") {
    next();
    return;
  }

  if (req.path.startsWith("/admin") || req.path.startsWith("/api/v1/admin")) {
    next();
    return;
  }

  if (!RATE_LIMITED_POST_PATHS.has(req.path)) {
    next();
    return;
  }

  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const recent = (rateLimitByIp.get(ip) ?? []).filter(
    (ts) => now - ts < RATE_LIMIT_WINDOW_MS,
  );

  if (recent.length >= RATE_LIMIT_MAX_POSTS) {
    res.status(429).json({
      success: false,
      message: "Too many requests. Please try again later.",
    });
    return;
  }

  recent.push(now);
  rateLimitByIp.set(ip, recent);
  next();
}

app.use(postRateLimiter);

type RouteHandler = (req: Request, res: Response) => void | Promise<void>;

function safeRoute(handler: RouteHandler): RouteHandler {
  return async (req, res) => {
    try {
      await handler(req, res);
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

      if (error instanceof ContentValidationError) {
        res.status(400).json({
          success: false,
          message: error.message,
        });
        return;
      }

      console.error("[Omni] Unexpected route error", error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: "Internal server error.",
        });
      }
    }
  };
}

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

function parseOptionalPartnerKey(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const partnerKey = typeof value === "string" ? value.trim() : "";

  if (!partnerKey) {
    return undefined;
  }

  if (partnerKey.length > 128) {
    throw new ValidationError("partnerKey must be 128 characters or fewer.");
  }

  return partnerKey;
}

function resolvePartnerId(
  partnerKey: string | undefined,
  res: Response,
): number | undefined | null {
  if (!partnerKey) {
    return undefined;
  }

  const partner = getPartnerByKey(partnerKey);

  if (!partner) {
    res.status(403).json({
      success: false,
      message: "Invalid partner key",
    });
    return null;
  }

  return partner.id;
}

function parseYieldRequest(body: YieldRequestBody): YieldTransaction {
  const userId = parseUserId(body.userId);

  if (body.amount !== undefined) {
    const amount =
      typeof body.amount === "number"
        ? body.amount
        : typeof body.amount === "string"
          ? Number(body.amount)
          : NaN;

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ValidationError("amount must be a positive number.");
    }
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

  if (sessionToken.length > 128) {
    throw new ValidationError("sessionToken must be 128 characters or fewer.");
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

  if (hasSurveyAnswer && surveyAnswer.length > 256) {
    throw new ValidationError("surveyAnswer must be 256 characters or fewer.");
  }

  return {
    userId,
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

function resolveOmniSdkPath(): string | null {
  const candidates: string[] = [];

  if (process.env.OMNI_SDK_PATH) {
    candidates.push(path.resolve(process.env.OMNI_SDK_PATH));
  }

  candidates.push(
    path.resolve(__dirname, "../public/sdk/omni.min.js"),
    path.resolve(__dirname, "../../b2b-sdk/dist/omni.min.js"),
  );

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
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

/** Dangerous admin routes: always require OMNI_ADMIN_KEY; 403 when unset. */
function requireStrictAdminKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!ADMIN_KEY) {
    res.status(403).json({
      success: false,
      message: "Forbidden",
    });
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

app.get("/api/v1/config", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: { ...REWARD_ECONOMICS },
  });
});

app.get("/sdk/omni.min.js", (_req: Request, res: Response) => {
  const sdkPath = resolveOmniSdkPath();

  if (!sdkPath) {
    res.status(404).json({
      success: false,
      message: "SDK bundle not found.",
    });
    return;
  }

  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "max-age=3600");
  res.sendFile(sdkPath);
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
    const body = req.body as SessionStartRequestBody;
    const partnerKey = parseOptionalPartnerKey(body.partnerKey);
    const partnerId = resolvePartnerId(partnerKey, res);
    if (partnerId === null) {
      return;
    }

    const userId = parseUserId(body.userId);
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
    const partnerKey = parseOptionalPartnerKey(
      (req.body as YieldRequestBody).partnerKey,
    );
    const partnerId = resolvePartnerId(partnerKey, res);
    if (partnerId === null) {
      return;
    }

    const transaction = parseYieldRequest(req.body as YieldRequestBody);
    const isSurveyClaim =
      transaction.surveyQuestionId !== undefined &&
      transaction.surveyAnswer !== undefined;
    const creditedAmount = isSurveyClaim
      ? REWARD_ECONOMICS.tier3Amount
      : REWARD_ECONOMICS.tier2Amount;
    const minWaitSeconds = isSurveyClaim
      ? REWARD_ECONOMICS.tier3Seconds
      : REWARD_ECONOMICS.minWaitSeconds;

    const sessionResult = consumeClaimSession(
      transaction.sessionToken,
      transaction.userId,
      minWaitSeconds,
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
      amount: creditedAmount,
      layer: transaction.layer,
      nonce: transaction.nonce,
      ...(partnerId !== undefined ? { partnerId } : {}),
    });

    console.info("[Omni Yield] Transaction accepted", {
      ...transaction,
      creditedAmount,
      previousBalance,
      updatedBalance,
    });

    res.status(200).json({
      success: true,
      message: "Yield transaction processed successfully.",
      data: {
        userId: transaction.userId,
        creditedAmount,
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

app.get("/api/v1/balance/:userId", safeRoute((req, res) => {
  const userId = parseUserId(req.params.userId);
  res.status(200).json({
    success: true,
    data: {
      userId,
      balance: getBalance(userId),
    },
  });
}));

app.get("/api/v1/transactions/:userId", safeRoute((req, res) => {
  const userId = parseUserId(req.params.userId);
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  res.status(200).json({
    success: true,
    data: {
      userId,
      transactions: getTransactions(userId, limit),
    },
  });
}));

app.get("/api/v1/ad/next", safeRoute((_req, res) => {
  res.status(200).json({
    success: true,
    data: { ad: getActiveAd() },
  });
}));

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

app.post("/api/v1/redeem", (req: Request, res: Response) => {
  try {
    const body = req.body as RedeemRequestBody;
    const userId = parseUserId(body.userId);
    const method = parseRedemptionMethod(body.method);
    const detail = parseRedemptionDetail(method, body.detail);

    const result = requestRedemption(
      userId,
      method,
      detail,
      REWARD_ECONOMICS.minRedemption,
    );

    if (!result.ok) {
      if (result.reason === "below_minimum") {
        res.status(400).json({
          success: false,
          reason: "below_minimum",
          message: `Balance is below the minimum redemption amount (${REWARD_ECONOMICS.symbol}${REWARD_ECONOMICS.minRedemption}).`,
        });
        return;
      }

      res.status(400).json({
        success: false,
        reason: "already_pending",
        message: "You already have a pending redemption request.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: { amount: result.amount },
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }

    console.error("[Omni Redeem] Unexpected error", error);
    res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

app.get("/api/v1/redemptions/:userId", (req: Request, res: Response) => {
  try {
    const userId = parseUserId(req.params.userId);
    res.status(200).json({
      success: true,
      data: { redemptions: getUserRedemptions(userId) },
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }

    console.error("[Omni Redemptions] Unexpected error", error);
    res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

app.get("/api/v1/admin/stats", requireAdminKey, safeRoute((_req, res) => {
  res.status(200).json({
    success: true,
    data: getLedgerStats(),
  });
}));

app.get("/api/v1/admin/surveys", requireAdminKey, safeRoute((_req, res) => {
  res.status(200).json({
    success: true,
    data: { results: getSurveyResults() },
  });
}));

app.get("/api/v1/admin/transactions", requireAdminKey, safeRoute((_req, res) => {
  res.status(200).json({
    success: true,
    data: { transactions: getRecentTransactions(20) },
  });
}));

app.get("/api/v1/admin/ads", requireAdminKey, safeRoute((_req, res) => {
  res.status(200).json({
    success: true,
    data: getAdStats(),
  });
}));

app.get("/api/v1/admin/redemptions", requireAdminKey, safeRoute((req, res) => {
  const statusParam = typeof req.query.status === "string" ? req.query.status.trim() : undefined;
  const status =
    statusParam === "pending" || statusParam === "paid" || statusParam === "rejected"
      ? statusParam
      : undefined;

  res.status(200).json({
    success: true,
    data: { redemptions: getRedemptions(status) },
  });
}));

app.post(
  "/api/v1/admin/redemptions/:id/resolve",
  requireAdminKey,
  (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id, "id");
      const status = parseRedemptionStatus((req.body as ResolveRedemptionBody).status);
      const result = resolveRedemption(id, status);

      if (!result.ok) {
        const message =
          result.reason === "not_found"
            ? "Redemption not found."
            : result.reason === "already_resolved"
              ? "Redemption has already been resolved."
              : "Invalid redemption status.";

        res.status(result.reason === "not_found" ? 404 : 400).json({
          success: false,
          message,
        });
        return;
      }

      res.status(200).json({ success: true, data: { id, status } });
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({
          success: false,
          message: error.message,
        });
        return;
      }

      console.error("[Omni Admin] Resolve redemption error", error);
      res.status(500).json({
        success: false,
        message: "Internal server error.",
      });
    }
  },
);

app.post("/api/v1/admin/reset-ledger", requireStrictAdminKey, safeRoute((_req, res) => {
  resetLedger();
  res.status(200).json({
    success: true,
    message: "Ledger reset: transactions, redemptions, ad events, and survey responses cleared; user balances zeroed.",
  });
}));

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

function parsePositiveInt(value: unknown, fieldName: string): number {
  const id =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;

  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer.`);
  }

  return id;
}

function parseActiveFlag(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  throw new ValidationError("active must be a boolean.");
}

function parseRedemptionMethod(value: unknown): "amazon_voucher" | "upi" {
  const method = typeof value === "string" ? value.trim() : "";
  if (method !== "amazon_voucher" && method !== "upi") {
    throw new ValidationError(
      "method must be 'amazon_voucher' or 'upi'.",
    );
  }
  return method;
}

function parseRedemptionDetail(
  method: "amazon_voucher" | "upi",
  value: unknown,
): string {
  const detail = typeof value === "string" ? value.trim() : "";

  if (!detail) {
    throw new ValidationError("detail is required and must be a non-empty string.");
  }

  if (detail.length > 128) {
    throw new ValidationError("detail must be 128 characters or fewer.");
  }

  if (method === "amazon_voucher") {
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(detail)) {
      throw new ValidationError("detail must be a valid email address for amazon_voucher.");
    }
  }

  return detail;
}

function parseRedemptionStatus(value: unknown): "paid" | "rejected" {
  const status = typeof value === "string" ? value.trim() : "";
  if (status !== "paid" && status !== "rejected") {
    throw new ValidationError("status must be 'paid' or 'rejected'.");
  }
  return status;
}

app.post("/api/v1/admin/surveys", requireAdminKey, (req: Request, res: Response) => {
  try {
    const body = req.body as { question?: unknown; options?: unknown };
    const question =
      typeof body.question === "string" ? body.question : "";
    const options = Array.isArray(body.options)
      ? body.options.filter((option): option is string => typeof option === "string")
      : [];

    const created = addSurveyQuestion(question, options);

    res.status(201).json({
      success: true,
      data: created,
    });
  } catch (error) {
    if (error instanceof ContentValidationError || error instanceof ValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }

    console.error("[Omni Admin] Add survey error", error);
    res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

app.patch(
  "/api/v1/admin/surveys/:id/active",
  requireAdminKey,
  (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id, "id");
      const active = parseActiveFlag((req.body as { active?: unknown }).active);
      const result = setSurveyQuestionActive(id, active);

      if (!result.ok) {
        res.status(404).json({
          success: false,
          message: "Survey question not found.",
        });
        return;
      }

      res.status(200).json({ success: true, data: { id, active } });
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({
          success: false,
          message: error.message,
        });
        return;
      }

      console.error("[Omni Admin] Set survey active error", error);
      res.status(500).json({
        success: false,
        message: "Internal server error.",
      });
    }
  },
);

app.post("/api/v1/admin/ads", requireAdminKey, (req: Request, res: Response) => {
  try {
    const body = req.body as {
      headline?: unknown;
      body?: unknown;
      cta_label?: unknown;
      cta_url?: unknown;
    };

    const created = addAd({
      headline: typeof body.headline === "string" ? body.headline : "",
      body: typeof body.body === "string" ? body.body : "",
      cta_label: typeof body.cta_label === "string" ? body.cta_label : "",
      cta_url: typeof body.cta_url === "string" ? body.cta_url : "",
    });

    res.status(201).json({
      success: true,
      data: created,
    });
  } catch (error) {
    if (error instanceof ContentValidationError || error instanceof ValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }

    console.error("[Omni Admin] Add ad error", error);
    res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

app.patch(
  "/api/v1/admin/ads/:id/active",
  requireAdminKey,
  (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id, "id");
      const active = parseActiveFlag((req.body as { active?: unknown }).active);
      const result = setAdActive(id, active);

      if (!result.ok) {
        res.status(404).json({
          success: false,
          message: "Ad not found.",
        });
        return;
      }

      res.status(200).json({ success: true, data: { id, active } });
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({
          success: false,
          message: error.message,
        });
        return;
      }

      console.error("[Omni Admin] Set ad active error", error);
      res.status(500).json({
        success: false,
        message: "Internal server error.",
      });
    }
  },
);

app.post("/api/v1/admin/partners", requireAdminKey, (req: Request, res: Response) => {
  try {
    const name = typeof (req.body as { name?: unknown }).name === "string"
      ? (req.body as { name: string }).name.trim()
      : "";
    if (name.length > 128) {
      throw new ValidationError("name must be 128 characters or fewer.");
    }
    const created = createPartner(name);

    res.status(201).json({
      success: true,
      data: created,
    });
  } catch (error) {
    if (error instanceof ContentValidationError || error instanceof ValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }

    console.error("[Omni Admin] Add partner error", error);
    res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
});

app.get("/api/v1/admin/partners", requireAdminKey, safeRoute((_req, res) => {
  res.status(200).json({
    success: true,
    data: getPartnerStats(),
  });
}));

app.patch(
  "/api/v1/admin/partners/:id/active",
  requireAdminKey,
  (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id, "id");
      const active = parseActiveFlag((req.body as { active?: unknown }).active);
      const result = setPartnerActive(id, active);

      if (!result.ok) {
        res.status(404).json({
          success: false,
          message: "Partner not found.",
        });
        return;
      }

      res.status(200).json({ success: true, data: { id, active } });
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({
          success: false,
          message: error.message,
        });
        return;
      }

      console.error("[Omni Admin] Set partner active error", error);
      res.status(500).json({
        success: false,
        message: "Internal server error.",
      });
    }
  },
);

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
    .partner-key {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.75rem;
      color: #a1a1aa;
      word-break: break-all;
    }
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
    .form-card {
      background: #141416;
      border-radius: 10px;
      padding: 20px;
      border: 1px solid #27272a;
      margin-bottom: 16px;
    }
    .form-row { margin-bottom: 12px; }
    .form-row label {
      display: block;
      font-size: 0.75rem;
      color: #a1a1aa;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    input, textarea {
      width: 100%;
      background: #0c0c0e;
      border: 1px solid #27272a;
      border-radius: 6px;
      padding: 8px 12px;
      color: #e4e4e7;
      font-size: 0.875rem;
      font-family: inherit;
    }
    input:focus, textarea:focus {
      outline: none;
      border-color: #22c55e;
    }
    textarea { resize: vertical; min-height: 60px; }
    .options-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px;
    }
    .card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 4px;
    }
    .toggle-btn {
      background: #27272a;
      color: #e4e4e7;
      flex-shrink: 0;
      font-size: 0.75rem;
      padding: 6px 12px;
    }
    .toggle-btn:hover { background: #3f3f46; }
    .toggle-btn.inactive { background: #450a0a; color: #fca5a5; }
    .toggle-btn.inactive:hover { background: #7f1d1d; }
    .status-badge {
      font-size: 0.75rem;
      color: #71717a;
    }
    .status-badge.inactive { color: #fca5a5; }
    .btn-sm {
      font-size: 0.75rem;
      padding: 6px 12px;
      margin-right: 6px;
    }
    .btn-reject {
      background: #450a0a;
      color: #fca5a5;
    }
    .btn-reject:hover { background: #7f1d1d; }
    .badge-pending { color: #fbbf24; }
    .badge-paid { color: #22c55e; }
    .badge-rejected { color: #fca5a5; }
    .history-table { margin-top: 16px; }
    .history-table h3 {
      font-size: 0.875rem;
      color: #a1a1aa;
      margin-bottom: 8px;
      font-weight: 600;
    }
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
    <h2>Partners</h2>
    <div class="form-card" id="addPartnerForm">
      <div class="form-row">
        <label for="partnerName">Partner name</label>
        <input type="text" id="partnerName" placeholder="Acme Corp">
      </div>
      <button type="button" id="addPartnerBtn">Add Partner</button>
    </div>
    <div id="partnersTable"></div>
  </div>
  <div class="section">
    <h2>Survey Results</h2>
    <div class="form-card" id="addSurveyForm">
      <div class="form-row">
        <label for="surveyQuestion">Question</label>
        <input type="text" id="surveyQuestion" placeholder="Enter survey question">
      </div>
      <div class="form-row">
        <label>Options (2–4)</label>
        <div class="options-grid">
          <input type="text" id="surveyOpt1" placeholder="Option 1">
          <input type="text" id="surveyOpt2" placeholder="Option 2">
          <input type="text" id="surveyOpt3" placeholder="Option 3">
          <input type="text" id="surveyOpt4" placeholder="Option 4">
        </div>
      </div>
      <button type="button" id="addSurveyBtn">Add Question</button>
    </div>
    <div id="surveyResults"></div>
  </div>
  <div class="section">
    <h2>Ad Performance</h2>
    <div class="form-card" id="addAdForm">
      <div class="form-row">
        <label for="adHeadline">Headline</label>
        <input type="text" id="adHeadline" placeholder="Ad headline">
      </div>
      <div class="form-row">
        <label for="adBody">Body</label>
        <textarea id="adBody" placeholder="Ad body text"></textarea>
      </div>
      <div class="form-row">
        <label for="adCtaLabel">CTA Label</label>
        <input type="text" id="adCtaLabel" placeholder="Button label">
      </div>
      <div class="form-row">
        <label for="adCtaUrl">CTA URL</label>
        <input type="url" id="adCtaUrl" placeholder="https://example.com">
      </div>
      <button type="button" id="addAdBtn">Add Ad</button>
    </div>
    <div id="adStatsTable"></div>
  </div>
  <div class="section">
    <h2>Redemption Requests</h2>
    <div id="redemptionsPending"></div>
    <div id="redemptionsHistory" class="history-table"></div>
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
      var v = Number(n);
      return "₹" + (Number.isInteger(v) ? String(v) : v.toFixed(2));
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
    function renderPartners(partners) {
      var container = document.getElementById("partnersTable");
      if (!partners.length) {
        container.innerHTML = '<div class="empty">No partners yet.</div>';
        return;
      }
      var rows = partners.map(function(p) {
        var toggleLabel = p.active ? "Disable" : "Enable";
        var toggleClass = p.active ? "toggle-btn" : "toggle-btn inactive";
        return '<tr data-id="' + p.id + '">' +
          '<td>' + esc(p.name) + ' <span class="status-badge' + (p.active ? '' : ' inactive') + '">' + (p.active ? '' : '(inactive)') + '</span></td>' +
          '<td class="partner-key">' + esc(p.partner_key) + '</td>' +
          '<td>' + p.transactions + '</td>' +
          '<td class="amount">' + esc(fmtMoney(p.totalPaid)) + '</td>' +
          '<td><button type="button" class="' + toggleClass + '" data-partner-id="' + p.id + '" data-active="' + p.active + '">' + toggleLabel + '</button></td>' +
          '</tr>';
      }).join("");
      container.innerHTML = '<table><thead><tr><th>Name</th><th>Key</th><th>Transactions</th><th>Total Paid</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table>';
      container.querySelectorAll("[data-partner-id]").forEach(function(btn) {
        btn.addEventListener("click", function() {
          togglePartnerActive(Number(btn.getAttribute("data-partner-id")), btn.getAttribute("data-active") !== "true");
        });
      });
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
        var toggleLabel = q.active ? "Disable" : "Enable";
        var toggleClass = q.active ? "toggle-btn" : "toggle-btn inactive";
        return '<div class="survey-card" data-id="' + q.id + '">' +
          '<div class="card-header">' +
          '<div class="survey-question">' + esc(q.question) + '</div>' +
          '<button type="button" class="' + toggleClass + '" data-survey-id="' + q.id + '" data-active="' + q.active + '">' + toggleLabel + '</button>' +
          '</div>' +
          '<div class="survey-meta">' + q.totalResponses + ' response' + (q.totalResponses !== 1 ? 's' : '') +
          ' · <span class="status-badge' + (q.active ? '' : ' inactive') + '">' + (q.active ? 'active' : 'inactive') + '</span></div>' +
          bars + '</div>';
      }).join("");
      container.querySelectorAll("[data-survey-id]").forEach(function(btn) {
        btn.addEventListener("click", function() {
          toggleSurveyActive(Number(btn.getAttribute("data-survey-id")), btn.getAttribute("data-active") !== "true");
        });
      });
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
        var toggleLabel = ad.active ? "Disable" : "Enable";
        var toggleClass = ad.active ? "toggle-btn" : "toggle-btn inactive";
        return '<tr data-id="' + ad.id + '">' +
          '<td>' + esc(ad.headline) + ' <span class="status-badge' + (ad.active ? '' : ' inactive') + '">' + (ad.active ? '' : '(inactive)') + '</span></td>' +
          '<td>' + ad.impressions + '</td>' +
          '<td>' + ad.clicks + '</td>' +
          '<td>' + ctr + '</td>' +
          '<td><button type="button" class="' + toggleClass + '" data-ad-id="' + ad.id + '" data-active="' + ad.active + '">' + toggleLabel + '</button></td>' +
          '</tr>';
      }).join("");
      container.innerHTML = '<table><thead><tr><th>Headline</th><th>Impressions</th><th>Clicks</th><th>CTR</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table>';
      container.querySelectorAll("[data-ad-id]").forEach(function(btn) {
        btn.addEventListener("click", function() {
          toggleAdActive(Number(btn.getAttribute("data-ad-id")), btn.getAttribute("data-active") !== "true");
        });
      });
    }
    function methodLabel(method) {
      return method === "amazon_voucher" ? "Amazon Pay voucher" : "UPI";
    }
    function statusBadge(status) {
      var cls = "badge-" + status;
      return '<span class="' + cls + '">' + esc(status) + '</span>';
    }
    function renderRedemptions(redemptions) {
      var pending = redemptions.filter(function(r) { return r.status === "pending"; });
      var resolved = redemptions.filter(function(r) { return r.status !== "pending"; }).slice(0, 10);

      var pendingContainer = document.getElementById("redemptionsPending");
      if (!pending.length) {
        pendingContainer.innerHTML = '<div class="empty">No pending redemption requests.</div>';
      } else {
        var pendingRows = pending.map(function(r) {
          return '<tr data-id="' + r.id + '">' +
            '<td>' + esc(shortId(r.user_id)) + '</td>' +
            '<td class="amount">' + esc(fmtMoney(r.amount)) + '</td>' +
            '<td>' + esc(methodLabel(r.method)) + '</td>' +
            '<td>' + esc(r.detail) + '</td>' +
            '<td>' + esc(fmtTime(r.created_at)) + '</td>' +
            '<td>' +
            '<button type="button" class="btn-sm" data-resolve-id="' + r.id + '" data-status="paid">Mark Paid</button>' +
            '<button type="button" class="btn-sm btn-reject" data-resolve-id="' + r.id + '" data-status="rejected">Reject</button>' +
            '</td></tr>';
        }).join("");
        pendingContainer.innerHTML = '<table><thead><tr><th>User</th><th>Amount</th><th>Method</th><th>Detail</th><th>Date</th><th>Actions</th></tr></thead><tbody>' + pendingRows + '</tbody></table>';
        pendingContainer.querySelectorAll("[data-resolve-id]").forEach(function(btn) {
          btn.addEventListener("click", function() {
            resolveRedemption(Number(btn.getAttribute("data-resolve-id")), btn.getAttribute("data-status"));
          });
        });
      }

      var historyContainer = document.getElementById("redemptionsHistory");
      if (!resolved.length) {
        historyContainer.innerHTML = '';
      } else {
        var historyRows = resolved.map(function(r) {
          return '<tr>' +
            '<td>' + esc(shortId(r.user_id)) + '</td>' +
            '<td class="amount">' + esc(fmtMoney(r.amount)) + '</td>' +
            '<td>' + esc(methodLabel(r.method)) + '</td>' +
            '<td>' + statusBadge(r.status) + '</td>' +
            '<td>' + esc(fmtTime(r.resolved_at || r.created_at)) + '</td>' +
            '</tr>';
        }).join("");
        historyContainer.innerHTML = '<h3>Recently Resolved</h3><table><thead><tr><th>User</th><th>Amount</th><th>Method</th><th>Status</th><th>Resolved</th></tr></thead><tbody>' + historyRows + '</tbody></table>';
      }
    }
    async function resolveRedemption(id, status) {
      hideError();
      try {
        var response = await fetch(adminUrl("/api/v1/admin/redemptions/" + id + "/resolve"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: status }),
        });
        var json = await response.json();
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Failed to resolve redemption.");
        }
        await loadRedemptions();
      } catch (err) {
        showError(err instanceof Error ? err.message : "Failed to resolve redemption.");
      }
    }
    async function loadRedemptions() {
      var response = await fetch(adminUrl("/api/v1/admin/redemptions"));
      if (!response.ok) throw new Error("Failed to load redemptions.");
      var json = await response.json();
      if (!json.success) throw new Error("API returned an error response.");
      renderRedemptions(json.data.redemptions);
    }
    function adminUrl(path) {
      var key = new URLSearchParams(window.location.search).get("key");
      return key ? path + "?key=" + encodeURIComponent(key) : path;
    }
    async function loadPartners() {
      var response = await fetch(adminUrl("/api/v1/admin/partners"));
      if (!response.ok) throw new Error("Failed to load partners.");
      var json = await response.json();
      if (!json.success) throw new Error("API returned an error response.");
      renderPartners(json.data);
    }
    async function togglePartnerActive(id, active) {
      hideError();
      try {
        var response = await fetch(adminUrl("/api/v1/admin/partners/" + id + "/active"), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: active }),
        });
        var json = await response.json();
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Failed to update partner.");
        }
        await loadPartners();
      } catch (err) {
        showError(err instanceof Error ? err.message : "Failed to update partner.");
      }
    }
    async function submitPartner() {
      var btn = document.getElementById("addPartnerBtn");
      btn.disabled = true;
      hideError();
      try {
        var response = await fetch(adminUrl("/api/v1/admin/partners"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: document.getElementById("partnerName").value,
          }),
        });
        var json = await response.json();
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Failed to add partner.");
        }
        document.getElementById("partnerName").value = "";
        await loadPartners();
      } catch (err) {
        showError(err instanceof Error ? err.message : "Failed to add partner.");
      } finally {
        btn.disabled = false;
      }
    }
    async function loadSurveys() {
      var response = await fetch(adminUrl("/api/v1/admin/surveys"));
      if (!response.ok) throw new Error("Failed to load surveys.");
      var json = await response.json();
      if (!json.success) throw new Error("API returned an error response.");
      renderSurveys(json.data.results);
    }
    async function loadAds() {
      var response = await fetch(adminUrl("/api/v1/admin/ads"));
      if (!response.ok) throw new Error("Failed to load ads.");
      var json = await response.json();
      if (!json.success) throw new Error("API returned an error response.");
      renderAdStats(json.data);
    }
    async function toggleSurveyActive(id, active) {
      hideError();
      try {
        var response = await fetch(adminUrl("/api/v1/admin/surveys/" + id + "/active"), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: active }),
        });
        var json = await response.json();
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Failed to update survey.");
        }
        await loadSurveys();
      } catch (err) {
        showError(err instanceof Error ? err.message : "Failed to update survey.");
      }
    }
    async function toggleAdActive(id, active) {
      hideError();
      try {
        var response = await fetch(adminUrl("/api/v1/admin/ads/" + id + "/active"), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: active }),
        });
        var json = await response.json();
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Failed to update ad.");
        }
        await loadAds();
      } catch (err) {
        showError(err instanceof Error ? err.message : "Failed to update ad.");
      }
    }
    async function submitSurvey() {
      var btn = document.getElementById("addSurveyBtn");
      btn.disabled = true;
      hideError();
      try {
        var options = ["surveyOpt1", "surveyOpt2", "surveyOpt3", "surveyOpt4"]
          .map(function(id) { return document.getElementById(id).value.trim(); })
          .filter(function(v) { return v.length > 0; });
        var response = await fetch(adminUrl("/api/v1/admin/surveys"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: document.getElementById("surveyQuestion").value,
            options: options,
          }),
        });
        var json = await response.json();
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Failed to add survey question.");
        }
        document.getElementById("surveyQuestion").value = "";
        ["surveyOpt1", "surveyOpt2", "surveyOpt3", "surveyOpt4"].forEach(function(id) {
          document.getElementById(id).value = "";
        });
        await loadSurveys();
      } catch (err) {
        showError(err instanceof Error ? err.message : "Failed to add survey question.");
      } finally {
        btn.disabled = false;
      }
    }
    async function submitAd() {
      var btn = document.getElementById("addAdBtn");
      btn.disabled = true;
      hideError();
      try {
        var response = await fetch(adminUrl("/api/v1/admin/ads"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            headline: document.getElementById("adHeadline").value,
            body: document.getElementById("adBody").value,
            cta_label: document.getElementById("adCtaLabel").value,
            cta_url: document.getElementById("adCtaUrl").value,
          }),
        });
        var json = await response.json();
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Failed to add ad.");
        }
        document.getElementById("adHeadline").value = "";
        document.getElementById("adBody").value = "";
        document.getElementById("adCtaLabel").value = "";
        document.getElementById("adCtaUrl").value = "";
        await loadAds();
      } catch (err) {
        showError(err instanceof Error ? err.message : "Failed to add ad.");
      } finally {
        btn.disabled = false;
      }
    }
    async function loadDashboard() {
      var btn = document.getElementById("refreshBtn");
      btn.disabled = true;
      hideError();
      try {
        var responses = await Promise.all([
          fetch(adminUrl("/api/v1/admin/stats")),
          fetch(adminUrl("/api/v1/admin/partners")),
          fetch(adminUrl("/api/v1/admin/surveys")),
          fetch(adminUrl("/api/v1/admin/transactions")),
          fetch(adminUrl("/api/v1/admin/ads")),
          fetch(adminUrl("/api/v1/admin/redemptions")),
        ]);
        if (!responses[0].ok || !responses[1].ok || !responses[2].ok || !responses[3].ok || !responses[4].ok || !responses[5].ok) {
          throw new Error("One or more API requests failed.");
        }
        var statsJson = await responses[0].json();
        var partnersJson = await responses[1].json();
        var surveysJson = await responses[2].json();
        var txJson = await responses[3].json();
        var adsJson = await responses[4].json();
        var redemptionsJson = await responses[5].json();
        if (!statsJson.success || !partnersJson.success || !surveysJson.success || !txJson.success || !adsJson.success || !redemptionsJson.success) {
          throw new Error("API returned an error response.");
        }
        renderStats(statsJson.data);
        renderPartners(partnersJson.data);
        renderSurveys(surveysJson.data.results);
        renderAdStats(adsJson.data);
        renderRedemptions(redemptionsJson.data.redemptions);
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
    document.getElementById("addSurveyBtn").addEventListener("click", submitSurvey);
    document.getElementById("addAdBtn").addEventListener("click", submitAd);
    document.getElementById("addPartnerBtn").addEventListener("click", submitPartner);
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

process.on("uncaughtException", (error) => {
  console.error("[Omni Backend] uncaughtException (process kept alive):", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Omni Backend] unhandledRejection (process kept alive):", reason);
});
