export type ExchangeErrorCode =
  | "INVALID_PLATFORM"
  | "INVALID_USER_ID"
  | "USER_INIT_FAILED"
  | "WAIT_SESSION_INSERT_FAILED"
  | "SUPABASE_UNAVAILABLE"
  | "DB_CONSTRAINT_ERROR";

export class ExchangeError extends Error {
  readonly code: ExchangeErrorCode;
  readonly constraint: string | undefined;
  readonly pgCode: string | undefined;

  constructor(
    code: ExchangeErrorCode,
    message: string,
    extras?: { constraint?: string; pgCode?: string },
  ) {
    super(message);
    this.name = "ExchangeError";
    this.code = code;
    this.constraint = extras?.constraint;
    this.pgCode = extras?.pgCode;
  }
}

const UNAVAILABLE_RE =
  /fetch failed|econnrefused|enotfound|etimedout|econnreset|network|socket|unavailable/i;

const CONSTRAINT_CODES = new Set(["23503", "23505", "23514", "23P01"]);

export function clientSafeExchangeMessage(code: ExchangeErrorCode): string {
  switch (code) {
    case "INVALID_PLATFORM":
      return "Unsupported wait-inventory platform.";
    case "INVALID_USER_ID":
      return "userId is required and must be a non-empty string.";
    case "USER_INIT_FAILED":
      return "Could not initialize user session.";
    case "WAIT_SESSION_INSERT_FAILED":
      return "Could not create wait session.";
    case "SUPABASE_UNAVAILABLE":
      return "Session service unavailable.";
    case "DB_CONSTRAINT_ERROR":
      return "Could not create wait session.";
    default:
      return "Session could not be started.";
  }
}

export function httpStatusForExchangeCode(code: ExchangeErrorCode): number {
  if (code === "INVALID_PLATFORM" || code === "INVALID_USER_ID") return 400;
  if (code === "SUPABASE_UNAVAILABLE") return 503;
  return 500;
}

type PgLike = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

export function classifySupabaseFailure(
  stage: "profile" | "installation" | "wait_session",
  error: PgLike | Error | unknown,
): ExchangeError {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as PgLike).message ?? "")
        : String(error ?? "");
  const pgCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as PgLike).code ?? "")
      : "";
  const details =
    typeof error === "object" && error !== null && "details" in error
      ? String((error as PgLike).details ?? "")
      : "";

  if (UNAVAILABLE_RE.test(message) || UNAVAILABLE_RE.test(details)) {
    return new ExchangeError("SUPABASE_UNAVAILABLE", message);
  }
  if (pgCode && CONSTRAINT_CODES.has(pgCode)) {
    const constraint = details.match(/[a-z0-9_]+_fkey|[a-z0-9_]+_key|[a-z0-9_]+_check/i)?.[0];
    return new ExchangeError("DB_CONSTRAINT_ERROR", message, {
      pgCode,
      constraint,
    });
  }
  if (stage === "profile" || stage === "installation") {
    return new ExchangeError("USER_INIT_FAILED", message, {
      pgCode: pgCode || undefined,
    });
  }
  return new ExchangeError("WAIT_SESSION_INSERT_FAILED", message, {
    pgCode: pgCode || undefined,
  });
}

/** Local logs only — never include secrets or request bodies. */
export function logExchangeError(
  route: string,
  error: ExchangeError,
  ids?: { userId?: string; platform?: string },
): void {
  console.error("[Omni Exchange]", {
    route,
    code: error.code,
    message: error.message.slice(0, 300),
    constraint: error.constraint ?? null,
    pgCode: error.pgCode ?? null,
    userIdPrefix: ids?.userId ? ids.userId.slice(0, 8) : null,
    platform: ids?.platform ?? null,
  });
}
