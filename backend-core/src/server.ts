import cors from "cors";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  applyYield,
  DuplicateTransactionError,
  getBalance,
  getTransactions,
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
}

interface YieldTransaction {
  userId: string;
  amount: number;
  layer: YieldLayer;
  nonce: string;
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

function parseYieldRequest(body: YieldRequestBody): YieldTransaction {
  const userId =
    typeof body.userId === "string" ? body.userId.trim() : "";

  if (!userId) {
    throw new ValidationError("userId is required and must be a non-empty string.");
  }

  if (userId.length > 128) {
    throw new ValidationError("userId must be 128 characters or fewer.");
  }

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

  return {
    userId,
    amount: Math.round(amount * 100) / 100,
    layer: layer as YieldLayer,
    nonce,
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

app.post("/api/v1/yield", (req: Request, res: Response) => {
  try {
    const transaction = parseYieldRequest(req.body as YieldRequestBody);
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
      res.status(409).json({
        success: false,
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