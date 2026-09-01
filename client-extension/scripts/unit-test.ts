import assert from "node:assert/strict";
import { QualifyHandoff } from "../src/content/qualify-handoff";
import { WaitStateMachine } from "../src/content/state-machine";
import { ViewabilityTracker } from "../src/content/viewability";
import { formatMicropaiseDisplay, truncateText } from "../src/shared/format";
import { parseAdRequest } from "../src/shared/messages";
import { resolveChatGptPlacementMode } from "../src/adapters/registry";
import type { QualifyResult } from "../src/shared/types";

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
assert.equal(truncateText("hello world", 20), "hello world");
assert.equal(truncateText("abcdefghijklmnopqrstuvwxyz", 10), "abcdefghi…");

const paidResult: QualifyResult = {
  impressionId: "imp-1",
  house: false,
  duplicate: false,
  grossMicropaise: 1000,
  userShareMicropaise: 600,
  omniShareMicropaise: 400,
  availableMicropaise: 600,
};

function readyCtx(
  overrides: Partial<{
    thresholdReached: boolean;
    dismissed: boolean;
    impressionId: string | null;
    sessionActive: boolean;
    cycleMatches: boolean;
    minWaitElapsed: boolean;
  }> = {},
) {
  return {
    thresholdReached: true,
    dismissed: false,
    impressionId: "imp-1",
    sessionActive: true,
    cycleMatches: true,
    minWaitElapsed: true,
    ...overrides,
  };
}

function trySend(handoff: QualifyHandoff, ctx = readyCtx()): boolean {
  if (!handoff.canSendQualify(ctx)) return false;
  return handoff.markQualifyAttempted();
}

// --- QualifyHandoff: threshold is a precondition, qualifySent is the duplicate gate ---

{
  const h = new QualifyHandoff();
  assert.equal(trySend(h, readyCtx({ thresholdReached: false })), false);
  assert.equal(h.hasQualifyBeenSent(), false);
}

{
  const h = new QualifyHandoff();
  h.markThresholdReached();
  assert.equal(trySend(h), true);
  assert.equal(h.hasQualifyBeenSent(), true);
  assert.equal(trySend(h), false);
}

{
  const h = new QualifyHandoff();
  h.markThresholdReached();
  assert.equal(h.markThresholdReached(), false);
  assert.equal(trySend(h), true);
  assert.equal(trySend(h), false);
  assert.equal(h.markQualifyAttempted(), false);
}

{
  const h = new QualifyHandoff();
  h.markThresholdReached();
  assert.equal(trySend(h, readyCtx({ dismissed: true })), false);
  assert.equal(h.hasQualifyBeenSent(), false);
}

{
  const h = new QualifyHandoff();
  h.markThresholdReached();
  assert.equal(trySend(h), true);
  const settled = h.applyServerResult({
    success: true,
    data: paidResult,
  });
  assert.equal(settled, "settled");
  assert.equal(h.shouldDisplayEarning(), true);
  assert.equal(h.getDisplayedUserShareMicropaise(), 600);
  assert.equal(h.getSnapshot().settled, true);
  assert.equal(h.getSnapshot().qualificationAccepted, true);
  const again = h.applyServerResult({
    success: true,
    duplicate: true,
    data: { ...paidResult, duplicate: true, userShareMicropaise: 600 },
  });
  assert.equal(again, "duplicate");
  assert.equal(h.getDisplayedUserShareMicropaise(), 600);
}

{
  const h = new QualifyHandoff();
  h.markThresholdReached();
  assert.equal(trySend(h), true);
  const dup = h.applyServerResult({
    success: true,
    duplicate: true,
    data: { ...paidResult, duplicate: true },
  });
  assert.equal(dup, "duplicate");
  assert.equal(h.shouldDisplayEarning(), false);
  assert.equal(h.getDisplayedUserShareMicropaise(), null);
  assert.equal(h.getSnapshot().settled, true);
}

{
  const h = new QualifyHandoff();
  h.markThresholdReached();
  assert.equal(trySend(h), true);
  const house = h.applyServerResult({
    success: true,
    data: {
      impressionId: "imp-house",
      house: true,
      duplicate: false,
      grossMicropaise: 0,
      userShareMicropaise: 0,
      omniShareMicropaise: 0,
      availableMicropaise: 0,
    },
  });
  assert.equal(house, "settled");
  assert.equal(h.shouldDisplayEarning(), false);
  assert.equal(h.getDisplayedUserShareMicropaise(), null);
}

{
  const h = new QualifyHandoff();
  h.markThresholdReached();
  assert.equal(trySend(h), true);
  assert.equal(h.applyServerResult({ success: false }), "rejected");
  assert.equal(h.shouldDisplayEarning(), false);
  assert.equal(h.hasQualifyBeenSent(), true);
  assert.equal(trySend(h), false);
}

// --- ViewabilityTracker: callback once; threshold does not mean "already qualified" ---

type FakeObserver = {
  emit: (ratio: number, intersecting?: boolean) => void;
};

type DomHarness = {
  observers: FakeObserver[];
  setHidden: () => void;
  setVisible: () => void;
};

function installDom(): DomHarness {
  const observers: FakeObserver[] = [];
  const visibilityHandlers: Array<() => void> = [];
  let visibilityState = "visible";

  class FakeIntersectionObserver {
    constructor(
      private readonly cb: (
        entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>,
      ) => void,
    ) {
      observers.push(this);
    }
    observe(): void {}
    disconnect(): void {}
    emit(ratio: number, intersecting = true): void {
      this.cb([{ isIntersecting: intersecting, intersectionRatio: ratio }]);
    }
  }

  globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => undefined) as unknown as typeof clearInterval;
  Object.defineProperty(globalThis, "IntersectionObserver", {
    value: FakeIntersectionObserver,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (type: string, fn: () => void) => {
        if (type === "visibilitychange") visibilityHandlers.push(fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        const i = visibilityHandlers.indexOf(fn);
        if (i >= 0) visibilityHandlers.splice(i, 1);
      },
    },
    configurable: true,
  });

  return {
    observers,
    setHidden() {
      visibilityState = "hidden";
      for (const fn of visibilityHandlers) fn();
    },
    setVisible() {
      visibilityState = "visible";
      for (const fn of visibilityHandlers) fn();
    },
  };
}

function runViewabilityCases(): void {
  const host = { isConnected: true } as HTMLElement;

  // 1. Below threshold: callback not fired, qualify not sent
  {
    const dom = installDom();
    let now = 0;
    const tracker = new ViewabilityTracker({ now: () => now });
    const handoff = new QualifyHandoff();
    let callbacks = 0;
    tracker.attach(host, {
      requiredViewMs: 5000,
      onThresholdMet: () => {
        callbacks += 1;
        handoff.markThresholdReached();
        trySend(handoff, readyCtx({ thresholdReached: tracker.hasReachedThreshold() }));
      },
    });
    dom.observers[0]?.emit(1, true);
    now = 4000;
    tracker.poll();
    assert.equal(callbacks, 0);
    assert.equal(handoff.hasQualifyBeenSent(), false);
    tracker.detach();
  }

  // 2. Threshold reached: callback once, qualify once
  {
    const dom = installDom();
    let now = 0;
    const tracker = new ViewabilityTracker({ now: () => now });
    const handoff = new QualifyHandoff();
    let callbacks = 0;
    tracker.attach(host, {
      requiredViewMs: 5000,
      onThresholdMet: () => {
        callbacks += 1;
        handoff.markThresholdReached();
        trySend(handoff, readyCtx({ thresholdReached: tracker.hasReachedThreshold() }));
      },
    });
    dom.observers[0]?.emit(1, true);
    now = 5000;
    tracker.poll();
    assert.equal(callbacks, 1);
    assert.equal(handoff.hasQualifyBeenSent(), true);
    tracker.detach();
  }

  // 3. Timer continues after threshold: no second qualify
  {
    const dom = installDom();
    let now = 0;
    const tracker = new ViewabilityTracker({ now: () => now });
    const handoff = new QualifyHandoff();
    let callbacks = 0;
    tracker.attach(host, {
      requiredViewMs: 5000,
      onThresholdMet: () => {
        callbacks += 1;
        handoff.markThresholdReached();
        trySend(handoff, readyCtx({ thresholdReached: tracker.hasReachedThreshold() }));
      },
    });
    dom.observers[0]?.emit(1, true);
    now = 5000;
    tracker.poll();
    now = 8000;
    tracker.poll();
    now = 12000;
    tracker.poll();
    assert.equal(callbacks, 1);
    assert.equal(handoff.hasQualifyBeenSent(), true);
    tracker.detach();
  }

  // 4. Repeated IntersectionObserver qualifying state: no second qualify
  {
    const dom = installDom();
    let now = 0;
    const tracker = new ViewabilityTracker({ now: () => now });
    const handoff = new QualifyHandoff();
    let callbacks = 0;
    tracker.attach(host, {
      requiredViewMs: 5000,
      onThresholdMet: () => {
        callbacks += 1;
        handoff.markThresholdReached();
        trySend(handoff, readyCtx({ thresholdReached: tracker.hasReachedThreshold() }));
      },
    });
    dom.observers[0]?.emit(1, true);
    now = 5000;
    tracker.poll();
    dom.observers[0]?.emit(1, true);
    dom.observers[0]?.emit(0.9, true);
    assert.equal(callbacks, 1);
    assert.equal(handoff.hasQualifyBeenSent(), true);
    tracker.detach();
  }

  // 5. Tab visibility changes after threshold: no second qualify
  {
    const dom = installDom();
    let now = 0;
    const tracker = new ViewabilityTracker({ now: () => now });
    const handoff = new QualifyHandoff();
    let callbacks = 0;
    tracker.attach(host, {
      requiredViewMs: 5000,
      onThresholdMet: () => {
        callbacks += 1;
        handoff.markThresholdReached();
        trySend(handoff, readyCtx({ thresholdReached: tracker.hasReachedThreshold() }));
      },
    });
    dom.observers[0]?.emit(1, true);
    now = 5000;
    tracker.poll();
    dom.setHidden();
    now = 9000;
    tracker.poll();
    dom.setVisible();
    tracker.poll();
    assert.equal(callbacks, 1);
    assert.equal(handoff.hasQualifyBeenSent(), true);
    tracker.detach();
  }

  // 6. Duplicate callback invocation: qualifySent blocks duplicate
  {
    const h = new QualifyHandoff();
    h.markThresholdReached();
    const ctx = readyCtx();
    assert.equal(trySend(h, ctx), true);
    assert.equal(trySend(h, ctx), false);
    h.markThresholdReached();
    assert.equal(trySend(h, ctx), false);
  }

  // 7. Dismiss before threshold: no qualify
  {
    const dom = installDom();
    let now = 0;
    const tracker = new ViewabilityTracker({ now: () => now });
    const handoff = new QualifyHandoff();
    let callbacks = 0;
    tracker.attach(host, {
      requiredViewMs: 5000,
      onThresholdMet: () => {
        callbacks += 1;
        handoff.markThresholdReached();
        trySend(handoff, readyCtx({
          thresholdReached: tracker.hasReachedThreshold(),
          dismissed: tracker.isDismissed(),
        }));
      },
    });
    dom.observers[0]?.emit(1, true);
    now = 1000;
    tracker.poll();
    tracker.dismiss();
    now = 8000;
    tracker.poll();
    assert.equal(callbacks, 0);
    assert.equal(handoff.hasQualifyBeenSent(), false);
    tracker.detach();
  }

  // 8. Dismiss after threshold, before send: no qualify
  {
    const dom = installDom();
    let now = 0;
    const tracker = new ViewabilityTracker({ now: () => now });
    const handoff = new QualifyHandoff();
    tracker.attach(host, {
      requiredViewMs: 5000,
      onThresholdMet: () => {
        handoff.markThresholdReached();
      },
    });
    dom.observers[0]?.emit(1, true);
    now = 5000;
    tracker.poll();
    assert.equal(handoff.getSnapshot().thresholdReached, true);
    tracker.dismiss();
    assert.equal(
      trySend(
        handoff,
        readyCtx({
          thresholdReached: tracker.hasReachedThreshold(),
          dismissed: tracker.isDismissed(),
        }),
      ),
      false,
    );
    assert.equal(handoff.hasQualifyBeenSent(), false);
    tracker.detach();
  }

  // 9. Hidden tab before threshold: hidden time does not count
  {
    const dom = installDom();
    let now = 0;
    const tracker = new ViewabilityTracker({ now: () => now });
    const handoff = new QualifyHandoff();
    let callbacks = 0;
    tracker.attach(host, {
      requiredViewMs: 5000,
      onThresholdMet: () => {
        callbacks += 1;
        handoff.markThresholdReached();
        trySend(handoff, readyCtx({ thresholdReached: tracker.hasReachedThreshold() }));
      },
    });
    dom.observers[0]?.emit(1, true);
    now = 2000;
    tracker.poll();
    dom.setHidden();
    now = 9000;
    tracker.poll();
    assert.equal(callbacks, 0);
    assert.equal(handoff.hasQualifyBeenSent(), false);
    assert.equal(tracker.getSnapshot().tabVisible, false);
    dom.setVisible();
    now = 11000;
    tracker.poll();
    assert.equal(callbacks, 0);
    assert.equal(handoff.hasQualifyBeenSent(), false);
    now = 14000;
    tracker.poll();
    assert.equal(callbacks, 1);
    assert.equal(handoff.hasQualifyBeenSent(), true);
    tracker.detach();
  }

  // 10. Out of view before threshold: no qualify
  {
    const dom = installDom();
    let now = 0;
    const tracker = new ViewabilityTracker({ now: () => now });
    const handoff = new QualifyHandoff();
    let callbacks = 0;
    tracker.attach(host, {
      requiredViewMs: 5000,
      onThresholdMet: () => {
        callbacks += 1;
        handoff.markThresholdReached();
        trySend(handoff, readyCtx({ thresholdReached: tracker.hasReachedThreshold() }));
      },
    });
    dom.observers[0]?.emit(1, true);
    now = 2000;
    tracker.poll();
    dom.observers[0]?.emit(0.1, false);
    now = 9000;
    tracker.poll();
    assert.equal(callbacks, 0);
    assert.equal(handoff.hasQualifyBeenSent(), false);
    assert.equal(tracker.getSnapshot().intersecting, false);
    tracker.detach();
  }

  // Live totalVisibleMs includes the open visible segment
  {
    const dom = installDom();
    let now = 0;
    const tracker = new ViewabilityTracker({ now: () => now });
    tracker.attach(host, {
      requiredViewMs: 5000,
      onThresholdMet: () => undefined,
    });
    dom.observers[0]?.emit(1, true);
    now = 16971.6;
    const snap = tracker.getSnapshot();
    assert.ok(snap.continuousVisibleMs >= 16971);
    assert.ok(snap.totalVisibleMs >= 16971);
    tracker.detach();
  }
}

runViewabilityCases();

assert.equal(resolveChatGptPlacementMode(1440), "chatgpt-wide-rail");
assert.equal(resolveChatGptPlacementMode(1280), "chatgpt-wide-rail");
assert.equal(resolveChatGptPlacementMode(1024), "chatgpt-medium-float");
assert.equal(resolveChatGptPlacementMode(900), "chatgpt-narrow-dock");
assert.equal(resolveChatGptPlacementMode(800), "chatgpt-narrow-dock");
assert.equal(resolveChatGptPlacementMode(900, 680), "chatgpt-medium-float");

{
  const parsed = parseAdRequest({
    impressionId: "imp-1",
    adRequestId: "ar-1",
    providerKey: "omni_direct",
    source: "paid_campaign",
    campaignId: "c-1",
    requiredViewMs: 5000,
    cashRevenueShareAllowed: true,
    sponsoredLabel: "Sponsored",
    creative: {
      headline: "Earn from AI wait time",
      body: "Body",
      cta_label: "Go",
      cta_url: "https://example.com",
      advertiser_name: "Example Corp",
    },
  });
  assert.equal(parsed?.creative.advertiser_name, "Example Corp");
  assert.equal(parsed?.creative.headline, "Earn from AI wait time");
}

{
  const parsed = parseAdRequest({
    impressionId: "imp-2",
    creative: {
      headline: "Headline Only",
      cta_url: "https://example.com",
    },
  });
  assert.equal(parsed?.creative.advertiser_name, undefined);
}

console.log("PASS: extension unit tests (state machine + format + qualify handoff + viewability)");
