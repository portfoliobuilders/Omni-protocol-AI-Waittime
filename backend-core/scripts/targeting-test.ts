import assert from "node:assert/strict";
import { campaignAllowsInventorySurface } from "../src/exchange/targeting.ts";

assert.equal(
  campaignAllowsInventorySurface({
    targetingMode: "specific",
    listedSurfaces: ["chatgpt.com"],
    requestSurface: "chatgpt.com",
  }),
  true,
);
assert.equal(
  campaignAllowsInventorySurface({
    targetingMode: "specific",
    listedSurfaces: ["chatgpt.com"],
    requestSurface: "claude.ai",
  }),
  false,
  "ChatGPT-only must not fill Claude",
);
assert.equal(
  campaignAllowsInventorySurface({
    targetingMode: "specific",
    listedSurfaces: ["claude.ai"],
    requestSurface: "chatgpt.com",
  }),
  false,
  "Claude-only must not fill ChatGPT",
);
assert.equal(
  campaignAllowsInventorySurface({
    targetingMode: "specific",
    listedSurfaces: ["gemini.google.com"],
    requestSurface: "claude.ai",
  }),
  false,
  "Gemini-only must not fill Claude",
);
assert.equal(
  campaignAllowsInventorySurface({
    targetingMode: "specific",
    listedSurfaces: ["gemini.google.com"],
    requestSurface: "gemini.google.com",
  }),
  true,
);
assert.equal(
  campaignAllowsInventorySurface({
    targetingMode: "specific",
    listedSurfaces: [],
    requestSurface: "chatgpt.com",
  }),
  false,
  "specific + zero rows = nowhere",
);
assert.equal(
  campaignAllowsInventorySurface({
    targetingMode: "all_enabled",
    listedSurfaces: [],
    requestSurface: "chatgpt.com",
  }),
  true,
);
assert.equal(
  campaignAllowsInventorySurface({
    targetingMode: "all_enabled",
    listedSurfaces: ["chatgpt.com"],
    requestSurface: "claude.ai",
  }),
  false,
  "listed surfaces always restrict, even if mode is all_enabled",
);
assert.equal(
  campaignAllowsInventorySurface({
    targetingMode: null,
    listedSurfaces: ["chatgpt.com"],
    requestSurface: "gemini.google.com",
  }),
  false,
);

console.log("PASS: surface targeting isolation (chatgpt / claude / gemini)");
