import assert from "node:assert/strict";
import { WaitStateMachine } from "../src/content/state-machine";
import { formatMicropaiseDisplay } from "../src/shared/format";

const sm = new WaitStateMachine();
assert.equal(sm.getState(), "IDLE");
sm.beginGeneration();
assert.equal(sm.getState(), "GENERATION_DETECTED");
assert.ok(sm.transition("SESSION_STARTING"));
assert.ok(sm.transition("AD_REQUESTING"));
assert.ok(sm.transition("AD_RENDERED"));
assert.ok(sm.transition("VIEWABILITY_PENDING"));
assert.ok(sm.transition("QUALIFIED"));
assert.ok(sm.transition("SETTLED"));
assert.ok(sm.transition("GENERATION_COMPLETE"));
assert.ok(sm.transition("CLEANUP"));
sm.reset();
assert.equal(sm.getState(), "IDLE");

assert.equal(formatMicropaiseDisplay(600), "0.6p");
assert.equal(formatMicropaiseDisplay(100_000), "₹1");
assert.equal(formatMicropaiseDisplay(0), "₹0");

console.log("PASS: extension unit tests (state machine + format)");
