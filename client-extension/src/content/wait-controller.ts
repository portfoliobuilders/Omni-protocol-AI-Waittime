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
import { formatMicropaiseDisplay } from "../shared/format";
import { OmniWaitAd } from "./omni-wait-ad";
import { QualifyHandoff } from "./qualify-handoff";
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

function sendMessageOnce(message: BackgroundMessage): Promise<BackgroundResponse> {
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

function isTransientMessagingError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /message port closed|context invalidated|receiving end does not exist/i.test(
    msg,
  );
}

async function sendMessage(
  message: BackgroundMessage,
): Promise<BackgroundResponse> {
  try {
    return await sendMessageOnce(message);
  } catch (error) {
    if (!isTransientMessagingError(error)) throw error;
    await new Promise((r) => setTimeout(r, 40));
    return sendMessageOnce(message);
  }
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
  private qualifyHandoff = new QualifyHandoff();
  private qualifyCycleId = 0;
  private generationStartedAt = 0;
  private expandTimer: number | null = null;
  private lastError: string | null = null;

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
      session: this.session
        ? {
            waitSessionId: this.session.waitSessionId,
            platform: this.session.platform,
            startedAt: this.session.startedAt,
          }
        : null,
      sessionStatus: this.session ? "active" : null,
      impressionId: this.ad?.impressionId ?? null,
      providerKey: this.ad?.providerKey ?? null,
      adSource: this.ad?.source ?? null,
      adStatus: this.ad ? "loaded" : this.ui ? "shell" : null,
      uiMounted: Boolean(this.ui),
      qualifySent: this.qualifyHandoff.hasQualifyBeenSent(),
      thresholdReached: this.viewability.hasReachedThreshold(),
      qualificationAccepted: this.qualifyHandoff.getSnapshot().qualificationAccepted,
      settled: this.qualifyHandoff.getSnapshot().settled,
      displayedEarning: this.qualifyHandoff.shouldDisplayEarning()
        ? formatMicropaiseDisplay(
            this.qualifyHandoff.getDisplayedUserShareMicropaise() ?? 0,
            this.config.symbol,
          )
        : null,
      lastError: this.lastError,
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

    let lastPath = window.location.pathname;
    const onUrlChange = (): void => {
      const path = window.location.pathname;
      if (path === lastPath) return;
      const prev = lastPath;
      lastPath = path;
      if (this.adapter?.shouldResetOnNavigation) {
        if (this.adapter.shouldResetOnNavigation(prev, path)) reset();
        return;
      }
      const prevConv = prev.match(/\/c\/([a-z0-9-]+)/i)?.[1];
      const nextConv = path.match(/\/c\/([a-z0-9-]+)/i)?.[1];
      if (prevConv && nextConv && prevConv !== nextConv) reset();
      if (prevConv && !nextConv) reset();
    };
    const wrapHistory = (
      method: "pushState" | "replaceState",
    ): void => {
      const original = history[method].bind(history);
      history[method] = ((...args: Parameters<History["pushState"]>) => {
        const result = original(...args);
        onUrlChange();
        return result;
      }) as History["pushState"];
    };
    wrapHistory("pushState");
    wrapHistory("replaceState");
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
      this.qualifyHandoff.reset();
      this.qualifyCycleId = this.cycleId;
      this.session = null;
      this.ad = null;
      this.lastError = null;

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

    await new Promise((r) => setTimeout(r, 250));
    if (cycle !== this.cycleId) return;

    void this.telemetry("session_started");

    try {
      const res = await sendMessage({
        type: "START_WAIT_SESSION",
        payload: { platform: this.adapter!.platformKey },
      });
      if (cycle !== this.cycleId) return;
      if (!res.ok) {
        this.lastError = res.error || "session_start_failed";
        this.sm.transition("ERROR");
        return;
      }

      const payload = res.data as SessionStartResponse;
      if (!payload.success || !payload.data?.waitSessionId) {
        this.lastError = "session_start_missing_id";
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
    } catch (error) {
      if (cycle === this.cycleId) {
        this.lastError =
          error instanceof Error ? error.message : "session_flow_exception";
        this.sm.transition("ERROR");
      }
    }
  }

  private showShellUi(): void {
    this.removeUi();
    this.ui = new OmniWaitAd(this.config, this.adapter!.name, this.makeCallbacks());
    this.ui.showShell();
    this.ui.mount(
      this.adapter!.findPreferredAdAnchor(),
      this.adapter!.findFallbackAnchor(),
      this.adapter!.placeAd?.bind(this.adapter),
    );

    if (this.expandTimer) clearTimeout(this.expandTimer);
    this.expandTimer = window.setTimeout(() => {
      const host = this.ui?.getElement();
      if (host?.classList.contains("chatgpt-narrow-dock")) return;
      this.ui?.expandToStandard();
    }, SHELL_EXPAND_MS);
  }

  private renderAd(ad: WaitAdData): void {
    if (!this.ui) {
      this.ui = new OmniWaitAd(this.config, this.adapter!.name, this.makeCallbacks());
      this.ui.mount(
        this.adapter!.findPreferredAdAnchor(),
        this.adapter!.findFallbackAnchor(),
        this.adapter!.placeAd?.bind(this.adapter),
      );
    }
    this.ui.setAd(ad);
  }

  private attachViewability(ad: WaitAdData): void {
    const host = this.ui?.getElement();
    if (!host) return;

    const cycle = this.cycleId;
    this.qualifyCycleId = cycle;
    const requiredMs = Math.max(
      ad.requiredViewMs,
      (this.config.minimumQualifiedViewMs ?? 5000),
      this.config.minWaitSeconds * 1000,
    );

    this.viewability.attach(host, {
      requiredViewMs: requiredMs,
      onThresholdMet: (ms) => {
        this.qualifyHandoff.markThresholdReached();
        void this.requestQualify(cycle, ms);
      },
      onUpdate: (snap) => {
        if (snap.intersecting && snap.tabVisible) {
          void this.telemetry("ad_viewable");
        }
      },
    });
  }

  private canSendQualify(cycle: number): boolean {
    return this.qualifyHandoff.canSendQualify({
      thresholdReached: this.viewability.hasReachedThreshold(),
      dismissed: this.viewability.isDismissed(),
      impressionId: this.ad?.impressionId,
      sessionActive: Boolean(this.session),
      cycleMatches: cycle === this.cycleId && cycle === this.qualifyCycleId,
      minWaitElapsed:
        Date.now() - this.generationStartedAt >=
        this.config.minWaitSeconds * 1000,
    });
  }

  private async requestQualify(
    cycle: number,
    reportedViewMs: number,
  ): Promise<void> {
    if (!this.canSendQualify(cycle)) return;
    if (!this.ad || !this.qualifyHandoff.markQualifyAttempted()) return;

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

      if (cycle !== this.cycleId) return;

      if (!res.ok) {
        void this.telemetry("settlement_failed");
        this.sm.transition("ERROR");
        return;
      }

      const payload = res.data as QualifyResponse;
      const outcome = this.qualifyHandoff.applyServerResult(payload);

      if (outcome === "rejected") {
        void this.telemetry("settlement_failed");
        this.sm.transition("ERROR");
        return;
      }

      this.sm.transition("SETTLED");
      void this.telemetry("impression_settled");

      if (outcome === "duplicate") {
        void this.telemetry("duplicate_prevented");
        return;
      }

      void this.telemetry("impression_qualified");
      if (this.viewability.isDismissed()) return;
      if (this.qualifyHandoff.shouldDisplayEarning() && payload.data) {
        this.ui?.setQualified(payload.data);
      }
    } catch {
      void this.telemetry("settlement_failed");
      this.sm.transition("ERROR");
    }
  }

  private async onGenerationEnd(): Promise<void> {
    void this.telemetry("wait_ended");

    const elapsed = Date.now() - this.generationStartedAt;
    if (
      elapsed < MIN_SPONSORED_UI_DISPLAY_MS ||
      (this.sm.getState() === "VIEWABILITY_PENDING" &&
        !this.qualifyHandoff.hasQualifyBeenSent())
    ) {
      this.sm.transition("SHORT_WAIT");
      void this.telemetry("wait_short");
    } else {
      this.sm.transition("GENERATION_COMPLETE");
    }

    if (this.session) {
      await sendMessage({
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
    this.qualifyHandoff.reset();
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
