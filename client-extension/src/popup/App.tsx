import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEYS = {
  earnings: "omniEarnings",
  userId: "omniUserId",
  sponsoredWaitsEnabled: "sponsoredWaitsEnabled",
} as const;

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

type PlatformConfig = {
  currency: string;
  symbol: string;
  minRedemption: number;
  minWaitSeconds: number;
  userRevenueShareBps: number;
  omniRevenueShareBps: number;
};

const FALLBACK_PLATFORM_CONFIG: PlatformConfig = {
  currency: "INR",
  symbol: "₹",
  minRedemption: 100,
  minWaitSeconds: 5,
  userRevenueShareBps: 6000,
  omniRevenueShareBps: 4000,
};

const SUPPORTED_PLATFORMS = [
  "ChatGPT",
  "Claude",
  "Gemini",
  "Perplexity",
  "Copilot",
  "DeepSeek",
  "Grok",
  "Meta AI",
  "Mistral",
  "Poe",
];

function formatMoney(symbol: string, value: number): string {
  const display = value % 1 === 0 ? String(value) : value.toFixed(2);
  return `${symbol}${display}`;
}

function parsePlatformConfig(data: unknown): PlatformConfig {
  if (typeof data !== "object" || data === null) return FALLBACK_PLATFORM_CONFIG;
  const obj = data as Record<string, unknown>;
  const pickNum = (key: keyof PlatformConfig, fallback: number): number => {
    const value = obj[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };
  const pickStr = (key: keyof PlatformConfig, fallback: string): string => {
    const value = obj[key];
    return typeof value === "string" && value ? value : fallback;
  };
  return {
    currency: pickStr("currency", FALLBACK_PLATFORM_CONFIG.currency),
    symbol: pickStr("symbol", FALLBACK_PLATFORM_CONFIG.symbol),
    minRedemption: pickNum(
      "minRedemption",
      FALLBACK_PLATFORM_CONFIG.minRedemption,
    ),
    minWaitSeconds: pickNum(
      "minWaitSeconds",
      FALLBACK_PLATFORM_CONFIG.minWaitSeconds,
    ),
    userRevenueShareBps: pickNum(
      "userRevenueShareBps",
      FALLBACK_PLATFORM_CONFIG.userRevenueShareBps,
    ),
    omniRevenueShareBps: pickNum(
      "omniRevenueShareBps",
      FALLBACK_PLATFORM_CONFIG.omniRevenueShareBps,
    ),
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

function sendBackgroundMessage(
  message: BackgroundMessage,
): Promise<BackgroundResponse> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(
        message,
        (response: BackgroundResponse | undefined) => {
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
        },
      );
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
  const [sponsoredWaitsEnabled, setSponsoredWaitsEnabled] = useState(true);
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
  const [platformConfig, setPlatformConfig] = useState<PlatformConfig>(
    FALLBACK_PLATFORM_CONFIG,
  );
  const [showInfo, setShowInfo] = useState(false);
  const balanceSourceRef = useRef(balanceSource);
  balanceSourceRef.current = balanceSource;

  useEffect(() => {
    chrome.storage.local.get(
      [
        STORAGE_KEYS.earnings,
        STORAGE_KEYS.userId,
        STORAGE_KEYS.sponsoredWaitsEnabled,
        "behavioralLayer",
      ],
      (result) => {
        setEarnings(Number(result[STORAGE_KEYS.earnings] ?? 0));
        const userId = result[STORAGE_KEYS.userId];
        setUserIdPrefix(typeof userId === "string" ? userId.slice(0, 8) : null);
        if (
          Object.prototype.hasOwnProperty.call(
            result,
            STORAGE_KEYS.sponsoredWaitsEnabled,
          )
        ) {
          setSponsoredWaitsEnabled(
            result[STORAGE_KEYS.sponsoredWaitsEnabled] !== false,
          );
        } else {
          setSponsoredWaitsEnabled(result.behavioralLayer !== false);
        }
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
          setPlatformConfig(parsePlatformConfig(configResponse.data));
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
        const redemptionsResponse = await sendBackgroundMessage({
          type: "GET_REDEMPTIONS",
        });
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

      if (changes[STORAGE_KEYS.sponsoredWaitsEnabled]) {
        setSponsoredWaitsEnabled(
          changes[STORAGE_KEYS.sponsoredWaitsEnabled].newValue !== false,
        );
      }
    };

    chrome.storage.onChanged.addListener(onStorageChange);
    return () => chrome.storage.onChanged.removeListener(onStorageChange);
  }, []);

  const handleSponsoredToggle = useCallback((next: boolean) => {
    setSponsoredWaitsEnabled(next);
    chrome.storage.local.set({ [STORAGE_KEYS.sponsoredWaitsEnabled]: next });
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

  const userPct = Math.floor(platformConfig.userRevenueShareBps / 100);

  return (
    <div className="min-h-[420px] bg-omni-bg p-5 text-white">
      <header className="mb-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
              OmniPiggy
            </p>
            <h1 className="mt-1 text-lg font-semibold text-white">
              AI Wait-Time Earnings
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
                {bankOnline ? "API online" : "API offline"}
              </span>
            </div>
          )}
        </div>
      </header>

      <section className="mb-6 rounded-2xl border border-omni-border bg-omni-surface p-5">
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
          Total Earned
        </p>
        <p
          className={`mt-2 text-4xl font-bold tabular-nums text-omni-neon ${
            loaded ? "animate-pulse-glow shadow-neon" : "opacity-50"
          }`}
          style={{ textShadow: "0 0 16px rgba(57, 255, 136, 0.45)" }}
        >
          {formatMoney(platformConfig.symbol, earnings)}
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          {balanceSource === "api"
            ? "Live wallet from Omni ledger"
            : "Cached balance from local storage"}
        </p>

        {pendingRedemption ? (
          <div className="mt-4 rounded-lg border border-omni-border bg-omni-bg px-3 py-2.5">
            <p className="text-xs font-medium text-amber-400">
              Redemption pending —{" "}
              {formatMoney(platformConfig.symbol, pendingRedemption.amount)} via{" "}
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
        ) : earnings >= platformConfig.minRedemption ? (
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
            Redeem from{" "}
            {formatMoney(platformConfig.symbol, platformConfig.minRedemption)}
          </p>
        )}
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Sponsored Waits
        </h2>
        <ToggleSwitch
          enabled={sponsoredWaitsEnabled}
          label="Sponsored Waits"
          description="Show sponsored content while supported AI services generate responses."
          onChange={handleSponsoredToggle}
        />
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Supported Platforms
        </h2>
        <p className="text-xs leading-relaxed text-zinc-400">
          {SUPPORTED_PLATFORMS.join(" · ")}
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Recent Earnings
        </h2>
        <div className="max-h-40 overflow-y-auto rounded-xl border border-omni-border bg-omni-surface">
          {transactionsLoading ? (
            <p className="px-4 py-6 text-center text-xs text-zinc-500">
              Loading activity…
            </p>
          ) : transactionsOffline ? (
            <p className="px-4 py-6 text-center text-xs text-zinc-500">
              API offline
            </p>
          ) : transactions.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-zinc-500">
              No settled sponsored earnings yet
            </p>
          ) : (
            <ul className="divide-y divide-omni-border">
              {transactions.map((tx) => (
                <li
                  key={tx.id}
                  className="flex items-center justify-between gap-3 px-4 py-2.5"
                >
                  <span className="min-w-0 truncate text-xs text-zinc-300">
                    Sponsored Wait
                  </span>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-xs font-semibold tabular-nums text-omni-neon">
                      +{formatMoney(platformConfig.symbol, tx.amount)}
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
          onClick={() => setShowInfo((open) => !open)}
          className="text-[10px] text-zinc-500 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-400"
        >
          How earnings work
        </button>
        {showInfo && (
          <p className="mt-2 px-1 text-left text-[10px] leading-relaxed text-zinc-500">
            Omni shows sponsored content while supported AI services generate
            responses. When an advertiser-funded wait qualifies, {userPct}% of
            that qualifying ad revenue is added to your wallet. There is no
            claim button and no fixed reward. Omni never reads your
            conversations — it only detects when the AI is loading. Redeem from{" "}
            {formatMoney(platformConfig.symbol, platformConfig.minRedemption)}{" "}
            via Amazon Pay voucher or UPI.
          </p>
        )}
        <p className="mt-2 text-[10px] font-mono tracking-wide text-zinc-600">
          ID: {userIdPrefix ?? "…"}
        </p>
      </footer>
    </div>
  );
}
