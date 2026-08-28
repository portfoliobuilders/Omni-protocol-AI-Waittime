/**
 * Canonical money helpers for the Exchange (mirrors shared/money/micropaise.ts).
 * shared/ remains the documented source; keep arithmetic identical.
 */
export const MICROPAISE_PER_PAISE = 1000;
export const PAISE_PER_INR = 100;
export const DEFAULT_USER_REVENUE_SHARE_BPS = 6000;
export const DEFAULT_OMNI_REVENUE_SHARE_BPS = 4000;
export const BPS_DENOMINATOR = 10000;

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe non-negative integer`);
  }
}

export function inrToPaise(inr: number): number {
  assertSafeNonNegativeInteger(inr, "inr");
  return inr * PAISE_PER_INR;
}

export function paiseToMicropaise(paise: number): number {
  assertSafeNonNegativeInteger(paise, "paise");
  return paise * MICROPAISE_PER_PAISE;
}

/** ₹N CPM → micropaise per single impression (floor). */
export function cpmInrToMicropaisePerImpression(cpmInr: number): number {
  if (!Number.isInteger(cpmInr) || cpmInr <= 0) {
    throw new Error("cpmInr must be a positive integer");
  }
  return Math.floor(paiseToMicropaise(inrToPaise(cpmInr)) / 1000);
}

/** CPM already stored as micropaise-per-1000 → per-impression gross. */
export function cpmMicropaiseToPerImpression(cpmMicropaise: number): number {
  assertSafeNonNegativeInteger(cpmMicropaise, "cpmMicropaise");
  return Math.floor(cpmMicropaise / 1000);
}

export function splitRevenueMicropaise(
  grossMicropaise: number,
  userShareBps: number = DEFAULT_USER_REVENUE_SHARE_BPS,
): { user: number; omni: number } {
  assertSafeNonNegativeInteger(grossMicropaise, "grossMicropaise");
  assertSafeNonNegativeInteger(userShareBps, "userShareBps");
  if (userShareBps > BPS_DENOMINATOR) {
    throw new Error("userShareBps must be <= 10000");
  }
  const user = Math.floor((grossMicropaise * userShareBps) / BPS_DENOMINATOR);
  return { user, omni: grossMicropaise - user };
}

/** Convert legacy integer paise CPM → micropaise CPM (per 1000 impressions). */
export function cpmPaiseToCpmMicropaise(cpmPaise: number): number {
  assertSafeNonNegativeInteger(cpmPaise, "cpmPaise");
  return paiseToMicropaise(cpmPaise);
}
