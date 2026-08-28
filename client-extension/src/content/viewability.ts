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
  private rafId = 0;
  private lastTick = 0;

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
    this.lastTick = performance.now();

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
    this.tick();
  }

  dismiss(): void {
    this.dismissed = true;
    this.syncVisibilityClock();
    this.emitUpdate();
  }

  detach(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.observer?.disconnect();
    this.observer = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
    this.host = null;
    this.opts = null;
    this.mounted = false;
  }

  getSnapshot(): ViewabilitySnapshot {
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
    }
  }

  private tick = (): void => {
    const now = performance.now();
    if (this.visibleSince !== null && this.isCurrentlyVisible()) {
      const delta = now - this.visibleSince;
      this.continuousVisibleMs = delta;
      this.totalVisibleMs += now - this.lastTick;
      this.visibleSince = now;

      const required = this.opts?.requiredViewMs ?? 5000;
      if (
        !this.qualified &&
        !this.dismissed &&
        this.continuousVisibleMs >= required
      ) {
        this.qualified = true;
        this.opts?.onThresholdMet(Math.floor(this.continuousVisibleMs));
      }
    }
    this.lastTick = now;
    this.emitUpdate();
    this.rafId = requestAnimationFrame(this.tick);
  };

  private emitUpdate(): void {
    this.opts?.onUpdate?.(this.getSnapshot());
  }
}
