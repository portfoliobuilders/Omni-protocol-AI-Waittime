import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatInrFromMicropaise } from "../lib/money";

type Queue = {
  campaigns: Array<{ id: string; name: string; status: string; review_status: string; spent_micropaise: number }>;
  funding: Array<{ id: string; amount_micropaise: number; status: string }>;
  advertisers: Array<{ id: string; name: string; status: string }>;
  health: {
    activeCampaigns: number;
    pendingReview: number;
    pendingFunding: number;
    paidInventoryEnabled?: boolean;
    liveSurfaces: string[];
  };
};

export function AdminPage() {
  const { session, me } = useAuth();
  const [data, setData] = useState<Queue | null>(null);
  const [notes, setNotes] = useState("");

  const load = () => {
    api<{ data: Queue }>("/api/ads/admin/queue", session).then((r) => setData(r.data));
  };
  useEffect(() => {
    load();
  }, [session]);

  if (!me?.actor.isAdmin) return <p>Admin only.</p>;
  if (!data) return <p className="text-ink/50">Loading…</p>;

  return (
    <div>
      <h1 className="text-4xl font-semibold">Admin</h1>
      <p className="mt-2 text-sm text-ink/60">
        {data.health.activeCampaigns} active · {data.health.pendingReview} pending review · live {data.health.liveSurfaces.join(", ") || "none"}
      </p>
      <p className="mt-2 text-sm">
        Paid inventory is {data.health.paidInventoryEnabled === false ? "OFF (house only)" : "ON"}.
        {" "}
        <button
          type="button"
          className="underline"
          onClick={() => {
            void api("/api/ads/admin/paid-inventory", session, {
              method: "POST",
              body: JSON.stringify({ enabled: data.health.paidInventoryEnabled === false }),
            }).then(load);
          }}
        >
          {data.health.paidInventoryEnabled === false ? "Enable paid inventory" : "Kill paid inventory"}
        </button>
      </p>
      <label className="mt-6 block text-sm">
        Review notes
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 w-full border border-[var(--line)] bg-white/70 px-3 py-2" />
      </label>
      <h2 className="mt-10 text-xl">Campaign review</h2>
      <ul className="mt-3 space-y-3 text-sm">
        {data.campaigns.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] py-2">
            <span>{c.name} · {c.status}/{c.review_status} · {formatInrFromMicropaise(c.spent_micropaise)}</span>
            <span className="flex gap-2">
              {(["approve", "reject", "request_changes", "emergency_pause"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className="underline"
                  onClick={() => {
                    void api(`/api/ads/admin/campaigns/${c.id}/review`, session, {
                      method: "POST",
                      body: JSON.stringify({ decision: d, notes }),
                    }).then(load);
                  }}
                >
                  {d.replace("_", " ")}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <h2 className="mt-10 text-xl">Funding</h2>
      <ul className="mt-3 space-y-3 text-sm">
        {data.funding.map((f) => (
          <li key={f.id} className="flex justify-between gap-2">
            <span>{f.status} · {formatInrFromMicropaise(f.amount_micropaise)}</span>
            {f.status === "pending" ? (
              <span className="flex gap-2">
                <button type="button" className="underline" onClick={() => void api(`/api/ads/admin/funding/${f.id}/resolve`, session, { method: "POST", body: JSON.stringify({ decision: "confirmed" }) }).then(load)}>confirm</button>
                <button type="button" className="underline" onClick={() => void api(`/api/ads/admin/funding/${f.id}/resolve`, session, { method: "POST", body: JSON.stringify({ decision: "rejected" }) }).then(load)}>reject</button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <h2 className="mt-10 text-xl">Advertisers</h2>
      <ul className="mt-3 space-y-2 text-sm">
        {data.advertisers.map((a) => (
          <li key={a.id}>{a.name} · {a.status}</li>
        ))}
      </ul>
    </div>
  );
}
