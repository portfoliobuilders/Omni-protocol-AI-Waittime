import { useCallback, useEffect, useState } from "react";
import { formatMicropaiseDisplay, micropaiseToRupees } from "../shared/format";
import type { BackgroundMessage } from "../shared/messages";
import type { ExchangeWallet, OmniConfig, PlatformStatus } from "../shared/types";

const STORAGE_KEYS = {
  userId: "omniUserId",
  sponsoredWaitsEnabled: "sponsoredWaitsEnabled",
} as const;

type BackgroundResponse =
  | { ok: true; data: unknown; status?: number }
  | { ok: false; error: string; status?: number };

type RedemptionMethod = "amazon_voucher" | "upi";

type Redemption = {
  id: string;
  amount_micropaise: number;
  method: string;
  status: string;
  created_at: string;
};

type RecentEarning = {
  id: string;
  entryType: string;
  amountMicropaise: number;
  platform: string | null;
  createdAt: string;
};

function sendMessage(message: BackgroundMessage): Promise<BackgroundResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: BackgroundResponse) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else if (!response) reject(new Error("No response"));
      else resolve(response);
    });
  });
}

function formatRelativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return "Just now";
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        onClick={() => onChange(!enabled)}
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
          enabled ? "bg-omni-neonDim" : "bg-zinc-700"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
            enabled ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

export default function App() {
  const [wallet, setWallet] = useState<ExchangeWallet | null>(null);
  const [earnings, setEarnings] = useState<RecentEarning[]>([]);
  const [platforms, setPlatforms] = useState<PlatformStatus[]>([]);
  const [config, setConfig] = useState<OmniConfig["platform"] | null>(null);
  const [sponsoredWaitsEnabled, setSponsoredWaitsEnabled] = useState(true);
  const [bankOnline, setBankOnline] = useState<boolean | null>(null);
  const [userIdPrefix, setUserIdPrefix] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showRedeem, setShowRedeem] = useState(false);
  const [redeemMethod, setRedeemMethod] = useState<RedemptionMethod>("amazon_voucher");
  const [redeemDetail, setRedeemDetail] = useState("");
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeemSubmitting, setRedeemSubmitting] = useState(false);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);

  const symbol = config?.symbol ?? "₹";
  const minRedemption = config?.minRedemption ?? 100;
  const userPct = Math.floor((config?.userRevenueShareBps ?? 6000) / 100);
  const available = wallet?.availableRupeesDisplay ?? 0;
  const pending = wallet ? micropaiseToRupees(wallet.pendingMicropaise) : 0;
  const lifetime = wallet ? micropaiseToRupees(wallet.lifetimeEarnedMicropaise) : 0;

  useEffect(() => {
    chrome.storage.local.get(
      [STORAGE_KEYS.userId, STORAGE_KEYS.sponsoredWaitsEnabled],
      (r) => {
        const uid = r[STORAGE_KEYS.userId];
        setUserIdPrefix(typeof uid === "string" ? uid.slice(0, 8) : null);
        setSponsoredWaitsEnabled(r[STORAGE_KEYS.sponsoredWaitsEnabled] !== false);
      },
    );

    void (async () => {
      try {
        const cfgRes = await sendMessage({ type: "GET_OMNI_CONFIG" });
        if (cfgRes.ok) {
          const root = cfgRes.data as { success?: boolean; data?: OmniConfig };
          const data = root.data ?? (cfgRes.data as OmniConfig);
          if (data.platform) setConfig(data.platform);
          if (data.platforms) setPlatforms(data.platforms);
        }
      } catch {
        /* fallback */
      }

      try {
        const wRes = await sendMessage({ type: "GET_EXCHANGE_WALLET" });
        if (wRes.ok) {
          const root = wRes.data as { success?: boolean; data?: ExchangeWallet };
          setWallet(root.data ?? null);
          setBankOnline(true);
        }
      } catch {
        setBankOnline(false);
      }

      try {
        const eRes = await sendMessage({ type: "GET_RECENT_EARNINGS", payload: { limit: 8 } });
        if (eRes.ok) {
          const root = eRes.data as {
            success?: boolean;
            data?: { earnings: RecentEarning[] };
          };
          setEarnings(root.data?.earnings ?? []);
        }
      } catch {
        /* offline */
      }

      if (bankOnline === null) {
        try {
          const h = await sendMessage({ type: "GET_HEALTH" });
          setBankOnline(h.ok);
        } catch {
          setBankOnline(false);
        }
      }

      try {
        const rRes = await sendMessage({ type: "GET_REDEMPTIONS" });
        if (rRes.ok) {
          const root = rRes.data as { data?: { redemptions: Redemption[] } };
          setRedemptions(root.data?.redemptions ?? []);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const handleToggle = useCallback((next: boolean) => {
    setSponsoredWaitsEnabled(next);
    chrome.storage.local.set({ [STORAGE_KEYS.sponsoredWaitsEnabled]: next });
  }, []);

  const handleRedeem = useCallback(async () => {
    const detail = redeemDetail.trim();
    if (!detail) {
      setRedeemError("Enter your email or UPI ID.");
      return;
    }
    setRedeemSubmitting(true);
    setRedeemError(null);
    try {
      const res = await sendMessage({
        type: "REDEEM",
        payload: { method: redeemMethod, detail },
      });
      if (!res.ok) throw new Error(res.error);
      setShowRedeem(false);
      const wRes = await sendMessage({ type: "GET_EXCHANGE_WALLET" });
      if (wRes.ok) {
        const root = wRes.data as { data?: ExchangeWallet };
        setWallet(root.data ?? null);
      }
    } catch (e) {
      setRedeemError(e instanceof Error ? e.message : "Redemption failed.");
    } finally {
      setRedeemSubmitting(false);
    }
  }, [redeemDetail, redeemMethod]);

  const pendingRedemption = redemptions.find((r) => r.status === "requested");

  return (
    <div className="min-h-[480px] bg-omni-bg p-5 text-white">
      <header className="mb-5 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
            OmniPiggy
          </p>
          <h1 className="mt-1 text-lg font-semibold">AI Attention Earnings</h1>
        </div>
        {bankOnline !== null && (
          <span className="rounded-full border border-omni-border px-2 py-1 text-[10px] text-zinc-400">
            {bankOnline ? "Online" : "Offline"}
          </span>
        )}
      </header>

      <section className="mb-5 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-omni-border bg-omni-surface p-3">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">Available</p>
          <p className="mt-1 text-xl font-bold tabular-nums text-omni-neon">
            {symbol}
            {available % 1 === 0 ? available.toFixed(0) : available.toFixed(4)}
          </p>
        </div>
        {pending > 0 ? (
          <div className="rounded-xl border border-omni-border bg-omni-surface p-3">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">Pending</p>
            <p className="mt-1 text-xl font-bold tabular-nums text-zinc-300">
              {symbol}
              {pending.toFixed(2)}
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-omni-border bg-omni-surface p-3">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">Lifetime</p>
            <p className="mt-1 text-xl font-bold tabular-nums text-zinc-300">
              {symbol}
              {lifetime % 1 === 0 ? lifetime.toFixed(0) : lifetime.toFixed(2)}
            </p>
          </div>
        )}
      </section>

      <section className="mb-5">
        <ToggleSwitch
          enabled={sponsoredWaitsEnabled}
          label="Sponsored Waits"
          description="Clearly labelled sponsored content during supported AI wait time."
          onChange={handleToggle}
        />
      </section>

      <section className="mb-5">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Recent Revenue
        </h2>
        <div className="max-h-36 overflow-y-auto rounded-xl border border-omni-border bg-omni-surface">
          {earnings.length === 0 ? (
            <p className="px-4 py-5 text-center text-xs text-zinc-500">
              No settled sponsored earnings yet
            </p>
          ) : (
            <ul className="divide-y divide-omni-border">
              {earnings.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center justify-between px-4 py-2.5 text-xs"
                >
                  <span className="text-zinc-300">Sponsored Wait</span>
                  <span className="font-semibold text-omni-neon">
                    +{formatMicropaiseDisplay(e.amountMicropaise, symbol)}
                  </span>
                  <span className="text-[10px] text-zinc-500">
                    {formatRelativeTime(e.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="mb-5">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Supported AI Platforms
        </h2>
        <ul className="flex flex-wrap gap-2">
          {(platforms.length
            ? platforms
            : [{ id: "x", name: "Loading…", enabled: true, sponsoredWaitEnabled: true, hosts: [] }]
          ).map((p) => (
            <li
              key={p.id}
              className={`rounded-md border px-2 py-1 text-[10px] ${
                p.enabled && p.sponsoredWaitEnabled
                  ? "border-omni-neonDim/40 text-omni-neon"
                  : "border-zinc-700 text-zinc-500"
              }`}
            >
              {p.name} {p.enabled && p.sponsoredWaitEnabled ? "✓" : "—"}
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-4">
        {pendingRedemption ? (
          <p className="text-xs text-amber-400">Redemption pending review</p>
        ) : available >= minRedemption ? (
          !showRedeem ? (
            <button
              type="button"
              onClick={() => setShowRedeem(true)}
              className="rounded-lg border border-omni-neonDim px-4 py-2 text-xs font-semibold text-omni-neon"
            >
              Redeem
            </button>
          ) : (
            <div className="rounded-lg border border-omni-border bg-omni-surface p-3">
              <div className="mb-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setRedeemMethod("amazon_voucher")}
                  className={`flex-1 rounded px-2 py-1 text-[10px] ${
                    redeemMethod === "amazon_voucher"
                      ? "bg-omni-neonDim/20 text-omni-neon"
                      : "text-zinc-400"
                  }`}
                >
                  Amazon
                </button>
                <button
                  type="button"
                  onClick={() => setRedeemMethod("upi")}
                  className={`flex-1 rounded px-2 py-1 text-[10px] ${
                    redeemMethod === "upi"
                      ? "bg-omni-neonDim/20 text-omni-neon"
                      : "text-zinc-400"
                  }`}
                >
                  UPI
                </button>
              </div>
              <input
                value={redeemDetail}
                onChange={(e) => setRedeemDetail(e.target.value)}
                placeholder={redeemMethod === "upi" ? "UPI ID" : "Email"}
                className="mb-2 w-full rounded border border-omni-border bg-omni-bg px-3 py-2 text-xs"
              />
              {redeemError && (
                <p className="mb-2 text-[11px] text-red-400">{redeemError}</p>
              )}
              <button
                type="button"
                disabled={redeemSubmitting}
                onClick={() => void handleRedeem()}
                className="rounded bg-omni-neonDim px-3 py-1.5 text-xs font-semibold text-omni-bg"
              >
                {redeemSubmitting ? "Submitting…" : "Submit redemption"}
              </button>
            </div>
          )
        ) : (
          <p className="text-[11px] text-zinc-600">
            Redeem from {symbol}
            {minRedemption} available balance
          </p>
        )}
      </section>

      <footer className="border-t border-omni-border pt-3">
        <button
          type="button"
          onClick={() => setShowInfo((o) => !o)}
          className="text-[10px] text-zinc-500 underline"
        >
          Privacy / How it works
        </button>
        {showInfo && (
          <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">
            Omni displays clearly labelled sponsored content while supported AI
            services generate responses. When an eligible advertiser-funded
            impression qualifies, {userPct}% of that direct ad revenue is credited
            to your Omni wallet. Omni does not read your conversations to choose
            ads — only platform inventory context is used.
          </p>
        )}
        <p className="mt-2 font-mono text-[10px] text-zinc-600">
          ID: {userIdPrefix ?? "…"}
        </p>
      </footer>
    </div>
  );
}
