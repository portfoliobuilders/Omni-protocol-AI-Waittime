import { getAdapterForHost, type AiSiteAdapter } from "../adapters/registry";
import type { BackgroundMessage, BackgroundResponse } from "../shared/messages";
import {
  parseAdRequest,
  type QualifyResponse,
  type SessionStartResponse,
} from "../shared/messages";
import type {
  OmniConfig,
  PlatformConfig,
  WaitAdData,
  WaitSessionData,
} from "../shared/types";
import { OmniWaitAd } from "./omni-wait-ad";
import { WaitStateMachine } from "./state-machine";
import { ViewabilityTracker } from "./viewability";

const SPONSORED_WAITS_KEY = "sponsoredWaitsEnabled";
/** UI-only: minimum time before fading shell if generation ends early (not financial authority). */
const MIN_SPONSORED_UI_DISPLAY_MS = 2500;
const SHELL_EXPAND_MS = 1200;

const FALLBACK_CONFIG: PlatformConfig = {
  currency: "INR",
  symbol: "₹",
  minRedemption: 100,
  minWaitSeconds: 5,
  userRevenueShareBps: 6000,
  omniRevenueShareBps: 4000,
  minimumQualifiedViewMs: 5000,
};

export function isExtensionContextValid(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function sendMessage(message: BackgroundMessage): Promise<BackgroundResponse> {
  if (!isExtensionContextValid()) {
    return Promise.reject(new Error("Extension context invalidated"));
  }
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response: BackgroundResponse) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(response ?? { ok: false, error: "No response" });
      });
    } catch (e) {
      reject(e);
    }
  });
}

export class WaitController {
  private adapter: AiSiteAdapter | null;
  private sm = new WaitStateMachine();
  private observer: MutationObserver | null = null;
  private rafId = 0;
  private wasGenerating = false;
  private cycleId = 0;
  private config: PlatformConfig = FALLBACK_CONFIG;
  private platformEnabled = true;

  private session: WaitSessionData | null = null;
  private ad: WaitAdData | null = null;
  private ui: OmniWaitAd | null = null;
  private viewability = new ViewabilityTracker();
  private qualifySent = false;
  private generationStartedAt = 0;
  private expandTimer: number | null = null;

  constructor(private hostname: string) {
    this.adapter = getAdapterForHost(hostname);
  }

  start(): void {
    if (!this.adapter) return;
    void this.loadConfig();
    this.setupStorageListener();
    this.setupSpaHooks();
    this.observer = new MutationObserver(() => this.scheduleEval());
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "aria-label",
        "aria-busy",
        "disabled",
        "data-testid",
        "data-action",
        "role",
      ],
    });
    this.scheduleEval();
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.cleanupCycle(true);
  }

  probe(): Record<string, unknown> {
    return {
      hostname: this.hostname,
      adapter: this.adapter?.id ?? null,
      platform: this.adapter?.platformKey ?? null,
      state: this.sm.getState(),
      cycleId: this.sm.getCycleId(),
      platformEnabled: this.platformEnabled,
      session: this.session?.waitSessionId ?? null,
      sessionStatus: this.session ? "active" : null,
      impressionId: this.ad?.impressionId ?? null,
      adSource: this.ad?.source ?? null,
      adStatus: this.ad ? "loaded" : this.ui ? "shell" : null,
      uiMounted: Boolean(this.ui),
      qualifySent: this.qualifySent,
      viewability: this.viewability.getSnapshot(),
      extensionValid: isExtensionContextValid(),
    };
  }

  private async loadConfig(): Promise<void> {
    try {
      const res = await sendMessage({ type: "GET_OMNI_CONFIG" });
      if (!res.ok) return;
      const root = res.data as {
        success?: boolean;
        data?: OmniConfig & { minimumQualifiedViewMs?: number };
      };
      const payload = root.data;
      if (!payload) return;
      if (payload.platform) {
        this.config = { ...FALLBACK_CONFIG, ...payload.platform };
      }
      if (typeof payload.minimumQualifiedViewMs === "number") {
        this.config.minimumQualifiedViewMs = payload.minimumQualifiedViewMs;
      }
      if (payload.platforms) {
        const plat = payload.platforms.find((p) => p.id === this.adapter?.id);
        if (plat) {
          this.platformEnabled = plat.enabled && plat.sponsoredWaitEnabled;
        }
      }
    } catch {
      // defaults
    }
  }

  private setupStorageListener(): void {
    if (!isExtensionContextValid()) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[SPONSORED_WAITS_KEY]?.newValue === false) {
        this.cleanupCycle(true);
      }
    });
  }

  private setupSpaHooks(): void {
    const reset = (): void => {
      this.cleanupCycle(true);
      this.wasGenerating = false;
    };
    window.addEventListener("popstate", reset);
    window.addEventListener("hashchange", reset);
  }

  private scheduleEval(): void {
    if (!isExtensionContextValid()) {
      this.stop();
      return;
    }
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      void this.evaluate();
    });
  }

  private async evaluate(): Promise<void> {
    if (!this.adapter || !this.platformEnabled) {
      if (!this.platformEnabled && this.sm.getState() === "IDLE") {
        this.sm.transition("PLATFORM_DISABLED");
      }
      return;
    }

    this.adapter.cleanupDuplicateAds();
    const generating = this.adapter.detectGenerationActive();

    if (generating && !this.wasGenerating) {
      this.wasGenerating = true;
      const enabled = await this.isSponsoredWaitsEnabled();
      if (!enabled) return;

      this.cycleId = this.sm.beginGeneration();
      this.generationStartedAt = Date.now();
      this.qualifySent = false;
      this.session = null;
      this.ad = null;

      void this.telemetry("wait_detected");
      void this.runSessionFlow(this.cycleId);
    }

    if (!generating && this.wasGenerating) {
      this.wasGenerating = false;
      void this.onGenerationEnd();
    }
  }

  private async runSessionFlow(cycle: number): Promise<void> {
    if (cycle !== this.cycleId) return;
    if (!this.sm.transition("SESSION_STARTING")) return;

    void this.telemetry("session_started");

    try {
      const res = await sendMessage({
        type: "START_WAIT_SESSION",
        payload: { platform: this.adapter!.platformKey },
      });
      if (cycle !== this.cycleId) return;
      if (!res.ok) {
        this.sm.transition("ERROR");
        return;
      }

      const payload = res.data as SessionStartResponse;
      if (!payload.success || !payload.data?.waitSessionId) {
        this.sm.transition("ERROR");
        return;
      }

      this.session = payload.data;
      this.showShellUi();

      if (!this.sm.transition("AD_REQUESTING")) return;
      void this.telemetry("ad_requested");

      const adRes = await sendMessage({
        type: "REQUEST_WAIT_AD",
        payload: { waitSessionId: this.session.waitSessionId },
      });
      if (cycle !== this.cycleId) return;

      if (!adRes.ok) {
        this.sm.transition("NO_FILL");
        this.removeUi();
        return;
      }

      const parsed = parseAdRequest(adRes.data);
      if (!parsed) {
        this.sm.transition("NO_FILL");
        void this.telemetry("no_fill");
        this.removeUi();
        return;
      }

      this.ad = parsed;
      void this.telemetry("ad_returned");

      if (parsed.source === "house" && parsed.providerKey === "house") {
        // house is valid inventory — still one impression, zero settlement
      }

      this.sm.transition("AD_RENDERED");
      void this.telemetry("ad_rendered");
      this.renderAd(parsed);

      this.sm.transition("VIEWABILITY_PENDING");
      this.attachViewability(parsed);
    } catch {
      if (cycle === this.cycleId) this.sm.transition("ERROR");
    }
  }

  private showShellUi(): void {
    this.removeUi();
    this.ui = new OmniWaitAd(this.config, this.adapter!.name, this.makeCallbacks());
    this.ui.showShell();
    this.ui.mount(
      this.adapter!.findPreferredAdAnchor(),
      this.adapter!.findFallbackAnchor(),
    );

    if (this.expandTimer) clearTimeout(this.expandTimer);
    this.expandTimer = window.setTimeout(() => {
      this.ui?.expandToStandard();
    }, SHELL_EXPAND_MS);
  }

  private renderAd(ad: WaitAdData): void {
    if (!this.ui) {
      this.ui = new OmniWaitAd(this.config, this.adapter!.name, this.makeCallbacks());
      this.ui.mount(
        this.adapter!.findPreferredAdAnchor(),
        this.adapter!.findFallbackAnchor(),
      );
    }
    this.ui.setAd(ad);
  }

  private attachViewability(ad: WaitAdData): void {
    const host = this.ui?.getElement();
    if (!host) return;

    const requiredMs = Math.max(
      ad.requiredViewMs,
      (this.config.minimumQualifiedViewMs ?? 5000),
      this.config.minWaitSeconds * 1000,
    );

    this.viewability.attach(host, {
      requiredViewMs: requiredMs,
      onThresholdMet: (ms) => void this.requestQualify(ms),
      onUpdate: (snap) => {
        if (snap.intersecting && snap.tabVisible) {
          void this.telemetry("ad_viewable");
        }
      },
    });
  }

  private async requestQualify(reportedViewMs: number): Promise<void> {
    if (this.qualifySent || !this.ad || !this.session) return;

    const elapsed = Date.now() - this.generationStartedAt;
    if (elapsed < this.config.minWaitSeconds * 1000) return;

    if (!this.viewability.canQualify(this.ad.requiredViewMs)) return;

    this.qualifySent = true;
    this.sm.transition("QUALIFIED");
    void this.telemetry("impression_qualify_requested");

    try {
      const res = await sendMessage({
        type: "QUALIFY_IMPRESSION",
        payload: {
          impressionId: this.ad.impressionId,
          reportedViewMs,
        },
      });

      if (!res.ok) {
        void this.telemetry("settlement_failed");
        this.sm.transition("ERROR");
        return;
      }

      const payload = res.data as QualifyResponse;
      if (!payload.success || !payload.data) {
        void this.telemetry("settlement_failed");
        return;
      }

      this.sm.transition("SETTLED");
      void this.telemetry("impression_settled");

      if (payload.duplicate) {
        void this.telemetry("duplicate_prevented");
        return;
      }

      void this.telemetry("impression_qualified");
      this.ui?.setQualified(payload.data);
    } catch {
      void this.telemetry("settlement_failed");
    }
  }

  private async onGenerationEnd(): Promise<void> {
    void this.telemetry("wait_ended");

    const elapsed = Date.now() - this.generationStartedAt;
    if (
      elapsed < MIN_SPONSORED_UI_DISPLAY_MS ||
      (this.sm.getState() === "VIEWABILITY_PENDING" && !this.qualifySent)
    ) {
      this.sm.transition("SHORT_WAIT");
      void this.telemetry("wait_short");
    } else {
      this.sm.transition("GENERATION_COMPLETE");
    }

    if (this.session) {
      void sendMessage({
        type: "END_WAIT_SESSION",
        payload: { waitSessionId: this.session.waitSessionId },
      });
    }

    const ui = this.ui;
    if (ui) {
      ui.fadeOut(() => this.cleanupCycle(false));
    } else {
      this.cleanupCycle(false);
    }
  }

  private cleanupCycle(force: boolean): void {
    if (this.expandTimer) {
      clearTimeout(this.expandTimer);
      this.expandTimer = null;
    }
    this.viewability.detach();
    if (force) OmniWaitAd.removeAll();
    this.ui = null;
    this.ad = null;
    this.session = null;
    this.qualifySent = false;
    this.sm.transition("CLEANUP");
    this.sm.reset();
  }

  private removeUi(): void {
    this.viewability.detach();
    this.ui?.destroy();
    this.ui = null;
    OmniWaitAd.removeAll();
  }

  private makeCallbacks(): ConstructorParameters<typeof OmniWaitAd>[2] {
    return {
      onDismiss: () => {
        void this.telemetry("ad_dismissed");
        this.viewability.dismiss();
        this.sm.transition("DISMISSED");
        this.ui?.fadeOut(() => this.cleanupCycle(false));
      },
      onCtaClick: (url) => {
        if (!this.ad) return;
        void sendMessage({
          type: "TRACK_AD_CLICK",
          payload: { impressionId: this.ad.impressionId, ctaUrl: url },
        });
        window.open(url, "_blank", "noopener,noreferrer");
      },
      onReport: () => {
        if (!this.ad) return;
        void sendMessage({
          type: "REPORT_AD",
          payload: { impressionId: this.ad.impressionId, reason: "user_report" },
        });
      },
    };
  }

  private telemetry(event: string): Promise<void> {
    return sendMessage({
      type: "TRACK_TELEMETRY",
      payload: { host: this.hostname, event },
    }).then(() => undefined);
  }

  private isSponsoredWaitsEnabled(): Promise<boolean> {
    if (!isExtensionContextValid()) return Promise.resolve(false);
    return new Promise((resolve) => {
      chrome.storage.local.get([SPONSORED_WAITS_KEY], (r) => {
        resolve(r[SPONSORED_WAITS_KEY] !== false);
      });
    });
  }
}
