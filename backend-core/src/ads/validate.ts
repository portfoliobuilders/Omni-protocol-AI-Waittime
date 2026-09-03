import { MICROPAISE_PER_PAISE, PAISE_PER_INR } from "../money/micropaise.js";

export const CREATIVE_LIMITS = {
  advertiserName: 40,
  headline: 80,
  body: 120,
  ctaLabel: 32,
  campaignName: 80,
} as const;

export const LOGO_MAX_BYTES = 1_048_576;
export const LOGO_ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export class AdsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdsValidationError";
  }
}

function assertSafeNonNegInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new AdsValidationError(`${label} must be a safe non-negative integer`);
  }
}

export function rupeesToMicropaise(rupees: number): number {
  if (!Number.isInteger(rupees) || rupees < 0 || !Number.isSafeInteger(rupees)) {
    throw new AdsValidationError("Amount must be a whole-rupee integer");
  }
  const micropaise = rupees * PAISE_PER_INR * MICROPAISE_PER_PAISE;
  if (!Number.isSafeInteger(micropaise)) {
    throw new AdsValidationError("Amount exceeds safe integer range");
  }
  return micropaise;
}

export function cpmRupeesToCpmMicropaise(cpmRupees: number): number {
  if (!Number.isInteger(cpmRupees) || cpmRupees <= 0) {
    throw new AdsValidationError("CPM must be a positive whole-rupee integer");
  }
  return rupeesToMicropaise(cpmRupees);
}

export function isHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const BLOCKED_SCHEMES = /^(javascript|data|file|vbscript|blob):/i;

export function assertHttpsUrl(url: string, label = "URL"): string {
  const trimmed = url.trim();
  if (!trimmed) throw new AdsValidationError(`${label} is required`);
  if (BLOCKED_SCHEMES.test(trimmed)) {
    throw new AdsValidationError(`${label} uses a blocked scheme`);
  }
  if (!isHttpsUrl(trimmed) || !new URL(trimmed).hostname) {
    throw new AdsValidationError(`${label} must be https://`);
  }
  if (trimmed.length > 2048) {
    throw new AdsValidationError(`${label} is too long`);
  }
  return trimmed;
}

function clampField(value: unknown, max: number, label: string, required = true): string {
  if (typeof value !== "string") {
    if (required) throw new AdsValidationError(`${label} is required`);
    return "";
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw new AdsValidationError(`${label} is required`);
  if (trimmed.length > max) {
    throw new AdsValidationError(`${label} must be at most ${max} characters`);
  }
  return trimmed;
}

export function validateCreativeInput(input: {
  advertiserName?: unknown;
  headline?: unknown;
  body?: unknown;
  ctaLabel?: unknown;
  ctaUrl?: unknown;
}): {
  advertiserName: string;
  headline: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
} {
  return {
    advertiserName: clampField(
      input.advertiserName,
      CREATIVE_LIMITS.advertiserName,
      "Advertiser name",
    ),
    headline: clampField(input.headline, CREATIVE_LIMITS.headline, "Headline"),
    body: clampField(input.body, CREATIVE_LIMITS.body, "Body", false),
    ctaLabel: clampField(input.ctaLabel, CREATIVE_LIMITS.ctaLabel, "CTA label"),
    ctaUrl: assertHttpsUrl(
      typeof input.ctaUrl === "string" ? input.ctaUrl : "",
      "CTA URL",
    ),
  };
}

export function detectImageMime(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function validateLogoUpload(bytes: Buffer, claimedMime?: string): {
  mime: "image/png" | "image/jpeg" | "image/webp";
  ext: "png" | "jpg" | "webp";
} {
  if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) {
    throw new AdsValidationError("Logo must be a PNG, JPEG, or WebP under 1 MB");
  }
  const mime = detectImageMime(bytes);
  if (!mime || !LOGO_ALLOWED_MIME.has(mime)) {
    throw new AdsValidationError("Logo must be PNG, JPEG, or WebP (SVG and executables are not allowed)");
  }
  if (claimedMime && claimedMime !== mime && !(claimedMime === "image/jpg" && mime === "image/jpeg")) {
    throw new AdsValidationError("Logo MIME type does not match file contents");
  }
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  return { mime, ext };
}

export function assertSafeIntegerMicropaise(value: unknown, label: string, min = 1): number {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new AdsValidationError(`${label} must be an integer micropaise amount`);
  }
  assertSafeNonNegInt(value, label);
  if (value < min) throw new AdsValidationError(`${label} is below the minimum`);
  return value;
}
