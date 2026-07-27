import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEYS = {
  earnings: "omniEarnings",
  userId: "omniUserId",
  activeAiLayer: "activeAiLayer",
  behavioralLayer: "behavioralLayer",
  passiveDepinLayer: "passiveDepinLayer",
} as const;

type LayerKey =
  | typeof STORAGE_KEYS.activeAiLayer
  | typeof STORAGE_KEYS.behavioralLayer
  | typeof STORAGE_KEYS.passiveDepinLayer;

interface LayerToggle {
  key: LayerKey;
  label: string;
  description: string;
}

interface Transaction {
  id: number;
  user_id: string;
  amount: number;
  layer: string;
  nonce: string;
  created_at: string;
}

interface WalletData {
  balance: number;
  transactions: Transaction[];
}

interface Redemption {
  id: number;
  user_id: string;
  amount: number;
  method: string;
  detail: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

type RedemptionMethod = "amazon_voucher" | "upi";

type BackgroundMessage =
  | { type: "GET_WALLET"; payload?: { limit?: number } }
  | { type: "GET_HEALTH" }
  | { type: "GET_CONFIG" }
  | {
      type: "REDEEM";
      payload: { method: RedemptionMethod; detail: string };
    }
  | { type: "GET_REDEMPTIONS" };

type BackgroundResponse =
  | { ok: true; data: unknown; status?: number }
  | { ok: false; error: string; status?: number };

const LAYER_LABELS: Record<string, string> = {
  activeAiLayer: "Active AI Layer",
  behavioralLayer: "Behavioral Layer",
  passiveDepinLayer: "Passive DePIN Layer",
};

type RevenueShareConfig = {
  earner: number;
  pool: number;
  platform: number;
};

type RewardConfig = {
  currency: string;
  symbol: string;
  tier2Amount: number;
  tier3Amount: number;
  minRedemption: number;
  minWaitSeconds: number;
  tier3Seconds: number;
  revenueShare: RevenueShareConfig;
};

const FALLBACK_REVENUE_SHARE: RevenueShareConfig = {
  earner: 60,
  pool: 20,
  platform: 20,
};

const FALLBACK_REWARD_CONFIG: RewardConfig = {
  currency: "INR",
  symbol: "₹",
  tier2Amount: 2,
  tier3Amount: 10,
  minRedemption: 100,
  minWaitSeconds: 5,
  tier3Seconds: 15,
  revenueShare: FALLBACK_REVENUE_SHARE,
};

function formatMoney(symbol: string, value: number): string {
  const display = value % 1 === 0 ? String(value) : value.toFixed(2);
  return `${symbol}${display}`;
}

const LAYERS: LayerToggle[] = [
  {
    key: STORAGE_KEYS.activeAiLayer,
    label: "Active AI Layer",
    description: "Earn while your AI models are generating responses.",
  },
  {
    key: STORAGE_KEYS.behavioralLayer,
    label: "Behavioral Layer",
    description: "Capture mindful wait-time signals from chat sessions.",
  },
  {
    key: STORAGE_KEYS.passiveDepinLayer,
    label: "Passive DePIN Layer",
    description: "Background network participation for passive yield.",
  },
];

function parseRevenueShare(value: unknown): RevenueShareConfig {
  if (typeof value !== "object" || value === null) {
    return FALLBACK_REVENUE_SHARE;
  }
  const obj = value as Record<string, unknown>;
  const pickPct = (key: keyof RevenueShareConfig, fallback: number): number => {
    const n = obj[key];
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    earner: pickPct("earner", FALLBACK_REVENUE_SHARE.earner),
    pool: pickPct("pool", FALLBACK_REVENUE_SHARE.pool),
    platform: pickPct("platform", FALLBACK_REVENUE_SHARE.platform),
  };
}

function parseRewardConfig(data: unknown): RewardConfig {
  if (typeof data !== "object" || data === null) return FALLBACK_REWARD_CONFIG;
  const obj = data as Record<string, unknown>;
  const pick = <K extends keyof RewardConfig>(
    key: K,
    fallback: RewardConfig[K],
  ): RewardConfig[K] => {
    const value = obj[key];
    return typeof value === typeof fallback ? (value as RewardConfig[K]) : fallback;
  };
  return {
    currency: pick("currency", FALLBACK_REWARD_CONFIG.currency),
    symbol: pick("symbol", FALLBACK_REWARD_CONFIG.symbol),
    tier2Amount: pick("tier2Amount", FALLBACK_REWARD_CONFIG.tier2Amount),
    tier3Amount: pick("tier3Amount", FALLBACK_REWARD_CONFIG.tier3Amount),
    minRedemption: pick("minRedemption", FALLBACK_REWARD_CONFIG.minRedemption),
    minWaitSeconds: pick("minWaitSeconds", FALLBACK_REWARD_CONFIG.minWaitSeconds),
    tier3Seconds: pick("tier3Seconds", FALLBACK_REWARD_CONFIG.tier3Seconds),
    revenueShare: parseRevenueShare(obj.revenueShare),
  };
}

function formatRelativeTime(createdAt: string): string {
  const ms = Date.parse(createdAt.replace(" ", "T") + "Z");
  if (Number.isNaN(ms)) return "";

  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function sendBackgroundMessage(message: BackgroundMessage): Promise<BackgroundResponse> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response: BackgroundResponse | undefined) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        if (!response) {
          reject(new Error("No background response"));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function parseWalletData(data: unknown): WalletData | null {
  if (typeof data !== "object" || data === null) return null;

  const wallet = data as Record<string, unknown>;
  if (typeof wallet.balance !== "number") return null;
  if (!Array.isArray(wallet.transactions)) return null;

  return {
    balance: wallet.balance,
    transactions: wallet.transactions as Transaction[],
  };
}

function parseRedemptionsData(data: unknown): Redemption[] {
  if (typeof data !== "object" || data === null) return [];
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.redemptions)) return obj.redemptions as Redemption[];
  return [];
}

function ToggleSwitch({
  enabled,
  label,
  description,
  onChange,
}: {
  enabled: boolean;
  label: string;
  description: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-omni-border bg-omni-surface px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-white">{label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
          {description}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        onClick={() => onChange(!enabled)}
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-omni-neon focus-visible:ring-offset-2 focus-visible:ring-offset-omni-bg ${
          enabled ? "bg-omni-neonDim" : "bg-zinc-700"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow-md transition-transform duration-200 ${
            enabled ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

export default function App() {
  const [earnings, setEarnings] = useState(0);
  const [balanceSource, setBalanceSource] = useState<"api" | "local">("local");
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({
    [STORAGE_KEYS.activeAiLayer]: true,
    [STORAGE_KEYS.behavioralLayer]: false,
    [STORAGE_KEYS.passiveDepinLayer]: false,
  });
  const [loaded, setLoaded] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [transactionsLoading, setTransactionsLoading] = useState(true);
  const [transactionsOffline, setTransactionsOffline] = useState(false);
  const [bankOnline, setBankOnline] = useState<boolean | null>(null);
  const [userIdPrefix, setUserIdPrefix] = useState<string | null>(null);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [showRedeemForm, setShowRedeemForm] = useState(false);
  const [redeemMethod, setRedeemMethod] = useState<RedemptionMethod>("amazon_voucher");
  const [redeemDetail, setRedeemDetail] = useState("");
  const [redeemSubmitting, setRedeemSubmitting] = useState(false);
  const [redeemSuccess, setRedeemSuccess] = useState(false);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [rewardConfig, setRewardConfig] = useState<RewardConfig>(FALLBACK_REWARD_CONFIG);
  const [showRewardsInfo, setShowRewardsInfo] = useState(false);
  const balanceSourceRef = useRef(balanceSource);
  balanceSourceRef.current = balanceSource;

  useEffect(() => {
    chrome.storage.local.get(
      [
        STORAGE_KEYS.earnings,
        STORAGE_KEYS.userId,
        STORAGE_KEYS.activeAiLayer,
        STORAGE_KEYS.behavioralLayer,
        STORAGE_KEYS.passiveDepinLayer,
      ],
      (result) => {
        setEarnings(Number(result[STORAGE_KEYS.earnings] ?? 0));
        const userId = result[STORAGE_KEYS.userId];
        setUserIdPrefix(typeof userId === "string" ? userId.slice(0, 8) : null);
        setLayers({
          [STORAGE_KEYS.activeAiLayer]: Boolean(
            result[STORAGE_KEYS.activeAiLayer] ?? true,
          ),
          [STORAGE_KEYS.behavioralLayer]: Boolean(
            result[STORAGE_KEYS.behavioralLayer] ?? false,
          ),
          [STORAGE_KEYS.passiveDepinLayer]: Boolean(
            result[STORAGE_KEYS.passiveDepinLayer] ?? false,
          ),
        });
        setLoaded(true);
      },
    );

    void (async () => {
      let bankKnownOnline = false;
      setTransactionsLoading(true);
      setTransactionsOffline(false);

      try {
        const configResponse = await sendBackgroundMessage({ type: "GET_CONFIG" });
        if (configResponse.ok) {
          setRewardConfig(parseRewardConfig(configResponse.data));
        }
      } catch {
        // keep fallback config
      }

      try {
        const walletResponse = await sendBackgroundMessage({
          type: "GET_WALLET",
          payload: { limit: 10 },
        });
        if (!walletResponse.ok) {
          throw new Error(
            walletResponse.status
              ? `Wallet API responded with ${walletResponse.status}`
              : walletResponse.error,
          );
        }

        const wallet = parseWalletData(walletResponse.data);
        if (wallet === null) throw new Error("Unexpected wallet response shape");

        setEarnings(wallet.balance);
        setBalanceSource("api");
        setTransactions(wallet.transactions);
        setTransactionsOffline(false);
        setBankOnline(true);
        bankKnownOnline = true;
      } catch {
        setBalanceSource("local");
        setTransactionsOffline(true);
      } finally {
        setTransactionsLoading(false);
      }

      if (!bankKnownOnline) {
        try {
          const healthResponse = await sendBackgroundMessage({ type: "GET_HEALTH" });
          setBankOnline(healthResponse.ok);
        } catch {
          setBankOnline(false);
        }
      }

      try {
        const redemptionsResponse = await sendBackgroundMessage({ type: "GET_REDEMPTIONS" });
        if (redemptionsResponse.ok) {
          setRedemptions(parseRedemptionsData(redemptionsResponse.data));
        }
      } catch {
        // redemptions unavailable offline
      }
    })();

    const onStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "local") return;

      if (changes[STORAGE_KEYS.earnings] && balanceSourceRef.current === "local") {
        setEarnings(Number(changes[STORAGE_KEYS.earnings].newValue ?? 0));
      }

      if (changes[STORAGE_KEYS.userId]) {
        const nextId = changes[STORAGE_KEYS.userId].newValue;
        setUserIdPrefix(typeof nextId === "string" ? nextId.slice(0, 8) : null);
      }

      setLayers((prev) => {
        const next = { ...prev };
        for (const key of Object.values(STORAGE_KEYS)) {
          if (key === STORAGE_KEYS.earnings || key === STORAGE_KEYS.userId) continue;
          if (changes[key]) {
            next[key as LayerKey] = Boolean(changes[key].newValue);
          }
        }
        return next;
      });
    };

    chrome.storage.onChanged.addListener(onStorageChange);
    return () => chrome.storage.onChanged.removeListener(onStorageChange);
  }, []);

  const handleLayerToggle = useCallback((key: LayerKey, next: boolean) => {
    setLayers((prev) => ({ ...prev, [key]: next }));
    chrome.storage.local.set({ [key]: next });
  }, []);

  const pendingRedemption = redemptions.find((r) => r.status === "pending");

  const handleRedeemSubmit = useCallback(async () => {
    const detail = redeemDetail.trim();
    if (!detail) {
      setRedeemError("Please enter your email or UPI ID.");
      return;
    }

    setRedeemSubmitting(true);
    setRedeemError(null);

    try {
      const response = await sendBackgroundMessage({
        type: "REDEEM",
        payload: { method: redeemMethod, detail },
      });

      if (!response.ok) {
        throw new Error(response.error);
      }

      setRedeemSuccess(true);
      setShowRedeemForm(false);
      setEarnings(0);
      setBalanceSource("api");

      const refreshed = await sendBackgroundMessage({ type: "GET_REDEMPTIONS" });
      if (refreshed.ok) {
        setRedemptions(parseRedemptionsData(refreshed.data));
      }
    } catch (err) {
      setRedeemError(err instanceof Error ? err.message : "Redemption failed.");
    } finally {
      setRedeemSubmitting(false);
    }
  }, [redeemDetail, redeemMethod]);

  const methodLabel = (method: string) =>
    method === "amazon_voucher" ? "Amazon Pay voucher" : "UPI";

  return (
    <div className="min-h-[420px] bg-omni-bg p-5 text-white">
      <header className="mb-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
              OmniPiggy
            </p>
            <h1 className="mt-1 text-lg font-semibold text-white">
              Personal AI Dividend
            </h1>
          </div>
          {bankOnline !== null && (
            <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-omni-border bg-omni-surface px-2 py-1">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  bankOnline ? "bg-omni-neon" : "bg-zinc-500"
                }`}
              />
              <span className="text-[10px] text-zinc-400">
                {bankOnline ? "Bank online" : "Bank offline"}
              </span>
            </div>
          )}
        </div>
      </header>

      <section className="mb-8 rounded-2xl border border-omni-border bg-omni-surface p-5">
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
          Wallet Balance
        </p>
        <p
          className={`mt-2 text-4xl font-bold tabular-nums text-omni-neon ${
            loaded ? "animate-pulse-glow shadow-neon" : "opacity-50"
          }`}
          style={{ textShadow: "0 0 16px rgba(57, 255, 136, 0.45)" }}
        >
          {formatMoney(rewardConfig.symbol, earnings)}
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          {balanceSource === "api"
            ? "Live balance from Omni Bank"
            : "Live balance synced from chrome.storage.local"}
        </p>

        {pendingRedemption ? (
          <div className="mt-4 rounded-lg border border-omni-border bg-omni-bg px-3 py-2.5">
            <p className="text-xs font-medium text-amber-400">
              Redemption pending — {formatMoney(rewardConfig.symbol, pendingRedemption.amount)} via{" "}
              {methodLabel(pendingRedemption.method)}
            </p>
            <p className="mt-1 text-[11px] text-zinc-500">
              We&apos;ll process it within a few days.
            </p>
          </div>
        ) : redeemSuccess ? (
          <p className="mt-4 text-xs text-omni-neon">
            Redemption requested — we&apos;ll process it within a few days.
          </p>
        ) : earnings >= rewardConfig.minRedemption ? (
          <div className="mt-4">
            {!showRedeemForm ? (
              <button
                type="button"
                onClick={() => {
                  setShowRedeemForm(true);
                  setRedeemError(null);
                }}
                className="rounded-lg border border-omni-neonDim bg-omni-neonDim/10 px-4 py-2 text-xs font-semibold text-omni-neon transition-colors hover:bg-omni-neonDim/20"
              >
                Redeem
              </button>
            ) : (
              <div className="rounded-lg border border-omni-border bg-omni-bg p-3">
                <div className="mb-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setRedeemMethod("amazon_voucher")}
                    className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${
                      redeemMethod === "amazon_voucher"
                        ? "bg-omni-neonDim/20 text-omni-neon border border-omni-neonDim"
                        : "bg-zinc-800 text-zinc-400 border border-transparent"
                    }`}
                  >
                    Amazon Pay voucher
                  </button>
                  <button
                    type="button"
                    onClick={() => setRedeemMethod("upi")}
                    className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${
                      redeemMethod === "upi"
                        ? "bg-omni-neonDim/20 text-omni-neon border border-omni-neonDim"
                        : "bg-zinc-800 text-zinc-400 border border-transparent"
                    }`}
                  >
                    UPI
                  </button>
                </div>
                <input
                  type="text"
                  value={redeemDetail}
                  onChange={(e) => setRedeemDetail(e.target.value)}
                  placeholder={
                    redeemMethod === "amazon_voucher"
                      ? "Email address"
                      : "UPI ID"
                  }
                  className="mb-2 w-full rounded-md border border-omni-border bg-omni-surface px-3 py-2 text-xs text-white placeholder:text-zinc-600 focus:border-omni-neonDim focus:outline-none"
                />
                {redeemError && (
                  <p className="mb-2 text-[11px] text-red-400">{redeemError}</p>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={redeemSubmitting}
                    onClick={() => void handleRedeemSubmit()}
                    className="flex-1 rounded-md bg-omni-neonDim px-3 py-1.5 text-xs font-semibold text-omni-bg disabled:opacity-50"
                  >
                    {redeemSubmitting ? "Submitting…" : "Submit"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowRedeemForm(false);
                      setRedeemError(null);
                    }}
                    className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-300"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="mt-3 text-[11px] text-zinc-600">
            Redeem from {formatMoney(rewardConfig.symbol, rewardConfig.minRedemption)}
          </p>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Protocol Layers
        </h2>
        <div className="space-y-2">
          {LAYERS.map((layer) => (
            <ToggleSwitch
              key={layer.key}
              enabled={layers[layer.key]}
              label={layer.label}
              description={layer.description}
              onChange={(next) => handleLayerToggle(layer.key, next)}
            />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Recent Activity
        </h2>
        <div className="max-h-40 overflow-y-auto rounded-xl border border-omni-border bg-omni-surface">
          {transactionsLoading ? (
            <p className="px-4 py-6 text-center text-xs text-zinc-500">
              Loading activity…
            </p>
          ) : transactionsOffline ? (
            <p className="px-4 py-6 text-center text-xs text-zinc-500">
              Bank offline
            </p>
          ) : transactions.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-zinc-500">
              No dividends claimed yet
            </p>
          ) : (
            <ul className="divide-y divide-omni-border">
              {transactions.map((tx) => (
                <li
                  key={tx.id}
                  className="flex items-center justify-between gap-3 px-4 py-2.5"
                >
                  <span className="min-w-0 truncate text-xs text-zinc-300">
                    {LAYER_LABELS[tx.layer] ?? tx.layer}
                  </span>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-xs font-semibold tabular-nums text-omni-neon">
                      +{formatMoney(rewardConfig.symbol, tx.amount)}
                    </span>
                    <span className="text-[10px] text-zinc-500">
                      {formatRelativeTime(tx.created_at)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <footer className="mt-6 border-t border-omni-border pt-3 text-center">
        <button
          type="button"
          onClick={() => setShowRewardsInfo((open) => !open)}
          className="text-[10px] text-zinc-500 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-400"
        >
          How rewards work
        </button>
        {showRewardsInfo && (
          <p className="mt-2 px-1 text-left text-[10px] leading-relaxed text-zinc-500">
            While your AI is thinking, OmniPiggy offers small rewards: claim{" "}
            {formatMoney(rewardConfig.symbol, rewardConfig.tier2Amount)} after{" "}
            {rewardConfig.minWaitSeconds} seconds, or answer one quick question after{" "}
            {rewardConfig.tier3Seconds} seconds to earn{" "}
            {formatMoney(rewardConfig.symbol, rewardConfig.tier3Amount)}. When a
            sponsored ad is shown, that ad spend is split{" "}
            {rewardConfig.revenueShare.earner}% to you,{" "}
            {rewardConfig.revenueShare.pool}% to the community pool, and{" "}
            {rewardConfig.revenueShare.platform}% to the platform. Credits are
            experimental during our early release. Once your balance reaches{" "}
            {formatMoney(rewardConfig.symbol, rewardConfig.minRedemption)} you can request a
            redemption (Amazon Pay voucher or UPI), which we currently process manually
            within a few days. OmniPiggy never reads your conversations — it only detects
            when the AI is loading.
          </p>
        )}
        <p className="mt-2 text-[10px] font-mono tracking-wide text-zinc-600">
          ID: {userIdPrefix ?? "…"}
          <span className="mx-1.5 text-zinc-700">·</span>
          <a
            href="https://omni-protocol-ai-waittime-production.up.railway.app/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-zinc-500 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-400"
          >
            Privacy Policy
          </a>
        </p>
      </footer>
    </div>
  );
}
