export interface AiSiteAdapter {
  id: string;
  name: string;
  hostnamePatterns: string[];
  /** Platform key sent to server (inventory context only). */
  platformKey: string;
  generationSelectors: string[];
  detectGenerationStart(): boolean;
  detectGenerationActive(): boolean;
  detectGenerationEnd(): boolean;
  findPreferredAdAnchor(): HTMLElement | null;
  findFallbackAnchor(): HTMLElement | null;
  cleanupDuplicateAds(): void;
}

const GENERIC_STOP_SELECTORS = [
  '[aria-label="Stop generating"]',
  '[aria-label*="Stop"]',
  '[data-testid="stop-button"]',
  'button[aria-label="Stop streaming"]',
];

function hostMatches(hostname: string, patterns: string[]): boolean {
  const h = hostname.toLowerCase();
  return patterns.some((p) => {
    const pat = p.toLowerCase();
    return h === pat || h.endsWith(`.${pat}`);
  });
}

function queryFirst(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

function scopeHasStop(scope: ParentNode, selectors: string[]): boolean {
  for (const sel of selectors) {
    if (scope.querySelector(sel)) return true;
  }
  return false;
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    parseFloat(style.opacity) > 0
  );
}

function isInConversationRegion(el: HTMLElement): boolean {
  return Boolean(
    el.closest('main, [role="main"], article, form, [role="dialog"]') ||
      el.closest(
        '[data-testid*="conversation"], [data-testid*="message"], [data-testid*="thread"], [data-testid*="composer"], [data-testid*="chat"]',
      ),
  );
}

function walkAnchorFromIndicator(
  indicator: HTMLElement,
  maxDepth = 12,
  minWidth = 300,
): HTMLElement | null {
  let current: HTMLElement | null = indicator.parentElement;
  for (let d = 0; d < maxDepth && current; d++) {
    if (
      current.getBoundingClientRect().width >= minWidth &&
      isVisible(current) &&
      isInConversationRegion(current)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function findComposerAnchor(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el || !isVisible(el)) continue;
    const form = el.closest("form");
    if (form?.parentElement) return form;
    if (el.parentElement) return el.parentElement;
  }
  return null;
}

function createAdapter(def: {
  id: string;
  name: string;
  hostnamePatterns: string[];
  platformKey: string;
  generationSelectors: string[];
  composerSelectors?: string[];
  extraActiveCheck?: () => boolean;
  anchorStrategy?: "composer" | "indicator";
}): AiSiteAdapter {
  const allSelectors = [...def.generationSelectors, ...GENERIC_STOP_SELECTORS];
  const anchorStrategy = def.anchorStrategy ?? "indicator";

  return {
    id: def.id,
    name: def.name,
    hostnamePatterns: def.hostnamePatterns,
    platformKey: def.platformKey,
    generationSelectors: def.generationSelectors,

    detectGenerationStart(): boolean {
      return this.detectGenerationActive();
    },

    detectGenerationActive(): boolean {
      if (queryFirst(def.generationSelectors)) return true;
      if (def.extraActiveCheck?.()) return true;

      const progressBars = document.querySelectorAll(
        '[role="progressbar"][aria-valuetext], [role="progressbar"][aria-busy="true"]',
      );
      if (progressBars.length > 0) return true;

      const submitButtons = document.querySelectorAll<HTMLButtonElement>(
        'button[type="submit"][disabled], button[data-testid="send-button"][disabled], button[data-testid*="send"][disabled], button[aria-label*="Send"][disabled]',
      );
      for (const button of submitButtons) {
        const scope = button.closest("form") ?? document;
        if (scopeHasStop(scope, allSelectors)) return true;
      }
      return false;
    },

    detectGenerationEnd(): boolean {
      return !this.detectGenerationActive();
    },

    findPreferredAdAnchor(): HTMLElement | null {
      if (anchorStrategy === "composer" && def.composerSelectors) {
        const composer = findComposerAnchor(def.composerSelectors);
        if (composer) return composer;
      }

      const indicator = queryFirst(def.generationSelectors);
      if (!indicator) {
        if (def.composerSelectors) {
          return findComposerAnchor(def.composerSelectors);
        }
        return null;
      }
      return walkAnchorFromIndicator(indicator);
    },

    findFallbackAnchor(): HTMLElement | null {
      const main =
        document.querySelector<HTMLElement>('main, [role="main"]') ??
        document.body;
      return main;
    },

    cleanupDuplicateAds(): void {
      const nodes = document.querySelectorAll("omni-wait-ad, #omni-wait-ad-host");
      nodes.forEach((n, i) => {
        if (i > 0) n.remove();
      });
      document.querySelectorAll("#omni-piggy-mindful-break").forEach((el) => {
        el.remove();
      });
    },
  };
}

export const SITE_ADAPTERS: AiSiteAdapter[] = [
  createAdapter({
    id: "chatgpt",
    name: "ChatGPT",
    hostnamePatterns: ["chatgpt.com"],
    platformKey: "chatgpt.com",
    anchorStrategy: "composer",
    composerSelectors: [
      "#prompt-textarea",
      '[data-testid="composer-background"]',
      'textarea[placeholder*="Message"]',
      'form:has(textarea)',
    ],
    generationSelectors: [
      '[data-testid="stop-button"]',
      '[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]',
    ],
  }),
  createAdapter({
    id: "claude",
    name: "Claude",
    hostnamePatterns: ["claude.ai"],
    platformKey: "claude.ai",
    anchorStrategy: "composer",
    composerSelectors: [
      '[data-testid="chat-input"]',
      'div[contenteditable="true"]',
      'fieldset',
    ],
    generationSelectors: [
      'button[aria-label="Stop streaming"]',
      '[aria-label*="Stop"]',
    ],
  }),
  createAdapter({
    id: "gemini",
    name: "Gemini",
    hostnamePatterns: ["gemini.google.com"],
    platformKey: "gemini.google.com",
    anchorStrategy: "composer",
    composerSelectors: [
      'rich-textarea',
      '[aria-label*="Enter a prompt"]',
      'textarea',
    ],
    generationSelectors: [
      'button[aria-label*="Stop"]',
      'button[aria-label*="Cancel"]',
      'button[title*="Stop"]',
      '[role="progressbar"][aria-valuetext]',
    ],
  }),
  createAdapter({
    id: "perplexity",
    name: "Perplexity",
    hostnamePatterns: ["perplexity.ai", "www.perplexity.ai"],
    platformKey: "perplexity.ai",
    generationSelectors: [
      '[aria-label*="Stop"]',
      '[data-testid*="stop"]',
      '[data-testid*="typing"]',
    ],
  }),
  createAdapter({
    id: "copilot",
    name: "Copilot",
    hostnamePatterns: ["copilot.microsoft.com"],
    platformKey: "copilot.microsoft.com",
    generationSelectors: [
      '[aria-label*="Stop"]',
      '[data-testid*="stop"]',
      'button[type="submit"][disabled][aria-label*="Send"]',
    ],
  }),
  createAdapter({
    id: "deepseek",
    name: "DeepSeek",
    hostnamePatterns: ["chat.deepseek.com"],
    platformKey: "chat.deepseek.com",
    generationSelectors: ['[aria-label*="Stop"]', '[data-testid*="stop"]'],
  }),
  createAdapter({
    id: "grok",
    name: "Grok",
    hostnamePatterns: ["grok.com"],
    platformKey: "grok.com",
    anchorStrategy: "composer",
    composerSelectors: [
      'textarea',
      '[contenteditable="true"]',
      'form',
    ],
    generationSelectors: ['[aria-label*="Stop"]', '[data-testid*="stop"]'],
  }),
  createAdapter({
    id: "meta_ai",
    name: "Meta AI",
    hostnamePatterns: ["meta.ai", "www.meta.ai"],
    platformKey: "meta.ai",
    generationSelectors: ['[aria-label*="Stop"]'],
  }),
  createAdapter({
    id: "mistral",
    name: "Le Chat",
    hostnamePatterns: ["chat.mistral.ai"],
    platformKey: "chat.mistral.ai",
    generationSelectors: ['[aria-label*="Stop"]'],
  }),
  createAdapter({
    id: "poe",
    name: "Poe",
    hostnamePatterns: ["poe.com", "www.poe.com"],
    platformKey: "poe.com",
    generationSelectors: [
      '[aria-label*="Stop"]',
      '[data-testid*="stop"]',
      '[data-action*="stop"]',
    ],
  }),
];

export function getAdapterForHost(hostname: string): AiSiteAdapter | null {
  return (
    SITE_ADAPTERS.find((a) => hostMatches(hostname, a.hostnamePatterns)) ??
    null
  );
}

export function getAdapterById(id: string): AiSiteAdapter | null {
  return SITE_ADAPTERS.find((a) => a.id === id) ?? null;
}
