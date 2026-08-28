export type ViewabilitySnapshot = {
  mounted: boolean;
  tabVisible: boolean;
  intersecting: boolean;
  intersectionRatio: number;
  continuousVisibleMs: number;
  totalVisibleMs: number;
  dismissed: boolean;
};

export type ViewabilityOptions = {
  requiredViewMs: number;
  onThresholdMet: (reportedViewMs: number) => void;
  onUpdate?: (snap: ViewabilitySnapshot) => void;
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
  private tabVisible = document.visibilityState === "visible";
  private visibleSince: number | null = null;
  private continuousVisibleMs = 0;
  private totalVisibleMs = 0;
  private dismissed = false;
  private qualified = false;
  private tickTimer: number | null = null;

  attach(host: HTMLElement, opts: ViewabilityOptions): void {
    this.detach();
    this.host = host;
    this.opts = opts;
    this.mounted = true;
    this.dismissed = false;
    this.qualified = false;
    this.continuousVisibleMs = 0;
    this.totalVisibleMs = 0;
    this.visibleSince = null;

    this.observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        this.intersecting = entry.isIntersecting && entry.intersectionRatio > 0.25;
        this.intersectionRatio = entry.intersectionRatio;
        this.syncVisibilityClock();
        this.emitUpdate();
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    this.observer.observe(host);

    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.onPageHide);
    this.syncVisibilityClock();
    this.startTick();
    this.onTick();
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
    window.removeEventListener("pagehide", this.onPageHide);
    this.host = null;
    this.opts = null;
    this.mounted = false;
  }

  getSnapshot(): ViewabilitySnapshot {
    if (this.visibleSince !== null && this.isCurrentlyVisible()) {
      this.continuousVisibleMs = performance.now() - this.visibleSince;
    }
    return {
      mounted: this.mounted,
      tabVisible: this.tabVisible,
      intersecting: this.intersecting,
      intersectionRatio: this.intersectionRatio,
      continuousVisibleMs: this.continuousVisibleMs,
      totalVisibleMs: this.totalVisibleMs,
      dismissed: this.dismissed,
    };
  }

  canQualify(requiredMs: number): boolean {
    const snap = this.getSnapshot();
    return (
      !this.qualified &&
      !snap.dismissed &&
      snap.tabVisible &&
      snap.intersecting &&
      snap.continuousVisibleMs >= requiredMs
    );
  }

  private onVisibility = (): void => {
    this.tabVisible = document.visibilityState === "visible";
    this.syncVisibilityClock();
    this.emitUpdate();
  };

  private onPageHide = (): void => {
    this.tabVisible = false;
    this.syncVisibilityClock();
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
    const now = performance.now();
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
    this.tickTimer = window.setInterval(() => this.onTick(), TICK_MS);
  }

  private stopTick(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private onTick(): void {
    if (!this.mounted || !this.opts) {
      this.stopTick();
      return;
    }

    if (this.isCurrentlyVisible() && this.visibleSince !== null) {
      const now = performance.now();
      this.continuousVisibleMs = now - this.visibleSince;

      const required = this.opts.requiredViewMs;
      if (
        !this.qualified &&
        !this.dismissed &&
        this.continuousVisibleMs >= required
      ) {
        this.qualified = true;
        this.opts.onThresholdMet(Math.floor(this.continuousVisibleMs));
      }
    } else {
      this.syncVisibilityClock();
    }

    this.emitUpdate();
  }

  private emitUpdate(): void {
    this.opts?.onUpdate?.(this.getSnapshot());
  }
}
