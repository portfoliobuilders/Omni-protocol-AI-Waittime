import cors from "cors";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  applyYield,
  consumeClaimSession,
  createClaimSession,
  DuplicateTransactionError,
  getBalance,
  getNextSurveyQuestion,
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