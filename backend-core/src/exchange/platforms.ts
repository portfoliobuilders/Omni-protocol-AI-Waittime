/**
 * Canonical wait-inventory vocabulary.
 * adapterId = extension adapter id
 * hostname = site host
 * inventoryKey = value stored on wait_sessions.platform (hostnames, matching existing rows)
 */
export type InventoryPlatform = {
  adapterId: string;
  name: string;
  hostname: string;
  extraHostnames?: readonly string[];
  inventoryKey: string;
};

export const INVENTORY_PLATFORMS: readonly InventoryPlatform[] = [
  {
    adapterId: "chatgpt",
    name: "ChatGPT",
    hostname: "chatgpt.com",
    inventoryKey: "chatgpt.com",
  },
  {
    adapterId: "claude",
    name: "Claude",
    hostname: "claude.ai",
    inventoryKey: "claude.ai",
  },
  {
    adapterId: "gemini",
    name: "Gemini",
    hostname: "gemini.google.com",
    inventoryKey: "gemini.google.com",
  },
  {
    adapterId: "perplexity",
    name: "Perplexity",
    hostname: "perplexity.ai",
    extraHostnames: ["www.perplexity.ai"],
    inventoryKey: "perplexity.ai",
  },
  {
    adapterId: "copilot",
    name: "Copilot",
    hostname: "copilot.microsoft.com",
    inventoryKey: "copilot.microsoft.com",
  },
  {
    adapterId: "deepseek",
    name: "DeepSeek",
    hostname: "chat.deepseek.com",
    inventoryKey: "chat.deepseek.com",
  },
  {
    adapterId: "grok",
    name: "Grok",
    hostname: "grok.com",
    inventoryKey: "grok.com",
  },
  {
    adapterId: "meta_ai",
    name: "Meta AI",
    hostname: "meta.ai",
    extraHostnames: ["www.meta.ai"],
    inventoryKey: "meta.ai",
  },
  {
    adapterId: "mistral",
    name: "Le Chat",
    hostname: "chat.mistral.ai",
    inventoryKey: "chat.mistral.ai",
  },
  {
    adapterId: "poe",
    name: "Poe",
    hostname: "poe.com",
    extraHostnames: ["www.poe.com"],
    inventoryKey: "poe.com",
  },
] as const;

function aliasesFor(p: InventoryPlatform): string[] {
  return [p.adapterId, p.hostname, p.inventoryKey, ...(p.extraHostnames ?? [])];
}

const ALIAS_TO_KEY = new Map<string, string>();
for (const p of INVENTORY_PLATFORMS) {
  for (const alias of aliasesFor(p)) {
    ALIAS_TO_KEY.set(alias.toLowerCase(), p.inventoryKey);
  }
}

export function lookupInventoryPlatform(
  raw: string,
): InventoryPlatform | null {
  const key = ALIAS_TO_KEY.get(raw.trim().toLowerCase());
  if (!key) return null;
  return INVENTORY_PLATFORMS.find((p) => p.inventoryKey === key) ?? null;
}

/** Returns canonical wait_sessions.platform value, or null if unknown. */
export function canonicalizeInventoryPlatform(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, 64);
  if (!trimmed) return null;
  return ALIAS_TO_KEY.get(trimmed.toLowerCase()) ?? null;
}

export function extensionPlatformConfig(): Array<{
  id: string;
  name: string;
  enabled: boolean;
  sponsoredWaitEnabled: boolean;
  hosts: string[];
}> {
  return INVENTORY_PLATFORMS.map((p) => ({
    id: p.adapterId,
    name: p.name,
    enabled: true,
    sponsoredWaitEnabled: true,
    hosts: [p.hostname, ...(p.extraHostnames ?? [])],
  }));
}
