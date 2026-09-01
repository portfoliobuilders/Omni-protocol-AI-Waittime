export type ViewabilitySnapshot = {
  mounted: boolean;
  tabVisible: boolean;
  intersecting: boolean;
  intersectionRatio: number;
  continuousVisibleMs: number;
  /**
   * Cumulative visible time for this attach, including the open segment.
   * Internally a segment is committed into the running total only when
   * visibility ends; getSnapshot() adds the in-progress segment so probes
   * are not stuck at 0 during a continuous view.
   */
  totalVisibleMs: number;
  dismissed: boolean;
  /** Viewability duration met — not financial qualification. */
  thresholdReached: boolean;
};

export type ViewabilityOptions = {
  requiredViewMs: number;
  onThresholdMet: (reportedViewMs: number) => void;
  onUpdate?: (snap: ViewabilitySnapshot) => void;
};

export type ViewabilityClock = {
  now: () => number;
};

/** Low-frequency tick while a Sponsored Wait is active (not ~60 Hz RAF). */
const TICK_MS = 250;

export class ViewabilityTracker {
  private host: HTMLElement | null = null;
  private observer: IntersectionObserver | null = null;
  private opts: ViewabilityOptions | null = null;
  private mounted = false;
  private intersecting = false;
  private intersectionRatio = 0;
  private tabVisible = true;
  private visibleSince: number | null = null;
  private continuousVisibleMs = 0;
  private totalVisibleMs = 0;
  private dismissed = false;
  private thresholdReached = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly clock: ViewabilityClock = { now: () => performance.now() }) {}

  attach(host: HTMLElement, opts: ViewabilityOptions): void {
    this.detach();
    this.host = host;
    this.opts = opts;
    this.mounted = true;
    this.dismissed = false;
    this.thresholdReached = false;
    this.continuousVisibleMs = 0;
    this.totalVisibleMs = 0;
    this.visibleSince = null;
    this.tabVisible = document.visibilityState === "visible";

    this.observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        this.intersecting = entry.isIntersecting && entry.intersectionRatio > 0.25;
        this.intersectionRatio = entry.intersectionRatio;
        this.syncVisibilityClock();
        this.poll();
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    this.observer.observe(host);

    document.addEventListener("visibilitychange", this.onVisibility);
    const g = globalThis as unknown as {
      addEventListener?: typeof addEventListener;
    };
    g.addEventListener?.("pagehide", this.onPageHide);
    this.syncVisibilityClock();
    this.startTick();
    this.poll();
  }

  dismiss(): void {
    this.dismissed = true;
    this.syncVisibilityClock();
    this.emitUpdate();
  }

  detach(): void {
    this.stopTick();
    this.observer?.disconnect();
    this.observer = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    const g = globalThis as unknown as {
      removeEventListener?: typeof removeEventListener;
    };
    g.removeEventListener?.("pagehide", this.onPageHide);
    this.host = null;
    this.opts = null;
    this.mounted = false;
  }

  hasReachedThreshold(): boolean {
    return this.thresholdReached;
  }

  isDismissed(): boolean {
    return this.dismissed;
  }

  getSnapshot(): ViewabilitySnapshot {
    let continuousVisibleMs = this.continuousVisibleMs;
    let totalVisibleMs = this.totalVisibleMs;
    if (this.visibleSince !== null && this.isCurrentlyVisible()) {
      continuousVisibleMs = this.clock.now() - this.visibleSince;
      totalVisibleMs = this.totalVisibleMs + continuousVisibleMs;
    }
    return {
      mounted: this.mounted,
      tabVisible: this.tabVisible,
      intersecting: this.intersecting,
      intersectionRatio: this.intersectionRatio,
      continuousVisibleMs,
      totalVisibleMs,
      dismissed: this.dismissed,
      thresholdReached: this.thresholdReached,
    };
  }

  /** Re-evaluate duration vs threshold. Production uses a 250ms interval. */
  poll(): void {
    if (!this.mounted || !this.opts) {
      this.stopTick();
      return;
    }

    if (this.isCurrentlyVisible() && this.visibleSince !== null) {
      const now = this.clock.now();
      this.continuousVisibleMs = now - this.visibleSince;
      this.maybeMarkThresholdReached();
    } else {
      this.syncVisibilityClock();
    }

    this.emitUpdate();
  }

  private maybeMarkThresholdReached(): void {
    if (!this.opts) return;
    if (this.thresholdReached || this.dismissed) return;
    if (this.continuousVisibleMs < this.opts.requiredViewMs) return;

    this.thresholdReached = true;
    this.opts.onThresholdMet(Math.floor(this.continuousVisibleMs));
  }

  private onVisibility = (): void => {
    this.tabVisible = document.visibilityState === "visible";
    this.syncVisibilityClock();
    this.poll();
  };

  private onPageHide = (): void => {
    this.tabVisible = false;
    this.syncVisibilityClock();
    this.emitUpdate();
  };

  private isCurrentlyVisible(): boolean {
    return (
      this.mounted &&
      !this.dismissed &&
      this.tabVisible &&
      this.intersecting &&
      Boolean(this.host?.isConnected)
    );
  }

  private syncVisibilityClock(): void {
    const now = this.clock.now();
    if (this.isCurrentlyVisible()) {
      if (this.visibleSince === null) {
        this.visibleSince = now;
      }
    } else if (this.visibleSince !== null) {
      const delta = now - this.visibleSince;
      this.totalVisibleMs += delta;
      this.continuousVisibleMs = 0;
      this.visibleSince = null;
    } else {
      this.continuousVisibleMs = 0;
    }
  }

  private startTick(): void {
    if (this.tickTimer !== null) return;
    this.tickTimer = globalThis.setInterval(() => this.poll(), TICK_MS);
  }

  private stopTick(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private emitUpdate(): void {
    this.opts?.onUpdate?.(this.getSnapshot());
  }
}
