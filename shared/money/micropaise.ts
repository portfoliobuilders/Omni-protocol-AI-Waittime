/**
 * OmniPiggy central financial utility — integer micropaise arithmetic only.
 *
 * Units:
 *   1 INR  = 100 paise
 *   1 paise = 1000 micropaise
 *
 * IMPORTANT: Amounts here use JavaScript `number` and must stay within
 * Number.MAX_SAFE_INTEGER (2^53 - 1). Postgres / server ledger writes MUST use
 * BIGINT. Never use floating-point for money math on the server of record.
 */

export const MICROPAISE_PER_PAISE = 1000;
export const PAISE_PER_INR = 100;
/** Default user (earner) share: 60.00% */
export const DEFAULT_USER_REVENUE_SHARE_BPS = 6000;
/** Default Omni platform share: 40.00% */
export const DEFAULT_OMNI_REVENUE_SHARE_BPS = 4000;
export const BPS_DENOMINATOR = 10000;

export type RevenueSplitMicropaise = {
  user: number;
  omni: number;
};

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  if (value < 0) {
    throw new Error(`${label} must be >= 0`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `${label} exceeds Number.MAX_SAFE_INTEGER; use BIGINT on the server`,
    );
  }
}

function assertPositiveInteger(value: number, label: string): void {
  assertSafeNonNegativeInteger(value, label);
  if (value <= 0) {
    throw new Error(`${label} must be > 0`);
  }
}

function assertBps(bps: number): void {
  assertSafeNonNegativeInteger(bps, "userShareBps");
  if (bps > BPS_DENOMINATOR) {
    throw new Error(`userShareBps must be <= ${BPS_DENOMINATOR}`);
  }
}

/**
 * Convert whole-rupee INR to paise.
 * Prefer this over accepting fractional INR at the money boundary.
 */
export function inrRupeesInteger(inr: number): number {
  assertSafeNonNegativeInteger(inr, "inr");
  const paise = inr * PAISE_PER_INR;
  if (!Number.isSafeInteger(paise)) {
    throw new Error("INR→paise result exceeds safe integer range");
  }
  return paise;
}

/**
 * Alias kept for call-site clarity. Only accepts integer INR (whole rupees).
 * For fractional display conversion, do not use this — keep money as integers.
 */
export function inrToPaise(inr: number): number {
  return inrRupeesInteger(inr);
}

export function paiseToMicropaise(paise: number): number {
  assertSafeNonNegativeInteger(paise, "paise");
  const micropaise = paise * MICROPAISE_PER_PAISE;
  if (!Number.isSafeInteger(micropaise)) {
    throw new Error("paise→micropaise result exceeds safe integer range");
  }
  return micropaise;
}

/** Floor division — discards fractional micropaise remainder. */
export function micropaiseToPaise(micropaise: number): number {
  assertSafeNonNegativeInteger(micropaise, "micropaise");
  return Math.floor(micropaise / MICROPAISE_PER_PAISE);
}

/**
 * CPM in whole INR → micropaise charged per single impression.
 *
 * Example: ₹10 CPM
 *   = 1000 paise per 1000 impressions
 *   = 1_000_000 micropaise per 1000 impressions
 *   = 1000 micropaise / impression
 */
export function cpmInrToMicropaisePerImpression(cpmInr: number): number {
  assertPositiveInteger(cpmInr, "cpmInr");
  const cpmPaise = inrToPaise(cpmInr);
  const cpmMicropaise = paiseToMicropaise(cpmPaise);
  // per 1000 impressions
  return Math.floor(cpmMicropaise / 1000);
}

/**
 * Split gross micropaise by basis points.
 * user = floor(gross * bps / 10000); omni = gross - user (no leakage).
 */
export function splitRevenueMicropaise(
  grossMicropaise: number,
  userShareBps: number = DEFAULT_USER_REVENUE_SHARE_BPS,
): RevenueSplitMicropaise {
  assertSafeNonNegativeInteger(grossMicropaise, "grossMicropaise");
  assertBps(userShareBps);
  const user = Math.floor((grossMicropaise * userShareBps) / BPS_DENOMINATOR);
  const omni = grossMicropaise - user;
  return { user, omni };
}

/**
 * Display-only formatter. Never use the result for arithmetic or persistence.
 */
export function formatMicropaiseAsInr(
  micropaise: number,
  fractionDigits: number = 4,
): string {
  assertSafeNonNegativeInteger(micropaise, "micropaise");
  if (
    !Number.isInteger(fractionDigits) ||
    fractionDigits < 0 ||
    fractionDigits > 8
  ) {
    throw new Error("fractionDigits must be an integer 0..8");
  }
  const inr =
    micropaise / (MICROPAISE_PER_PAISE * PAISE_PER_INR);
  return `₹${inr.toFixed(fractionDigits)}`;
}
