import type { WaitState } from "../shared/types";

const TERMINAL: ReadonlySet<WaitState> = new Set([
  "IDLE",
  "NO_FILL",
  "DISMISSED",
  "SHORT_WAIT",
  "ERROR",
  "PLATFORM_DISABLED",
  "CLEANUP",
]);

export class WaitStateMachine {
  private state: WaitState = "IDLE";
  private generationCycleId = 0;

  getState(): WaitState {
    return this.state;
  }

  getCycleId(): number {
    return this.generationCycleId;
  }

  /** Begin a new AI generation cycle. */
  beginGeneration(): number {
    this.generationCycleId += 1;
    this.transition("GENERATION_DETECTED");
    return this.generationCycleId;
  }

  transition(next: WaitState): boolean {
    const allowed = ALLOWED[this.state];
    if (!allowed?.has(next) && this.state !== next) {
      console.debug("[OmniPiggy] state blocked", this.state, "→", next);
      return false;
    }
    if (this.state !== next) {
      console.debug("[OmniPiggy] state", this.state, "→", next);
      this.state = next;
    }
    return true;
  }

  force(next: WaitState): void {
    this.state = next;
  }

  reset(): void {
    this.state = "IDLE";
  }

  isTerminal(): boolean {
    return TERMINAL.has(this.state);
  }

  isActiveCycle(): boolean {
    return !TERMINAL.has(this.state) && this.state !== "IDLE";
  }
}

const ALLOWED: Record<WaitState, ReadonlySet<WaitState>> = {
  IDLE: new Set(["GENERATION_DETECTED", "PLATFORM_DISABLED"]),
  GENERATION_DETECTED: new Set([
    "SESSION_STARTING",
    "ERROR",
    "SHORT_WAIT",
    "GENERATION_COMPLETE",
    "PLATFORM_DISABLED",
  ]),
  SESSION_STARTING: new Set([
    "AD_REQUESTING",
    "ERROR",
    "SHORT_WAIT",
    "GENERATION_COMPLETE",
    "PLATFORM_DISABLED",
  ]),
  AD_REQUESTING: new Set([
    "AD_RENDERED",
    "NO_FILL",
    "ERROR",
    "SHORT_WAIT",
    "GENERATION_COMPLETE",
    "DISMISSED",
  ]),
  AD_RENDERED: new Set([
    "VIEWABILITY_PENDING",
    "DISMISSED",
    "SHORT_WAIT",
    "GENERATION_COMPLETE",
    "ERROR",
  ]),
  VIEWABILITY_PENDING: new Set([
    "QUALIFIED",
    "DISMISSED",
    "SHORT_WAIT",
    "GENERATION_COMPLETE",
    "ERROR",
  ]),
  QUALIFIED: new Set(["SETTLED", "ERROR", "GENERATION_COMPLETE"]),
  SETTLED: new Set(["GENERATION_COMPLETE", "CLEANUP"]),
  GENERATION_COMPLETE: new Set(["CLEANUP", "IDLE"]),
  CLEANUP: new Set(["IDLE"]),
  NO_FILL: new Set(["GENERATION_COMPLETE", "CLEANUP", "IDLE"]),
  DISMISSED: new Set(["GENERATION_COMPLETE", "CLEANUP", "IDLE"]),
  SHORT_WAIT: new Set(["CLEANUP", "IDLE"]),
  ERROR: new Set(["CLEANUP", "IDLE"]),
  PLATFORM_DISABLED: new Set(["IDLE", "GENERATION_DETECTED"]),
};
