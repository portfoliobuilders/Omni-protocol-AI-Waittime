import type { QualifyResult } from "../shared/types";

/**
 * Client lifecycle for one wait-cycle impression.
 * Viewability threshold is a precondition — it must never block sending qualify.
 * qualifySent is the only client gate against a second QUALIFY_IMPRESSION.
 */
export type QualifyHandoffSnapshot = {
  thresholdReached: boolean;
  qualifySent: boolean;
  qualificationAccepted: boolean;
  settled: boolean;
  displayedUserShareMicropaise: number | null;
};

export type QualifySendContext = {
  /** ViewabilityTracker.hasReachedThreshold() — precondition, not a blocker. */
  thresholdReached: boolean;
  dismissed: boolean;
  impressionId: string | null | undefined;
  sessionActive: boolean;
  cycleMatches: boolean;
  minWaitElapsed: boolean;
};

export type QualifyServerPayload = {
  success: boolean;
  duplicate?: boolean;
  data?: QualifyResult;
};

export type QualifyServerOutcome = "settled" | "duplicate" | "rejected";

export class QualifyHandoff {
  private thresholdReached = false;
  private qualifySent = false;
  private qualificationAccepted = false;
  private settled = false;
  private displayedUserShareMicropaise: number | null = null;

  reset(): void {
    this.thresholdReached = false;
    this.qualifySent = false;
    this.qualificationAccepted = false;
    this.settled = false;
    this.displayedUserShareMicropaise = null;
  }

  /**
   * Record that viewability threshold was reached.
   * Returns true only the first time (safe to invoke the qualify callback).
   */
  markThresholdReached(): boolean {
    if (this.thresholdReached) return false;
    this.thresholdReached = true;
    return true;
  }

  hasQualifyBeenSent(): boolean {
    return this.qualifySent;
  }

  canSendQualify(ctx: QualifySendContext): boolean {
    return (
      ctx.thresholdReached &&
      !this.qualifySent &&
      !ctx.dismissed &&
      Boolean(ctx.impressionId) &&
      ctx.sessionActive &&
      ctx.cycleMatches &&
      ctx.minWaitElapsed
    );
  }

  /** Call immediately before the HTTP request. False if already attempted. */
  markQualifyAttempted(): boolean {
    if (this.qualifySent) return false;
    this.qualifySent = true;
    return true;
  }

  applyServerResult(payload: QualifyServerPayload): QualifyServerOutcome {
    if (!payload.success || !payload.data) {
      return "rejected";
    }

    this.qualificationAccepted = true;
    this.settled = true;

    if (payload.duplicate || payload.data.duplicate) {
      return "duplicate";
    }

    if (!payload.data.house && payload.data.userShareMicropaise > 0) {
      this.displayedUserShareMicropaise = payload.data.userShareMicropaise;
    }

    return "settled";
  }

  shouldDisplayEarning(): boolean {
    return (
      this.displayedUserShareMicropaise !== null &&
      this.displayedUserShareMicropaise > 0
    );
  }

  getDisplayedUserShareMicropaise(): number | null {
    return this.displayedUserShareMicropaise;
  }

  getSnapshot(): QualifyHandoffSnapshot {
    return {
      thresholdReached: this.thresholdReached,
      qualifySent: this.qualifySent,
      qualificationAccepted: this.qualificationAccepted,
      settled: this.settled,
      displayedUserShareMicropaise: this.displayedUserShareMicropaise,
    };
  }
}
