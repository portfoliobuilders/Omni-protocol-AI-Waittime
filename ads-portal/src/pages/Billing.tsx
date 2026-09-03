import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatInrFromMicropaise } from "../lib/money";

type Billing = {
  availableMicropaise: number;
  reservedMicropaise: number;
  lifetimeFundedMicropaise: number;
  lifetimeSpentMicropaise: number;
  transactions: Array<{ id: string; entry_type: string; amount_micropaise: number; created_at: string }>;
  fundingRequests: Array<{ id: string; amount_micropaise: number; status: string; created_at: string }>;
};

export function BillingPage() {
  const { session } = useAuth();
  const [data, setData] = useState<Billing | null>(null);
  const [rupees, setRupees] = useState(5000);
  const [msg, setMsg] = useState("");

  const load = () => {
    api<{ data: Billing }>("/api/ads/billing", session).then((r) => setData(r.data));
  };
  useEffect(() => {
    load();
  }, [session]);

  if (!data) return <p className="text-ink/50">Loading…</p>;
  return (
    <div className="max-w-2xl">
      <h1 className="text-4xl font-semibold">Billing</h1>
      <p className="mt-2 text-sm text-ink/60">Pilot funding is admin-confirmed. We do not fake a payment processor.</p>
      <dl className="mt-8 grid grid-cols-2 gap-4 text-sm">
        <div><dt className="text-ink/50">Available</dt><dd className="text-xl">{formatInrFromMicropaise(data.availableMicropaise)}</dd></div>
        <div><dt className="text-ink/50">Reserved</dt><dd className="text-xl">{formatInrFromMicropaise(data.reservedMicropaise)}</dd></div>
        <div><dt className="text-ink/50">Lifetime funded</dt><dd className="text-xl">{formatInrFromMicropaise(data.lifetimeFundedMicropaise)}</dd></div>
        <div><dt className="text-ink/50">Lifetime spent</dt><dd className="text-xl">{formatInrFromMicropaise(data.lifetimeSpentMicropaise)}</dd></div>
      </dl>
      <form
        className="mt-10 space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setMsg("");
          try {
            await api("/api/ads/funding", session, {
              method: "POST",
              body: JSON.stringify({ amountMicropaise: rupees * 100_000, notes: "pilot funding request" }),
            });
            setMsg("Request submitted — pending Omni confirmation.");
            load();
          } catch (err) {
            setMsg(err instanceof Error ? err.message : "Failed");
          }
        }}
      >
        <label className="block text-sm">
          Request pilot funding (₹)
          <input type="number" min={1} value={rupees} onChange={(e) => setRupees(Number(e.target.value))} className="mt-1 w-full border border-[var(--line)] bg-white/70 px-3 py-2" />
        </label>
        <button type="submit" className="bg-ink px-4 py-2 text-sm text-white">Request funding</button>
        {msg ? <p className="text-sm">{msg}</p> : null}
      </form>
      <h2 className="mt-12 text-xl">Funding requests</h2>
      {data.fundingRequests.length === 0 ? <p className="mt-2 text-sm text-ink/50">No funding yet.</p> : (
        <ul className="mt-3 space-y-2 text-sm">{data.fundingRequests.map((f) => <li key={f.id}>{f.status} · {formatInrFromMicropaise(f.amount_micropaise)}</li>)}</ul>
      )}
      <h2 className="mt-12 text-xl">Ledger</h2>
      {data.transactions.length === 0 ? <p className="mt-2 text-sm text-ink/50">No transactions.</p> : (
        <ul className="mt-3 space-y-2 text-sm">{data.transactions.map((t) => <li key={t.id}>{t.entry_type} · {formatInrFromMicropaise(t.amount_micropaise)}</li>)}</ul>
      )}
    </div>
  );
}
