import cors from "cors";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addAd,
  addSurveyQuestion,
  backupDatabase,
  ContentValidationError,
  createClaimSession,
  createPartner,
  DuplicateTransactionError,
  EARNER_SHARE,
  getActiveAd,
  getAdStats,
  getBalance,
  getCampaignStats,
  getLedgerStats,
  getNextSurveyQuestion,
  getOrCreateAdvertiser,
  getPartnerByKey,
  getPartnerStats,
  getRecentTransactions,
  getRedemptions,
  getServableCampaign,
  getSurveyResults,
  getTransactions,
  listTopupRequests,
  pauseAdvertiserCampaign,
  PLATFORM_SHARE,
  POOL_SHARE,
  recordAdEvent,
  recordCampaignClick,
  recordCampaignImpression,
  requestCampaignTopup,
  resetLedger,
  resolveRedemption,
  resolveTopupRequest,
  resumeAdvertiserCampaign,
  setAdActive,
  setPartnerActive,
  setSurveyQuestionActive,
  verifyAdvertiser,
} from "./db";
import { getExchangeConfig } from "./exchange/config";
import {
  backdateWaitSessionPg,
  confirmAdvertiserFundingPg,
  createAdRequestPg,
  createCampaignFromPaiseInput,
  createFundedCampaignPg,
  getPlatformHealthPg,
  getRecentEarningsPg,
  getWalletPg,
  listCampaignsAdminPg,
  listUserRedemptionsPg,
  qualifyAndSettlePg,
  recordPlatformEventPg,
  requestRedemptionPg,
  reviewCampaignPg,
  setCampaignProviderPg,
  startWaitSessionPg,
} from "./exchange/postgres";
import { BUILTIN_PROVIDERS } from "./exchange/providers";
import { assertPostgresExchangeReady } from "./exchange/supabaseClient";

// Keep typecheck happy for admin/test helpers re-exported via routes later.
void createFundedCampaignPg;
void backdateWaitSessionPg;

dotenv.config();
assertPostgresExchangeReady();

/**
 * Platform economics — authoritative consumer split is 60% user / 40% Omni.
 * Fixed ₹2/₹10 tiers are deprecated and must not mint money.
 */
const REWARD_ECONOMICS = {
  currency: "INR",
  symbol: "₹",
  minRedemption: 100,
  minWaitSeconds: 5,
  userRevenueShareBps: 6000,
  omniRevenueShareBps: 4000,
  /** @deprecated — not a production money path */
  tier2Amount: 2,
  /** @deprecated — not a production money path */
  tier3Amount: 10,
  /** @deprecated */
  tier3Seconds: 15,
  /** @deprecated 60/20/20 removed; earner=60, pool=0, platform/omni=40 */
  revenueShare: {
    earner: EARNER_SHARE,
    pool: POOL_SHARE,
    platform: PLATFORM_SHARE,
    userBps: 6000,
    omniBps: 4000,
  },
} as const;

/** Remote platform toggles for extension (disable without release). */
const EXTENSION_PLATFORMS = [
  { id: "chatgpt", name: "ChatGPT", enabled: true, sponsoredWaitEnabled: true, hosts: ["chatgpt.com"] },
  { id: "claude", name: "Claude", enabled: true, sponsoredWaitEnabled: true, hosts: ["claude.ai"] },
  { id: "gemini", name: "Gemini", enabled: true, sponsoredWaitEnabled: true, hosts: ["gemini.google.com"] },
  { id: "perplexity", name: "Perplexity", enabled: true, sponsoredWaitEnabled: true, hosts: ["perplexity.ai", "www.perplexity.ai"] },
  { id: "copilot", name: "Copilot", enabled: true, sponsoredWaitEnabled: true, hosts: ["copilot.microsoft.com"] },
  { id: "deepseek", name: "DeepSeek", enabled: true, sponsoredWaitEnabled: true, hosts: ["chat.deepseek.com"] },
  { id: "grok", name: "Grok", enabled: true, sponsoredWaitEnabled: true, hosts: ["grok.com"] },
  { id: "meta_ai", name: "Meta AI", enabled: true, sponsoredWaitEnabled: true, hosts: ["meta.ai", "www.meta.ai"] },
  { id: "mistral", name: "Le Chat", enabled: true, sponsoredWaitEnabled: true, hosts: ["chat.mistral.ai"] },
  { id: "poe", name: "Poe", enabled: true, sponsoredWaitEnabled: true, hosts: ["poe.com", "www.poe.com"] },
] as const;

// Changed fallback port from 3000 to 3001 to bypass the blocked port issue
const PORT = Number(process.env.PORT ?? 3001);
const ADMIN_KEY = process.env.OMNI_ADMIN_KEY;

interface SessionStartRequestBody {
  userId?: unknown;
  partnerKey?: unknown;
}

interface AdEventRequestBody {
  adId?: unknown;
  userId?: unknown;
  event?: unknown;
  campaignId?: unknown;
}

interface CreateCampaignRequestBody {
  advertiser_email?: unknown;
  headline?: unknown;
  body?: unknown;
  cta_label?: unknown;
  cta_url?: unknown;
  cpm_paise?: unknown;
  total_budget_paise?: unknown;
}

interface ReviewCampaignBody {
  decision?: unknown;
}

interface TopupRequestBody {
  amount_paise?: unknown;
}

interface ResolveTopupBody {
  status?: unknown;
}

interface RedeemRequestBody {
  userId?: unknown;
  method?: unknown;
  detail?: unknown;
}

interface ResolveRedemptionBody {
  status?: unknown;
}

const app = express();

app.disable("x-powered-by");

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Adv-Email", "X-Adv-Key"],
  }),
);

app.use(express.json({ limit: "16kb" }));

// In-memory POST rate limiter (resets on process restart; move to Redis at scale).
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_POSTS = 30;
const rateLimitByIp = new Map<string, number[]>();
const RATE_LIMITED_POST_PATHS = new Set([
  "/api/v1/session/start",
  "/api/v1/ad/request",
  "/api/v1/impression/qualify",
  "/api/v1/telemetry",
  "/api/v1/yield",
  "/api/v1/redeem",
  "/api/v1/ad/event",
  "/api/v1/campaigns",
]);

function isRateLimitedPostPath(pathname: string): boolean {
  if (RATE_LIMITED_POST_PATHS.has(pathname)) {
    return true;
  }
  return pathname.startsWith("/api/v1/advertiser/");
}

function postRateLimiter(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "POST") {
    next();
    return;
  }

  if (req.path.startsWith("/admin") || req.path.startsWith("/api/v1/admin")) {
    next();
    return;
  }

  if (!isRateLimitedPostPath(req.path)) {
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

/** Map Phase 3 extension telemetry to DB-allowed platform_events vocabulary. */
function mapTelemetryEvent(raw: string): string {
  const map: Record<string, string> = {
    wait_detected: "detected",
    session_started: "shown",
    ad_requested: "shown",
    ad_returned: "rendered",
    no_fill: "error",
    ad_rendered: "rendered",
    ad_viewable: "rendered",
    ad_dismissed: "error",
    impression_qualify_requested: "qualified",
    impression_qualified: "qualified",
    impression_settled: "settled",
    settlement_failed: "error",
    wait_short: "wait_ended",
    wait_ended: "wait_ended",
    duplicate_prevented: "settled",
    platform_error: "error",
    click: "shown",
  };
  return map[raw] ?? (raw || "error");
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

function readAdvertiserAuth(
  req: Request,
): { email: string; key: string } | null {
  const emailRaw = req.headers["x-adv-email"];
  const keyRaw = req.headers["x-adv-key"];
  const email = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
  const key = typeof keyRaw === "string" ? keyRaw.trim() : "";
  if (!email || !key) {
    return null;
  }
  return { email, key };
}

function requireAdvertiser(
  req: Request,
  res: Response,
): { email: string } | null {
  const creds = readAdvertiserAuth(req);
  if (!creds || !verifyAdvertiser(creds.email, creds.key)) {
    res.status(401).json({
      success: false,
      message: "Invalid advertiser credentials.",
    });
    return null;
  }
  return { email: creds.email };
}

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    service: "omni-backend-core",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/v1/config", (_req: Request, res: Response) => {
  const exchange = getExchangeConfig();
  res.status(200).json({
    success: true,
    data: {
      ...REWARD_ECONOMICS,
      userRevenueShareBps: exchange.userRevenueShareBps,
      omniRevenueShareBps: exchange.omniRevenueShareBps,
      minimumQualifiedViewMs: exchange.minimumQualifiedViewMs,
      minimumCpmMicropaise: exchange.minimumCpmMicropaise,
      demandProviders: BUILTIN_PROVIDERS.filter((p) => p.enabled).map((p) => ({
        providerKey: p.providerKey,
        providerType: p.providerType,
        cashRevenueShareAllowed: p.cashRevenueShareAllowed,
        settlementMode: p.settlementMode,
      })),
      platform: {
        currency: REWARD_ECONOMICS.currency,
        symbol: REWARD_ECONOMICS.symbol,
        minRedemption: REWARD_ECONOMICS.minRedemption,
        minWaitSeconds: REWARD_ECONOMICS.minWaitSeconds,
        userRevenueShareBps: exchange.userRevenueShareBps,
        omniRevenueShareBps: exchange.omniRevenueShareBps,
        minimumQualifiedViewMs: exchange.minimumQualifiedViewMs,
      },
      platforms: EXTENSION_PLATFORMS,
    },
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
    <p>OmniPiggy is a browser extension that shares advertiser-funded revenue during verified AI wait time. This policy explains what we collect and what we do not.</p>

    <h2>What we collect</h2>
    <ul>
      <li>A random anonymous install ID generated on your device (stored locally and sent with API requests).</li>
      <li>Wait-session and settlement records (timestamps, unique nonces) to prevent duplicate earnings.</li>
      <li>Ad impression and click counts when you interact with sponsored content.</li>
      <li>Redemption requests you submit (method and payout detail you provide).</li>
    </ul>

    <h2>What we do not collect</h2>
    <ul>
      <li>Your name, email address, or other personal identity information (unless you provide it for redemption).</li>
      <li>Your browsing history outside supported AI chat pages.</li>
      <li>Any content of your AI conversations. The extension only detects loading states on supported AI sites — it never reads your chats for advertising.</li>
    </ul>

    <h2>Where data lives</h2>
    <p>Data is stored on our server (Supabase / self-hosted API — see your OMNI_API_BASE). It is used to track your wallet balance, prevent duplicate settlements, and improve the service. We do not read your AI prompts or answers for advertising.</p>

    <h2>Your rights</h2>
    <p>You may contact us to request deletion of your data. Uninstalling the extension stops all further collection from your browser.</p>

    <h2>Contact</h2>
    <p>Questions or deletion requests: <a href="mailto:contact@portfoliobuilders.in">contact@portfoliobuilders.in</a></p>
  </main>
</body>
</html>`);
});

app.post("/api/v1/session/start", safeRoute(async (req, res) => {
  const body = req.body as SessionStartRequestBody & { platform?: unknown };
  const partnerKey = parseOptionalPartnerKey(body.partnerKey);
  const partnerId = resolvePartnerId(partnerKey, res);
  if (partnerId === null) {
    return;
  }

  const userId = parseUserId(body.userId);
  const platform =
    typeof body.platform === "string" && body.platform.trim()
      ? body.platform.trim().slice(0, 64)
      : "unknown";

  const sessionToken = createClaimSession(userId);
  const wait = await startWaitSessionPg(userId, platform);

  res.status(200).json({
    success: true,
    data: {
      sessionToken,
      waitSessionId: wait.id,
      serverNonce: wait.server_nonce,
      startedAt: wait.started_at,
      platform: wait.platform,
    },
  });
}));

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


app.post("/api/v1/ad/request", safeRoute(async (req, res) => {
  const body = req.body as {
    userId?: unknown;
    waitSessionId?: unknown;
    preferredProvider?: unknown;
  };
  const userId = parseUserId(body.userId);
  const waitSessionId =
    typeof body.waitSessionId === "string" ? body.waitSessionId.trim() : "";
  if (!waitSessionId) {
    throw new ValidationError("waitSessionId is required.");
  }
  const preferredProvider =
    typeof body.preferredProvider === "string"
      ? body.preferredProvider.trim()
      : undefined;

  const result = await createAdRequestPg({
    waitSessionId,
    userId,
    preferredProvider,
  });
  if (!result.ok) {
    res.status(400).json({ success: false, message: result.reason });
    return;
  }

  res.status(200).json({
    success: true,
    data: {
      adRequestId: result.adRequestId,
      impressionId: result.impressionId,
      providerKey: result.providerKey,
      source: result.source,
      campaignId: result.campaignId,
      creative: result.creative,
      sponsoredLabel: "Sponsored",
      requiredViewMs: result.requiredViewMs,
      cashRevenueShareAllowed: result.cashRevenueShareAllowed,
    },
  });
}));

app.post("/api/v1/impression/qualify", safeRoute(async (req, res) => {
  const body = req.body as {
    userId?: unknown;
    impressionId?: unknown;
    reportedViewMs?: unknown;
    rewardAmount?: unknown;
    userShare?: unknown;
    grossRevenue?: unknown;
  };

  if (
    body.rewardAmount !== undefined ||
    body.userShare !== undefined ||
    body.grossRevenue !== undefined
  ) {
    res.status(400).json({
      success: false,
      message: "Client must not submit reward or revenue amounts.",
    });
    return;
  }

  const userId = parseUserId(body.userId);
  const impressionId =
    typeof body.impressionId === "string" ? body.impressionId.trim() : "";
  if (!impressionId) {
    throw new ValidationError("impressionId is required.");
  }
  const reportedViewMs =
    typeof body.reportedViewMs === "number" && Number.isFinite(body.reportedViewMs)
      ? Math.floor(body.reportedViewMs)
      : NaN;
  if (!Number.isInteger(reportedViewMs) || reportedViewMs < 0) {
    throw new ValidationError("reportedViewMs must be a non-negative integer.");
  }

  const result = await qualifyAndSettlePg({
    impressionId,
    userId,
    reportedViewMs,
  });

  if (!result.ok) {
    const status =
      result.reason === "view_below_threshold" ||
      result.reason === "wait_below_threshold"
        ? 403
        : 400;
    res.status(status).json({ success: false, message: result.reason });
    return;
  }

  res.status(200).json({
    success: true,
    duplicate: result.duplicate,
    data: {
      impressionId: result.impressionId,
      house: result.house,
      grossMicropaise: result.grossMicropaise,
      userShareMicropaise: result.userShareMicropaise,
      omniShareMicropaise: result.omniShareMicropaise,
      availableMicropaise: result.availableMicropaise,
    },
  });
}));

app.get("/api/v1/exchange/wallet/:userId", safeRoute(async (req, res) => {
  const userId = parseUserId(req.params.userId);
  const wallet = await getWalletPg(userId);
  res.status(200).json({
    success: true,
    data: wallet,
  });
}));

app.get("/api/v1/exchange/recent/:userId", safeRoute(async (req, res) => {
  const userId = parseUserId(req.params.userId);
  const limit = Math.min(
    50,
    Math.max(1, Number(req.query.limit) || 10),
  );
  const earnings = await getRecentEarningsPg(userId, limit);
  res.status(200).json({ success: true, data: { earnings } });
}));

app.post("/api/v1/telemetry", safeRoute(async (req, res) => {
  const body = req.body as {
    host?: unknown;
    event?: unknown;
    userId?: unknown;
  };
  const host = typeof body.host === "string" ? body.host.trim() : "";
  if (!host || host.length > 128) {
    throw new ValidationError("host is required (max 128 chars).");
  }
  const userId = parseUserId(body.userId);
  const rawEvent = typeof body.event === "string" ? body.event.trim() : "";
  const event = mapTelemetryEvent(rawEvent);
  const result = await recordPlatformEventPg(userId, host, event);
  if (!result.ok) {
    res.status(400).json({ success: false, message: "Invalid telemetry event." });
    return;
  }
  res.status(200).json({ success: true });
}));

/** Fixed-reward yield is retired. Cannot mint money. */
app.post("/api/v1/yield", (_req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    deprecated: true,
    message:
      "POST /api/v1/yield is retired. Use wait session → ad request → impression/qualify settlement.",
  });
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
  const campaign = getServableCampaign();
  if (campaign) {
    res.status(200).json({
      success: true,
      data: {
        ad: {
          id: campaign.id,
          headline: campaign.headline,
          body: campaign.body,
          cta_label: campaign.cta_label,
          cta_url: campaign.cta_url,
        },
        source: "campaign",
        campaignId: campaign.id,
      },
    });
    return;
  }

  res.status(200).json({
    success: true,
    data: {
      ad: getActiveAd(),
      source: "house",
    },
  });
}));

app.post("/api/v1/ad/event", (req: Request, res: Response) => {
  try {
    const body = req.body as AdEventRequestBody;

    const userId = parseUserId(body.userId);

    const event =
      typeof body.event === "string" ? body.event.trim() : "";

    if (event !== "impression" && event !== "click") {
      throw new ValidationError("event must be 'impression' or 'click'.");
    }

    const campaignIdRaw = body.campaignId;
    const campaignId =
      typeof campaignIdRaw === "number"
        ? campaignIdRaw
        : typeof campaignIdRaw === "string"
          ? Number(campaignIdRaw)
          : NaN;

    if (Number.isInteger(campaignId) && campaignId > 0) {
      if (event === "impression") {
        const result = recordCampaignImpression(campaignId, userId);
        if (!result.ok) {
          res.status(400).json({
            success: false,
            message: "Invalid campaign impression.",
          });
          return;
        }
        res.status(200).json({
          success: true,
          data: {
            spent_paise: result.spent_paise,
            status: result.status,
            revenue: result.revenue,
          },
        });
        return;
      }

      const clickResult = recordCampaignClick(campaignId, userId);
      if (!clickResult.ok) {
        res.status(400).json({
          success: false,
          message: "Invalid campaign click.",
        });
        return;
      }
      res.status(200).json({ success: true });
      return;
    }

    const adId =
      typeof body.adId === "number"
        ? body.adId
        : typeof body.adId === "string"
          ? Number(body.adId)
          : NaN;

    if (!Number.isInteger(adId) || adId <= 0) {
      throw new ValidationError("adId must be a positive integer.");
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

app.post("/api/v1/campaigns", safeRoute(async (req, res) => {
  const body = req.body as CreateCampaignRequestBody & {
    cpm_micropaise?: unknown;
    total_budget_micropaise?: unknown;
    provider_key?: unknown;
  };

  const parsePositiveIntField = (value: unknown, field: string): number => {
    const n =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : NaN;
    if (!Number.isInteger(n) || n <= 0) {
      throw new ValidationError(`${field} must be a positive integer.`);
    }
    return n;
  };

  const advertiserEmail =
    typeof body.advertiser_email === "string" ? body.advertiser_email : "";
  const advertiser = getOrCreateAdvertiser(advertiserEmail);
  const headline = typeof body.headline === "string" ? body.headline : "";
  const campaignBody = typeof body.body === "string" ? body.body : "";
  const ctaLabel = typeof body.cta_label === "string" ? body.cta_label : "";
  const ctaUrl = typeof body.cta_url === "string" ? body.cta_url : "";
  const providerKey =
    body.provider_key === "seed_sponsor" ? "seed_sponsor" : "omni_direct";

  let campaignId: string;
  let cpmMicropaise: number;
  let totalBudgetMicropaise: number;
  let status: string;

  if (
    body.cpm_micropaise !== undefined ||
    body.total_budget_micropaise !== undefined
  ) {
    cpmMicropaise = parsePositiveIntField(body.cpm_micropaise, "cpm_micropaise");
    totalBudgetMicropaise = parsePositiveIntField(
      body.total_budget_micropaise,
      "total_budget_micropaise",
    );
    const created = await createFundedCampaignPg({
      advertiserEmail: advertiser.email,
      name: headline.slice(0, 80) || "Campaign",
      providerKey,
      cpmMicropaise,
      totalBudgetMicropaise,
      headline,
      body: campaignBody,
      ctaLabel,
      ctaUrl,
      status: "pending_review",
    });
    campaignId = created.campaignId;
    status = "pending_review";
  } else {
    const created = await createCampaignFromPaiseInput({
      advertiserEmail: advertiser.email,
      headline,
      body: campaignBody,
      ctaLabel,
      ctaUrl,
      cpmPaise: parsePositiveIntField(body.cpm_paise, "cpm_paise"),
      totalBudgetPaise: parsePositiveIntField(
        body.total_budget_paise,
        "total_budget_paise",
      ),
      providerKey,
    });
    campaignId = created.campaignId;
    cpmMicropaise = created.cpmMicropaise;
    totalBudgetMicropaise = created.totalBudgetMicropaise;
    status = "pending_review";
  }

  const data: Record<string, unknown> = {
    id: campaignId,
    status,
    cpm_micropaise: cpmMicropaise,
    total_budget_micropaise: totalBudgetMicropaise,
    note: "Campaign stored in Postgres (micropaise). Pending review before activation.",
  };

  if (advertiser.isNew) {
    data.mgmt_key = advertiser.mgmt_key;
    data.mgmt_key_note =
      "Save this management key now — it is shown only once. You will need it to log in at /advertiser.";
  }

  res.status(201).json({
    success: true,
    data,
  });
}));

app.get("/api/v1/campaigns/stats", safeRoute((req, res) => {
  const auth = requireAdvertiser(req, res);
  if (!auth) {
    return;
  }

  res.status(200).json({
    success: true,
    data: { campaigns: getCampaignStats(auth.email) },
  });
}));

app.get("/api/v1/advertiser/campaigns", safeRoute((req, res) => {
  const auth = requireAdvertiser(req, res);
  if (!auth) {
    return;
  }

  res.status(200).json({
    success: true,
    data: { campaigns: getCampaignStats(auth.email) },
  });
}));

app.post(
  "/api/v1/advertiser/campaigns/:id/pause",
  (req: Request, res: Response) => {
    try {
      const auth = requireAdvertiser(req, res);
      if (!auth) {
        return;
      }

      const id = parsePositiveInt(req.params.id, "id");
      const result = pauseAdvertiserCampaign(auth.email, id);
      if (!result.ok) {
        const message =
          result.reason === "not_found"
            ? "Campaign not found."
            : result.reason === "not_owner"
              ? "Campaign not found."
              : "Campaign can only be paused when active.";
        res.status(result.reason === "invalid_transition" ? 400 : 404).json({
          success: false,
          message,
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: { id, status: result.status },
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({
          success: false,
          message: error.message,
        });
        return;
      }

      console.error("[Omni Advertiser] Pause campaign error", error);
      res.status(500).json({
        success: false,
        message: "Internal server error.",
      });
    }
  },
);

app.post(
  "/api/v1/advertiser/campaigns/:id/resume",
  (req: Request, res: Response) => {
    try {
      const auth = requireAdvertiser(req, res);
      if (!auth) {
        return;
      }

      const id = parsePositiveInt(req.params.id, "id");
      const result = resumeAdvertiserCampaign(auth.email, id);
      if (!result.ok) {
        const message =
          result.reason === "not_found"
            ? "Campaign not found."
            : result.reason === "not_owner"
              ? "Campaign not found."
              : "Campaign can only be resumed when paused.";
        res.status(result.reason === "invalid_transition" ? 400 : 404).json({
          success: false,
          message,
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: { id, status: result.status },
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({
          success: false,
          message: error.message,
        });
        return;
      }

      console.error("[Omni Advertiser] Resume campaign error", error);
      res.status(500).json({
        success: false,
        message: "Internal server error.",
      });
    }
  },
);

app.post(
  "/api/v1/advertiser/campaigns/:id/topup",
  (req: Request, res: Response) => {
    try {
      const auth = requireAdvertiser(req, res);
      if (!auth) {
        return;
      }

      const id = parsePositiveInt(req.params.id, "id");
      const amountRaw = (req.body as TopupRequestBody).amount_paise;
      const amount_paise =
        typeof amountRaw === "number"
          ? amountRaw
          : typeof amountRaw === "string"
            ? Number(amountRaw)
            : NaN;

      if (!Number.isInteger(amount_paise) || amount_paise <= 0) {
        throw new ValidationError("amount_paise must be a positive integer.");
      }

      const result = requestCampaignTopup(auth.email, id, amount_paise);
      if (!result.ok) {
        const message =
          result.reason === "invalid_amount"
            ? "amount_paise must be a positive integer."
            : "Campaign not found.";
        res.status(result.reason === "invalid_amount" ? 400 : 404).json({
          success: false,
          message,
        });
        return;
      }

      res.status(201).json({
        success: true,
        data: {
          topup: result.topup,
          note: "Requested — we'll email a UPI payment link; budget updates once paid.",
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

      console.error("[Omni Advertiser] Top-up request error", error);
      res.status(500).json({
        success: false,
        message: "Internal server error.",
      });
    }
  },
);

app.post("/api/v1/redeem", safeRoute(async (req, res) => {
  const body = req.body as RedeemRequestBody;
  const userId = parseUserId(body.userId);
  const method = parseRedemptionMethod(body.method);
  const detail = parseRedemptionDetail(method, body.detail);

  const wallet = await getWalletPg(userId);
  const minMicropaise = REWARD_ECONOMICS.minRedemption * 100 * 1000; // ₹ → micropaise
  if (wallet.availableMicropaise < minMicropaise) {
    res.status(400).json({
      success: false,
      reason: "below_minimum",
      message: `Balance is below the minimum redemption amount (${REWARD_ECONOMICS.symbol}${REWARD_ECONOMICS.minRedemption}).`,
    });
    return;
  }

  const amountMicropaise = wallet.availableMicropaise;
  const result = await requestRedemptionPg({
    userId,
    amountMicropaise,
    method,
    detail,
  });

  if (!result.ok) {
    res.status(400).json({
      success: false,
      reason: result.reason,
      message: result.reason,
    });
    return;
  }

  res.status(200).json({
    success: true,
    data: {
      amount: amountMicropaise / 100_000,
      amountMicropaise,
      redemptionId: result.redemptionId,
    },
  });
}));

app.get("/api/v1/redemptions/:userId", safeRoute(async (req, res) => {
  const userId = parseUserId(req.params.userId);
  res.status(200).json({
    success: true,
    data: { redemptions: await listUserRedemptionsPg(userId) },
  });
}));

app.get("/api/v1/admin/platforms", requireAdminKey, safeRoute(async (_req, res) => {
  res.status(200).json({
    success: true,
    data: await getPlatformHealthPg(),
  });
}));

app.post("/api/v1/admin/funding", requireAdminKey, safeRoute(async (req, res) => {
  const body = req.body as {
    advertiser_email?: unknown;
    amount_micropaise?: unknown;
    idempotency_key?: unknown;
  };
  const email =
    typeof body.advertiser_email === "string" ? body.advertiser_email.trim() : "";
  if (!email) {
    throw new ValidationError("advertiser_email is required.");
  }
  const amount =
    typeof body.amount_micropaise === "number" ? body.amount_micropaise : NaN;
  const key =
    typeof body.idempotency_key === "string" && body.idempotency_key.trim()
      ? body.idempotency_key.trim()
      : `funding:${email}:${amount}:${Date.now()}`;
  const result = await confirmAdvertiserFundingPg({
    advertiserEmail: email,
    amountMicropaise: amount,
    idempotencyKey: key,
  });
  if (!result.ok) {
    res.status(400).json({ success: false, message: result.reason });
    return;
  }
  res.status(200).json({ success: true, data: result });
}));

app.post(
  "/api/v1/admin/campaigns/:id/provider",
  requireAdminKey,
  safeRoute(async (req, res) => {
    const id =
      typeof req.params.id === "string" ? req.params.id.trim() : "";
    const providerKey =
      typeof req.body?.provider_key === "string" ? req.body.provider_key.trim() : "";
    if (!id || !providerKey) {
      res.status(400).json({ success: false, message: "Invalid campaign or provider." });
      return;
    }
    const ok = await setCampaignProviderPg(id, providerKey);
    res.status(ok ? 200 : 404).json({
      success: ok,
      message: ok ? "Provider updated." : "Campaign or provider not found.",
    });
  }),
);

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

app.get("/api/v1/admin/campaigns", requireAdminKey, safeRoute(async (_req, res) => {
  res.status(200).json({
    success: true,
    data: { campaigns: await listCampaignsAdminPg() },
  });
}));

app.post(
  "/api/v1/admin/campaigns/:id/review",
  requireAdminKey,
  safeRoute(async (req, res) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) {
      throw new ValidationError("campaign id is required.");
    }
    const decisionRaw = (req.body as ReviewCampaignBody).decision;
    const decision =
      typeof decisionRaw === "string" ? decisionRaw.trim() : "";

    if (decision !== "approve" && decision !== "reject") {
      throw new ValidationError("decision must be 'approve' or 'reject'.");
    }

    const result = await reviewCampaignPg(id, decision);

    if (!result.ok) {
      const message =
        result.reason === "not_found"
          ? "Campaign not found."
          : "Campaign is not pending review.";

      res.status(result.reason === "not_found" ? 404 : 400).json({
        success: false,
        message,
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: { id, status: result.status },
    });
  }),
);

app.get("/api/v1/admin/topups", requireAdminKey, safeRoute((_req, res) => {
  res.status(200).json({
    success: true,
    data: { topups: listTopupRequests() },
  });
}));

app.post(
  "/api/v1/admin/topups/:id/resolve",
  requireAdminKey,
  (req: Request, res: Response) => {
    try {
      const id = parsePositiveInt(req.params.id, "id");
      const statusRaw = (req.body as ResolveTopupBody).status;
      const status = typeof statusRaw === "string" ? statusRaw.trim() : "";

      if (status !== "paid" && status !== "rejected") {
        throw new ValidationError("status must be 'paid' or 'rejected'.");
      }

      const result = resolveTopupRequest(id, status);
      if (!result.ok) {
        const message =
          result.reason === "not_found"
            ? "Top-up request not found."
            : result.reason === "already_resolved"
              ? "Top-up request has already been resolved."
              : "Invalid top-up status.";
        res.status(result.reason === "not_found" ? 404 : 400).json({
          success: false,
          message,
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          topup: result.topup,
          campaign: result.campaign,
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

      console.error("[Omni Admin] Resolve top-up error", error);
      res.status(500).json({
        success: false,
        message: "Internal server error.",
      });
    }
  },
);

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
    .badge-requested { color: #fbbf24; }
    .badge-paid { color: #22c55e; }
    .badge-rejected { color: #fca5a5; }
    .badge-active { color: #22c55e; }
    .badge-paused { color: #a1a1aa; }
    .badge-exhausted { color: #fca5a5; }
    .badge-pending_review { color: #fbbf24; }
    .spend-track {
      width: 120px;
      height: 8px;
      background: #27272a;
      border-radius: 4px;
      overflow: hidden;
      display: inline-block;
      vertical-align: middle;
      margin-right: 8px;
    }
    .spend-fill {
      height: 100%;
      background: #22c55e;
      border-radius: 4px;
    }
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
    <div class="stat-card"><div class="stat-label">Ad Revenue (earner/pool/platform)</div><div class="stat-value" id="statRevenue" style="font-size:1rem">—</div></div>
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
    <h2>Campaigns</h2>
    <div id="campaignsTable"></div>
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
      function fmtPaise(paise) {
        return "₹" + (Number(paise || 0) / 100).toFixed(2);
      }
      document.getElementById("statRevenue").textContent =
        fmtPaise(data.revenueEarnerPaise) + " / " +
        fmtPaise(data.revenuePoolPaise) + " / " +
        fmtPaise(data.revenuePlatformPaise);
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
    function fmtPaise(paise) {
      return "₹" + (Number(paise) / 100).toFixed(2);
    }
    function campaignStatusBadge(status) {
      return '<span class="badge-' + esc(status) + '">' + esc(status) + '</span>';
    }
    function renderCampaigns(campaigns) {
      var container = document.getElementById("campaignsTable");
      if (!campaigns.length) {
        container.innerHTML = '<div class="empty">No campaigns yet.</div>';
        return;
      }
      var rows = campaigns.map(function(c) {
        var pct = c.total_budget_paise > 0
          ? Math.min(100, (c.spent_paise / c.total_budget_paise) * 100)
          : 0;
        var actions = c.status === "pending_review"
          ? '<button type="button" class="btn-sm" data-campaign-id="' + c.id + '" data-decision="approve">Approve</button>' +
            '<button type="button" class="btn-sm btn-reject" data-campaign-id="' + c.id + '" data-decision="reject">Reject</button>'
          : '—';
        return '<tr data-id="' + c.id + '">' +
          '<td>' + c.id + '</td>' +
          '<td>' + esc(c.advertiser_email) + '</td>' +
          '<td>' + esc(c.headline) + '</td>' +
          '<td>' + campaignStatusBadge(c.status) + '</td>' +
          '<td>' +
          '<div class="spend-track"><div class="spend-fill" style="width:' + pct + '%"></div></div>' +
          esc(fmtPaise(c.spent_paise)) + ' / ' + esc(fmtPaise(c.total_budget_paise)) +
          '</td>' +
          '<td>' + c.impressions + '</td>' +
          '<td>' + c.clicks + '</td>' +
          '<td>' + actions + '</td>' +
          '</tr>';
      }).join("");
      container.innerHTML = '<table><thead><tr><th>ID</th><th>Advertiser</th><th>Headline</th><th>Status</th><th>Spend</th><th>Impr.</th><th>Clicks</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table>';
      container.querySelectorAll("[data-campaign-id]").forEach(function(btn) {
        btn.addEventListener("click", function() {
          reviewCampaign(Number(btn.getAttribute("data-campaign-id")), btn.getAttribute("data-decision"));
        });
      });
    }
    async function reviewCampaign(id, decision) {
      hideError();
      try {
        var response = await fetch(adminUrl("/api/v1/admin/campaigns/" + id + "/review"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: decision }),
        });
        var json = await response.json();
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Failed to review campaign.");
        }
        await loadCampaigns();
      } catch (err) {
        showError(err instanceof Error ? err.message : "Failed to review campaign.");
      }
    }
    async function loadCampaigns() {
      var response = await fetch(adminUrl("/api/v1/admin/campaigns"));
      if (!response.ok) throw new Error("Failed to load campaigns.");
      var json = await response.json();
      if (!json.success) throw new Error("API returned an error response.");
      renderCampaigns(json.data.campaigns);
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
          fetch(adminUrl("/api/v1/admin/campaigns")),
        ]);
        if (!responses[0].ok || !responses[1].ok || !responses[2].ok || !responses[3].ok || !responses[4].ok || !responses[5].ok || !responses[6].ok) {
          throw new Error("One or more API requests failed.");
        }
        var statsJson = await responses[0].json();
        var partnersJson = await responses[1].json();
        var surveysJson = await responses[2].json();
        var txJson = await responses[3].json();
        var adsJson = await responses[4].json();
        var redemptionsJson = await responses[5].json();
        var campaignsJson = await responses[6].json();
        if (!statsJson.success || !partnersJson.success || !surveysJson.success || !txJson.success || !adsJson.success || !redemptionsJson.success || !campaignsJson.success) {
          throw new Error("API returned an error response.");
        }
        renderStats(statsJson.data);
        renderPartners(partnersJson.data);
        renderSurveys(surveysJson.data.results);
        renderAdStats(adsJson.data);
        renderCampaigns(campaignsJson.data.campaigns);
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

const ADVERTISE_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OmniPiggy — Advertise</title>
  <style>
    :root {
      --bg: #0c0c0e;
      --panel: #141416;
      --border: #27272a;
      --text: #e4e4e7;
      --muted: #a1a1aa;
      --green: #22c55e;
      --green-dim: #16a34a;
      --warn: #fbbf24;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Segoe UI", system-ui, sans-serif;
      background:
        radial-gradient(1200px 500px at 10% -10%, rgba(34,197,94,0.12), transparent 55%),
        radial-gradient(900px 400px at 90% 0%, rgba(34,197,94,0.06), transparent 50%),
        var(--bg);
      color: var(--text);
      min-height: 100vh;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 28px;
      border-bottom: 1px solid var(--border);
    }
    .brand {
      font-size: 1.35rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: #fafafa;
    }
    .brand span { color: var(--green); }
    .nav a {
      color: var(--muted);
      text-decoration: none;
      margin-left: 16px;
      font-size: 0.9rem;
    }
    .nav a:hover { color: var(--green); }
    main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 32px 20px 64px;
    }
    h1 {
      font-size: 1.75rem;
      margin-bottom: 8px;
      color: #fafafa;
    }
    .lead {
      color: var(--muted);
      margin-bottom: 28px;
      max-width: 52ch;
      line-height: 1.5;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.1fr 0.9fr;
      gap: 24px;
    }
    @media (max-width: 840px) {
      .grid { grid-template-columns: 1fr; }
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 22px;
    }
    label {
      display: block;
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .field { margin-bottom: 14px; }
    input, textarea, select {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--text);
      font: inherit;
    }
    input:focus, textarea:focus {
      outline: none;
      border-color: var(--green);
    }
    textarea { min-height: 84px; resize: vertical; }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    button {
      background: var(--green);
      color: var(--bg);
      border: none;
      border-radius: 8px;
      padding: 12px 18px;
      font-weight: 700;
      cursor: pointer;
      width: 100%;
    }
    button:hover { background: var(--green-dim); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .preview-label {
      font-size: 0.75rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 12px;
    }
    .ad-preview {
      background: linear-gradient(160deg, #17171a, #101012);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px;
    }
    .ad-preview h3 {
      font-size: 1.05rem;
      margin-bottom: 8px;
      color: #fafafa;
    }
    .ad-preview p {
      color: var(--muted);
      font-size: 0.92rem;
      line-height: 1.45;
      margin-bottom: 14px;
      min-height: 2.8em;
    }
    .cta {
      display: inline-block;
      background: var(--green);
      color: var(--bg);
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 700;
      text-decoration: none;
    }
    .error {
      display: none;
      background: #450a0a;
      color: #fca5a5;
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 14px;
    }
    .success {
      display: none;
      background: #052e16;
      border: 1px solid #166534;
      border-radius: 12px;
      padding: 18px;
      margin-bottom: 20px;
    }
    .success h2 {
      color: var(--green);
      font-size: 1.1rem;
      margin-bottom: 8px;
    }
    .key-box {
      margin-top: 14px;
      background: var(--bg);
      border: 1px dashed var(--warn);
      border-radius: 8px;
      padding: 12px;
    }
    .key-box code {
      display: block;
      word-break: break-all;
      color: var(--warn);
      margin: 8px 0;
      font-size: 0.9rem;
    }
    .copy-btn {
      width: auto;
      padding: 8px 12px;
      font-size: 0.8rem;
    }
    .hint { color: var(--muted); font-size: 0.85rem; margin-top: 8px; }
  </style>
</head>
<body>
  <header>
    <div class="brand">Omni<span>Piggy</span></div>
    <nav class="nav">
      <a href="/advertiser">Advertiser login</a>
    </nav>
  </header>
  <main>
    <h1>Launch a campaign</h1>
    <p class="lead">Build your OmniPiggy ad, preview it live, and submit for review. Approved campaigns serve during AI wait time.</p>
    <div id="error" class="error"></div>
    <div id="success" class="success"></div>
    <div class="grid">
      <form class="card" id="campaignForm">
        <div class="field">
          <label for="email">Advertiser email</label>
          <input id="email" type="email" required placeholder="you@brand.com" autocomplete="email">
        </div>
        <div class="field">
          <label for="headline">Headline</label>
          <input id="headline" type="text" required maxlength="80" placeholder="Short punchy headline">
        </div>
        <div class="field">
          <label for="body">Body</label>
          <textarea id="body" required maxlength="220" placeholder="One or two lines about your offer"></textarea>
        </div>
        <div class="row">
          <div class="field">
            <label for="ctaLabel">CTA label</label>
            <input id="ctaLabel" type="text" required maxlength="32" placeholder="Learn more">
          </div>
          <div class="field">
            <label for="ctaUrl">CTA URL (https)</label>
            <input id="ctaUrl" type="url" required placeholder="https://example.com">
          </div>
        </div>
        <div class="row">
          <div class="field">
            <label for="cpm">CPM (₹)</label>
            <input id="cpm" type="number" min="1" step="1" value="50" required>
          </div>
          <div class="field">
            <label for="budget">Budget (₹)</label>
            <input id="budget" type="number" min="1" step="1" value="500" required>
          </div>
        </div>
        <p class="hint">Budget and CPM are converted to paise on submit (₹1 = 100 paise).</p>
        <button type="submit" id="submitBtn">Submit for review</button>
      </form>
      <aside class="card">
        <div class="preview-label">Live preview</div>
        <div class="ad-preview">
          <h3 id="prevHeadline">Your headline</h3>
          <p id="prevBody">Your supporting copy appears here.</p>
          <a class="cta" id="prevCta" href="#" onclick="return false;">Learn more</a>
        </div>
      </aside>
    </div>
  </main>
  <script>
    function esc(text) {
      var d = document.createElement("div");
      d.textContent = text == null ? "" : String(text);
      return d.innerHTML;
    }
    function rupeesToPaise(value) {
      var n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return NaN;
      return Math.round(n * 100);
    }
    function syncPreview() {
      document.getElementById("prevHeadline").textContent =
        document.getElementById("headline").value.trim() || "Your headline";
      document.getElementById("prevBody").textContent =
        document.getElementById("body").value.trim() || "Your supporting copy appears here.";
      document.getElementById("prevCta").textContent =
        document.getElementById("ctaLabel").value.trim() || "Learn more";
    }
    ["headline", "body", "ctaLabel"].forEach(function(id) {
      document.getElementById(id).addEventListener("input", syncPreview);
    });
    syncPreview();

    document.getElementById("campaignForm").addEventListener("submit", async function(e) {
      e.preventDefault();
      var err = document.getElementById("error");
      var success = document.getElementById("success");
      var btn = document.getElementById("submitBtn");
      err.style.display = "none";
      success.style.display = "none";
      btn.disabled = true;

      var cpmPaise = rupeesToPaise(document.getElementById("cpm").value);
      var budgetPaise = rupeesToPaise(document.getElementById("budget").value);
      if (!Number.isInteger(cpmPaise) || !Number.isInteger(budgetPaise)) {
        err.textContent = "CPM and budget must be positive amounts in rupees.";
        err.style.display = "block";
        btn.disabled = false;
        return;
      }

      try {
        var response = await fetch("/api/v1/campaigns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            advertiser_email: document.getElementById("email").value.trim(),
            headline: document.getElementById("headline").value.trim(),
            body: document.getElementById("body").value.trim(),
            cta_label: document.getElementById("ctaLabel").value.trim(),
            cta_url: document.getElementById("ctaUrl").value.trim(),
            cpm_paise: cpmPaise,
            total_budget_paise: budgetPaise
          })
        });
        var json = await response.json();
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Failed to create campaign.");
        }

        var html = "<h2>Campaign submitted</h2>" +
          "<p>Campaign #" + esc(json.data.id) + " is <strong>" + esc(json.data.status) + "</strong>. " +
          esc(json.data.note) + "</p>";

        if (json.data.mgmt_key) {
          html += '<div class="key-box">' +
            "<strong>Save your management key</strong>" +
            "<p class=\\"hint\\">You'll need this to log in at <a href=\\"/advertiser\\">/advertiser</a>. It is shown only once.</p>" +
            "<code id=\\"mgmtKey\\">" + esc(json.data.mgmt_key) + "</code>" +
            '<button type="button" class="copy-btn" id="copyKeyBtn">Copy key</button>' +
            "</div>";
          try {
            sessionStorage.setItem("omni_adv_email", document.getElementById("email").value.trim().toLowerCase());
            sessionStorage.setItem("omni_adv_key", json.data.mgmt_key);
          } catch (storageErr) {}
        }

        success.innerHTML = html;
        success.style.display = "block";
        var copyBtn = document.getElementById("copyKeyBtn");
        if (copyBtn) {
          copyBtn.addEventListener("click", async function() {
            var key = document.getElementById("mgmtKey").textContent;
            try {
              await navigator.clipboard.writeText(key);
              copyBtn.textContent = "Copied";
            } catch (copyErr) {
              copyBtn.textContent = "Copy failed";
            }
          });
        }
        document.getElementById("campaignForm").reset();
        syncPreview();
      } catch (ex) {
        err.textContent = ex instanceof Error ? ex.message : "Failed to create campaign.";
        err.style.display = "block";
      } finally {
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;

const ADVERTISER_PORTAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OmniPiggy — Advertiser Portal</title>
  <style>
    :root {
      --bg: #0c0c0e;
      --panel: #141416;
      --border: #27272a;
      --text: #e4e4e7;
      --muted: #a1a1aa;
      --green: #22c55e;
      --green-dim: #16a34a;
      --warn: #fbbf24;
      --danger: #fca5a5;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Segoe UI", system-ui, sans-serif;
      background:
        radial-gradient(1000px 420px at 0% -10%, rgba(34,197,94,0.1), transparent 55%),
        var(--bg);
      color: var(--text);
      min-height: 100vh;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 18px 24px;
      border-bottom: 1px solid var(--border);
    }
    .brand { font-size: 1.25rem; font-weight: 700; color: #fafafa; }
    .brand span { color: var(--green); }
    .nav a, .nav button.link {
      color: var(--muted);
      text-decoration: none;
      margin-left: 14px;
      font-size: 0.9rem;
      background: none;
      border: none;
      cursor: pointer;
      font: inherit;
    }
    .nav a:hover, .nav button.link:hover { color: var(--green); }
    main { max-width: 960px; margin: 0 auto; padding: 28px 18px 64px; }
    h1 { font-size: 1.55rem; margin-bottom: 8px; color: #fafafa; }
    .lead { color: var(--muted); margin-bottom: 22px; }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
    }
    label {
      display: block;
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .field { margin-bottom: 12px; }
    input {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--text);
      font: inherit;
    }
    input:focus { outline: none; border-color: var(--green); }
    button {
      background: var(--green);
      color: var(--bg);
      border: none;
      border-radius: 8px;
      padding: 10px 14px;
      font-weight: 700;
      cursor: pointer;
    }
    button:hover { background: var(--green-dim); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    button.secondary {
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border);
    }
    button.danger {
      background: transparent;
      color: var(--danger);
      border: 1px solid #7f1d1d;
    }
    .error {
      display: none;
      background: #450a0a;
      color: var(--danger);
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 14px;
    }
    .login-wrap { max-width: 420px; margin: 40px auto; }
    .campaign-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 10px;
    }
    .campaign-head h2 { font-size: 1.05rem; color: #fafafa; }
    .badge {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid var(--border);
      color: var(--muted);
      white-space: nowrap;
    }
    .badge.active { color: var(--green); border-color: #166534; }
    .badge.paused { color: var(--muted); }
    .badge.pending_review { color: var(--warn); border-color: #854d0e; }
    .badge.exhausted { color: var(--danger); border-color: #7f1d1d; }
    .spend-label { font-size: 0.85rem; color: var(--muted); margin-bottom: 6px; }
    .spend-track {
      height: 8px;
      background: #27272a;
      border-radius: 999px;
      overflow: hidden;
      margin-bottom: 12px;
    }
    .spend-fill { height: 100%; background: var(--green); }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      color: var(--muted);
      font-size: 0.85rem;
      margin-bottom: 14px;
    }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .topup-form {
      display: none;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }
    .topup-form.open { display: block; }
    .topup-row { display: flex; gap: 8px; align-items: end; }
    .topup-row .field { flex: 1; margin-bottom: 0; }
    .note {
      margin-top: 10px;
      color: var(--warn);
      font-size: 0.85rem;
      display: none;
    }
    .empty { color: var(--muted); font-style: italic; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <header>
    <div class="brand">Omni<span>Piggy</span></div>
    <nav class="nav">
      <a href="/advertise">New campaign</a>
      <button type="button" class="link hidden" id="logoutBtn">Log out</button>
    </nav>
  </header>
  <main>
    <div id="error" class="error"></div>
    <section id="loginView" class="login-wrap">
      <h1>Advertiser portal</h1>
      <p class="lead">Sign in with your email and management key to manage campaigns.</p>
      <form class="card" id="loginForm">
        <div class="field">
          <label for="loginEmail">Email</label>
          <input id="loginEmail" type="email" required autocomplete="email">
        </div>
        <div class="field">
          <label for="loginKey">Management key</label>
          <input id="loginKey" type="password" required autocomplete="current-password" placeholder="adv_…">
        </div>
        <button type="submit" id="loginBtn">Sign in</button>
      </form>
    </section>
    <section id="dashView" class="hidden">
      <h1>Your campaigns</h1>
      <p class="lead" id="dashEmail"></p>
      <div id="campaignList"></div>
    </section>
  </main>
  <script>
    var STORAGE_EMAIL = "omni_adv_email";
    var STORAGE_KEY = "omni_adv_key";

    function esc(text) {
      var d = document.createElement("div");
      d.textContent = text == null ? "" : String(text);
      return d.innerHTML;
    }
    function showError(msg) {
      var el = document.getElementById("error");
      el.textContent = msg;
      el.style.display = "block";
    }
    function hideError() {
      document.getElementById("error").style.display = "none";
    }
    function getCreds() {
      try {
        var email = sessionStorage.getItem(STORAGE_EMAIL) || "";
        var key = sessionStorage.getItem(STORAGE_KEY) || "";
        if (!email || !key) return null;
        return { email: email, key: key };
      } catch (e) {
        return null;
      }
    }
    function setCreds(email, key) {
      sessionStorage.setItem(STORAGE_EMAIL, email);
      sessionStorage.setItem(STORAGE_KEY, key);
    }
    function clearCreds() {
      sessionStorage.removeItem(STORAGE_EMAIL);
      sessionStorage.removeItem(STORAGE_KEY);
    }
    function authHeaders() {
      var c = getCreds();
      return {
        "Content-Type": "application/json",
        "X-Adv-Email": c.email,
        "X-Adv-Key": c.key
      };
    }
    function fmtPaise(paise) {
      return "₹" + (Number(paise) / 100).toFixed(2);
    }
    function ctr(impr, clicks) {
      if (!impr) return "0%";
      return ((clicks / impr) * 100).toFixed(1) + "%";
    }
    function showLogin() {
      document.getElementById("loginView").classList.remove("hidden");
      document.getElementById("dashView").classList.add("hidden");
      document.getElementById("logoutBtn").classList.add("hidden");
    }
    function showDash() {
      document.getElementById("loginView").classList.add("hidden");
      document.getElementById("dashView").classList.remove("hidden");
      document.getElementById("logoutBtn").classList.remove("hidden");
    }

    async function loadCampaigns() {
      hideError();
      var creds = getCreds();
      if (!creds) {
        showLogin();
        return;
      }
      var response = await fetch("/api/v1/advertiser/campaigns", {
        headers: authHeaders()
      });
      var json = await response.json().catch(function() { return {}; });
      if (response.status === 401) {
        clearCreds();
        showLogin();
        showError("Invalid email or management key.");
        return;
      }
      if (!response.ok || !json.success) {
        throw new Error(json.message || "Failed to load campaigns.");
      }
      showDash();
      document.getElementById("dashEmail").textContent = "Signed in as " + creds.email;
      renderCampaigns(json.data.campaigns || []);
    }

    function renderCampaigns(campaigns) {
      var container = document.getElementById("campaignList");
      if (!campaigns.length) {
        container.innerHTML = '<div class="card empty">No campaigns yet. <a href="/advertise">Create one</a>.</div>';
        return;
      }
      container.innerHTML = campaigns.map(function(c) {
        var pct = c.total_budget_paise > 0
          ? Math.min(100, (c.spent_paise / c.total_budget_paise) * 100)
          : 0;
        var pauseResume = "";
        if (c.status === "active") {
          pauseResume = '<button type="button" class="secondary" data-action="pause" data-id="' + c.id + '">Pause</button>';
        } else if (c.status === "paused") {
          pauseResume = '<button type="button" class="secondary" data-action="resume" data-id="' + c.id + '">Resume</button>';
        }
        return '<article class="card" data-campaign="' + c.id + '">' +
          '<div class="campaign-head">' +
          "<h2>" + esc(c.headline) + "</h2>" +
          '<span class="badge ' + esc(c.status) + '">' + esc(c.status) + "</span>" +
          "</div>" +
          '<div class="spend-label">' + esc(fmtPaise(c.spent_paise)) + " of " + esc(fmtPaise(c.total_budget_paise)) + " spent</div>" +
          '<div class="spend-track"><div class="spend-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="meta">' +
          "<span>" + c.impressions + " impressions</span>" +
          "<span>" + c.clicks + " clicks</span>" +
          "<span>CTR " + esc(ctr(c.impressions, c.clicks)) + "</span>" +
          "</div>" +
          '<div class="actions">' +
          pauseResume +
          '<button type="button" data-action="topup-toggle" data-id="' + c.id + '">Top up</button>' +
          "</div>" +
          '<div class="topup-form" id="topup-' + c.id + '">' +
          '<div class="topup-row">' +
          '<div class="field"><label>Amount (₹)</label><input type="number" min="1" step="1" id="topup-amount-' + c.id + '" value="500"></div>' +
          '<button type="button" data-action="topup-submit" data-id="' + c.id + '">Request top-up</button>' +
          "</div>" +
          '<div class="note" id="topup-note-' + c.id + '">Requested — we\\'ll email a UPI payment link; budget updates once paid.</div>' +
          "</div>" +
          "</article>";
      }).join("");

      container.querySelectorAll("[data-action]").forEach(function(btn) {
        btn.addEventListener("click", function() {
          var id = Number(btn.getAttribute("data-id"));
          var action = btn.getAttribute("data-action");
          if (action === "pause") return pauseResume(id, "pause");
          if (action === "resume") return pauseResume(id, "resume");
          if (action === "topup-toggle") {
            document.getElementById("topup-" + id).classList.toggle("open");
            return;
          }
          if (action === "topup-submit") return submitTopup(id);
        });
      });
    }

    async function pauseResume(id, action) {
      hideError();
      try {
        var response = await fetch("/api/v1/advertiser/campaigns/" + id + "/" + action, {
          method: "POST",
          headers: authHeaders()
        });
        var json = await response.json().catch(function() { return {}; });
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Action failed.");
        }
        await loadCampaigns();
      } catch (err) {
        showError(err instanceof Error ? err.message : "Action failed.");
      }
    }

    async function submitTopup(id) {
      hideError();
      var rupees = Number(document.getElementById("topup-amount-" + id).value);
      var amount_paise = Math.round(rupees * 100);
      if (!Number.isInteger(amount_paise) || amount_paise <= 0) {
        showError("Enter a positive top-up amount in rupees.");
        return;
      }
      try {
        var response = await fetch("/api/v1/advertiser/campaigns/" + id + "/topup", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ amount_paise: amount_paise })
        });
        var json = await response.json().catch(function() { return {}; });
        if (!response.ok || !json.success) {
          throw new Error(json.message || "Top-up request failed.");
        }
        var note = document.getElementById("topup-note-" + id);
        note.style.display = "block";
      } catch (err) {
        showError(err instanceof Error ? err.message : "Top-up request failed.");
      }
    }

    document.getElementById("loginForm").addEventListener("submit", async function(e) {
      e.preventDefault();
      hideError();
      var email = document.getElementById("loginEmail").value.trim().toLowerCase();
      var key = document.getElementById("loginKey").value.trim();
      setCreds(email, key);
      var btn = document.getElementById("loginBtn");
      btn.disabled = true;
      try {
        await loadCampaigns();
      } catch (err) {
        clearCreds();
        showLogin();
        showError(err instanceof Error ? err.message : "Sign-in failed.");
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("logoutBtn").addEventListener("click", function() {
      clearCreds();
      hideError();
      showLogin();
    });

    (async function init() {
      var creds = getCreds();
      if (!creds) {
        showLogin();
        return;
      }
      document.getElementById("loginEmail").value = creds.email;
      try {
        await loadCampaigns();
      } catch (err) {
        showLogin();
        showError(err instanceof Error ? err.message : "Failed to restore session.");
      }
    })();
  </script>
</body>
</html>`;

app.get("/advertise", (_req: Request, res: Response) => {
  res.status(200).type("html").send(ADVERTISE_PAGE_HTML);
});

app.get("/advertiser", (_req: Request, res: Response) => {
  res.status(200).type("html").send(ADVERTISER_PORTAL_HTML);
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
  console.info(
    `[Omni Backend] Exchange: POST /api/v1/ad/request + /api/v1/impression/qualify`,
  );
});

process.on("uncaughtException", (error) => {
  console.error("[Omni Backend] uncaughtException (process kept alive):", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Omni Backend] unhandledRejection (process kept alive):", reason);
});
