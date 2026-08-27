/**
 * Run from backend-core: npm run test:money
 * Or: npx tsx shared/money/micropaise.test.ts
 */
import assert from "node:assert/strict";
import {
  BPS_DENOMINATOR,
  DEFAULT_OMNI_REVENUE_SHARE_BPS,
  DEFAULT_USER_REVENUE_SHARE_BPS,
  cpmInrToMicropaisePerImpression,
  formatMicropaiseAsInr,
  inrToPaise,
  micropaiseToPaise,
  paiseToMicropaise,
  splitRevenueMicropaise,
} from "./micropaise";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    throw err;
  }
}

test("constants: 60/40 bps", () => {
  assert.equal(DEFAULT_USER_REVENUE_SHARE_BPS, 6000);
  assert.equal(DEFAULT_OMNI_REVENUE_SHARE_BPS, 4000);
  assert.equal(
    DEFAULT_USER_REVENUE_SHARE_BPS + DEFAULT_OMNI_REVENUE_SHARE_BPS,
    BPS_DENOMINATOR,
  );
});

test("₹10 CPM → 1000 micropaise/impression", () => {
  assert.equal(cpmInrToMicropaisePerImpression(10), 1000);
});

test("₹50 / ₹100 / ₹250 CPM cases", () => {
  assert.equal(cpmInrToMicropaisePerImpression(50), 5000);
  assert.equal(cpmInrToMicropaisePerImpression(100), 10000);
  assert.equal(cpmInrToMicropaisePerImpression(250), 25000);
});

test("60% → 600, 40% → 400 on 1000 micropaise", () => {
  const split = splitRevenueMicropaise(1000, 6000);
  assert.equal(split.user, 600);
  assert.equal(split.omni, 400);
});

test("1000 impressions × ₹10 CPM → exact 1_000_000 micropaise = ₹10", () => {
  const perImpression = cpmInrToMicropaisePerImpression(10);
  const gross = perImpression * 1000;
  assert.equal(gross, 1_000_000);
  assert.equal(formatMicropaiseAsInr(gross, 0), "₹10");
  assert.equal(formatMicropaiseAsInr(gross, 4), "₹10.0000");
});

test("split never leaks (user + omni === gross)", () => {
  const cases = [0, 1, 7, 999, 1000, 1_000_000, 12_345_678];
  for (const gross of cases) {
    for (const bps of [0, 1, 3333, 6000, 9999, 10000]) {
      const { user, omni } = splitRevenueMicropaise(gross, bps);
      assert.equal(
        user + omni,
        gross,
        `leak at gross=${gross} bps=${bps}: user=${user} omni=${omni}`,
      );
      assert.ok(user >= 0 && omni >= 0);
    }
  }
});

test("paise ↔ micropaise round-trip (floor)", () => {
  assert.equal(paiseToMicropaise(1000), 1_000_000);
  assert.equal(micropaiseToPaise(1_000_000), 1000);
  assert.equal(micropaiseToPaise(1001), 1); // floor
  assert.equal(inrToPaise(10), 1000);
});

test("rejects non-integers / negatives", () => {
  assert.throws(() => inrToPaise(10.5));
  assert.throws(() => inrToPaise(-1));
  assert.throws(() => cpmInrToMicropaisePerImpression(0));
  assert.throws(() => splitRevenueMicropaise(100, 10001));
});

console.log("\nAll micropaise tests passed.");
