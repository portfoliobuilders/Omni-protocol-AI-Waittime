import { formatMicropaiseDisplay } from "../shared/format";
import type { PlatformConfig, QualifyResult, WaitAdData } from "../shared/types";
import { isHttpsUrl } from "../shared/messages";

export type OmniWaitAdPhase =
  | "shell"
  | "compact"
  | "standard"
  | "qualified"
  | "settled"
  | "fading";

export type OmniWaitAdCallbacks = {
  onDismiss: () => void;
  onCtaClick: (url: string) => void;
  onReport: () => void;
};

const HOST_TAG = "omni-wait-ad";
const HOST_ID = "omni-wait-ad-host";

export class OmniWaitAd {
  private host: HTMLElement;
  private shadow: ShadowRoot;
  private phase: OmniWaitAdPhase = "shell";
  private ad: WaitAdData | null = null;
  private config: PlatformConfig;
  private platformName: string;
  private qualifyResult: QualifyResult | null = null;
  private callbacks: OmniWaitAdCallbacks;
  private whyOpen = false;

  constructor(
    config: PlatformConfig,
    platformName: string,
    callbacks: OmniWaitAdCallbacks,
  ) {
    this.config = config;
    this.platformName = platformName;
    this.callbacks = callbacks;
    this.host = document.createElement(HOST_TAG);
    this.host.id = HOST_ID;
    this.host.setAttribute("role", "complementary");
    this.host.setAttribute("aria-label", "Omni Sponsored Wait");
    this.shadow = this.host.attachShadow({ mode: "closed" });
    this.injectStyles();
    this.render();
  }

  getElement(): HTMLElement {
    return this.host;
  }

  mount(preferred: HTMLElement | null, fallback: HTMLElement | null): void {
    this.removeDuplicates();
    if (preferred?.parentElement) {
      this.host.classList.add("omni-inline");
      preferred.parentElement.insertBefore(this.host, preferred);
      return;
    }
    this.host.classList.add("omni-floating");
    (fallback ?? document.body).appendChild(this.host);
  }

  setAd(ad: WaitAdData): void {
    this.ad = ad;
    this.phase = ad.source === "house" ? "standard" : "compact";
    this.render();
  }

  expandToStandard(): void {
    if (this.phase === "shell" || this.phase === "compact") {
      this.phase = "standard";
      this.render();
    }
  }

  showShell(): void {
    this.phase = "shell";
    this.render();
  }

  setQualified(result: QualifyResult): void {
    this.qualifyResult = result;
    this.phase = "settled";
    this.render();
  }

  fadeOut(onDone: () => void): void {
    this.phase = "fading";
    this.host.classList.add("omni-fade-out");
    window.setTimeout(() => {
      this.destroy();
      onDone();
    }, 480);
  }

  destroy(): void {
    this.host.remove();
  }

  static removeAll(): void {
    document.querySelectorAll(HOST_TAG).forEach((el) => el.remove());
    document.querySelectorAll(`#${HOST_ID}`).forEach((el) => el.remove());
  }

  private removeDuplicates(): void {
    const all = document.querySelectorAll(HOST_TAG);
    all.forEach((el) => {
      if (el !== this.host) el.remove();
    });
  }

  private injectStyles(): void {
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
        z-index: 2147483647;
        display: block;
        box-sizing: border-box;
      }
      :host(.omni-floating) {
        position: fixed;
        top: 16px;
        right: 16px;
        width: min(320px, calc(100vw - 32px));
      }
      :host(.omni-inline) {
        position: relative;
        max-width: 420px;
        margin: 12px 0;
        width: 100%;
      }
      :host(.omni-fade-out) {
        opacity: 0;
        transform: translateY(-4px);
        transition: opacity 0.45s ease, transform 0.45s ease;
        pointer-events: none;
      }
      .card {
        border-radius: 14px;
        border: 1px solid var(--omni-border);
        background: var(--omni-bg);
        color: var(--omni-text);
        box-shadow: var(--omni-shadow);
        padding: 14px 16px;
        animation: omni-in 0.35s ease;
      }
      @keyframes omni-in {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .row { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
      .label {
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--omni-muted);
        margin: 0 0 8px;
      }
      .headline { font-size: 14px; font-weight: 600; margin: 0 0 4px; line-height: 1.35; }
      .body { font-size: 12px; line-height: 1.45; color: var(--omni-sub); margin: 0 0 10px; }
      .shell-text { font-size: 12px; color: var(--omni-sub); margin: 0; }
      .cta {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 7px 12px;
        border-radius: 8px;
        border: 1px solid var(--omni-border);
        background: transparent;
        color: var(--omni-text);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        text-decoration: none;
      }
      .cta:focus-visible { outline: 2px solid var(--omni-accent); outline-offset: 2px; }
      .cta:hover { background: var(--omni-hover); }
      .footer {
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid var(--omni-border);
        font-size: 10px;
        color: var(--omni-muted);
        line-height: 1.4;
      }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
      .link-btn {
        background: none;
        border: none;
        padding: 0;
        font-size: 10px;
        color: var(--omni-muted);
        cursor: pointer;
        text-decoration: underline;
      }
      .link-btn:focus-visible { outline: 2px solid var(--omni-accent); }
      .icon-btn {
        background: none;
        border: none;
        color: var(--omni-muted);
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        padding: 2px 4px;
        border-radius: 4px;
      }
      .icon-btn:focus-visible { outline: 2px solid var(--omni-accent); }
      .qualified {
        font-size: 11px;
        font-weight: 600;
        color: var(--omni-accent);
        margin: 8px 0 0;
      }
      .why-panel {
        margin-top: 8px;
        padding: 8px;
        border-radius: 8px;
        background: var(--omni-hover);
        font-size: 10px;
        line-height: 1.45;
        color: var(--omni-sub);
      }
      @media (prefers-color-scheme: light) {
        :host {
          --omni-bg: linear-gradient(145deg, #ffffff 0%, #f8faf9 100%);
          --omni-text: #18181b;
          --omni-sub: #52525b;
          --omni-muted: #71717a;
          --omni-border: rgba(0,0,0,0.1);
          --omni-shadow: 0 8px 32px rgba(0,0,0,0.12);
          --omni-accent: #15803d;
          --omni-hover: rgba(0,0,0,0.04);
        }
      }
      @media (prefers-color-scheme: dark) {
        :host {
          --omni-bg: linear-gradient(145deg, #1a1a1e 0%, #141416 100%);
          --omni-text: #f4f4f5;
          --omni-sub: #a1a1aa;
          --omni-muted: #71717a;
          --omni-border: rgba(57,255,136,0.2);
          --omni-shadow: 0 12px 40px rgba(0,0,0,0.45);
          --omni-accent: #39ff88;
          --omni-hover: rgba(255,255,255,0.06);
        }
      }
    `;
    this.shadow.appendChild(style);
  }

  private render(): void {
    const root = this.shadow.querySelector(".card") ?? document.createElement("div");
    root.className = "card";
    root.replaceChildren();

    const userPct = Math.floor(this.config.userRevenueShareBps / 100);
    const isHouse = this.ad?.source === "house" || this.ad?.providerKey === "house";
    const showEarning =
      this.qualifyResult &&
      !this.qualifyResult.house &&
      this.qualifyResult.userShareMicropaise > 0 &&
      !this.qualifyResult.duplicate;

    // Header row
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("p");
    label.className = "label";
    label.textContent = this.ad?.sponsoredLabel ?? "Sponsored";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "icon-btn";
    dismiss.setAttribute("aria-label", "Dismiss sponsored wait");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => this.callbacks.onDismiss());
    row.append(label, dismiss);
    root.appendChild(row);

    if (this.phase === "shell" || !this.ad) {
      const shell = document.createElement("p");
      shell.className = "shell-text";
      shell.textContent = "Eligible sponsored waits share revenue with you.";
      root.appendChild(shell);
    } else if (this.ad) {
      const headline = document.createElement("p");
      headline.className = "headline";
      headline.textContent = this.ad.creative.headline;
      root.appendChild(headline);

      if (this.phase !== "compact" && this.ad.creative.body) {
        const body = document.createElement("p");
        body.className = "body";
        body.textContent = this.ad.creative.body;
        root.appendChild(body);
      }

      if (isHttpsUrl(this.ad.creative.cta_url)) {
        const cta = document.createElement("button");
        cta.type = "button";
        cta.className = "cta";
        cta.textContent = `${this.ad.creative.cta_label} →`;
        cta.addEventListener("click", () => {
          this.callbacks.onCtaClick(this.ad!.creative.cta_url);
        });
        root.appendChild(cta);
      }
    }

    if (showEarning && this.qualifyResult) {
      const q = document.createElement("p");
      q.className = "qualified";
      q.textContent = `Qualified · +${formatMicropaiseDisplay(this.qualifyResult.userShareMicropaise, this.config.symbol)}`;
      root.appendChild(q);
    }

    const footer = document.createElement("div");
    footer.className = "footer";
    if (!isHouse) {
      footer.textContent = `Omni · Eligible sponsored waits share ${userPct}% of direct ad revenue with you.`;
    } else {
      footer.textContent = "Omni · Promoted inventory — no monetary settlement for this wait.";
    }
    root.appendChild(footer);

    const actions = document.createElement("div");
    actions.className = "actions";
    const whyBtn = document.createElement("button");
    whyBtn.type = "button";
    whyBtn.className = "link-btn";
    whyBtn.textContent = "Why this ad?";
    whyBtn.addEventListener("click", () => {
      this.whyOpen = !this.whyOpen;
      this.render();
    });
    const reportBtn = document.createElement("button");
    reportBtn.type = "button";
    reportBtn.className = "link-btn";
    reportBtn.textContent = "Report ad";
    reportBtn.addEventListener("click", () => this.callbacks.onReport());
    actions.append(whyBtn, reportBtn);
    root.appendChild(actions);

    if (this.whyOpen) {
      const panel = document.createElement("div");
      panel.className = "why-panel";
      panel.textContent = `This sponsor selected ${this.platformName} wait-time inventory. Omni did not read your conversation to choose this ad.`;
      root.appendChild(panel);
    }

    if (!this.shadow.contains(root)) {
      this.shadow.appendChild(root);
    }
  }
}
