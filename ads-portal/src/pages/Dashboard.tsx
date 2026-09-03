import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatInrFromMicropaise, formatPct } from "../lib/money";

type Dash = {
  billing: { availableMicropaise: number; lifetimeSpentMicropaise: number };
  analytics: {
    qualifiedImpressions: number;
    verifiedAttentionSeconds: number;
    averageVerifiedAttentionSeconds: number;
    clicks: number;
    ctr: number;
  };
  bySurface: Array<{ surface: string; qualifiedImpressions: number }>;
  campaigns: unknown[];
};

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-[var(--line)] py-4">
      <p className="text-xs uppercase tracking-[0.14em] text-ink/50">{label}</p>
      <p className="mt-1 text-2xl font-medium">{value}</p>
    </div>
  );
}

export function DashboardPage() {
  const { session } = useAuth();
  const [data, setData] = useState<Dash | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ data: Dash }>("/api/ads/dashboard", session)
      .then((r) => setData(r.data))
      .catch((e: Error) => setError(e.message));
  }, [session]);

  if (error) return <p>{error}</p>;
  if (!data) return <p className="text-ink/50">Loading…</p>;
  const empty = (data.campaigns?.length ?? 0) === 0 && data.analytics.qualifiedImpressions === 0;

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-semibold">Overview</h1>
          <p className="mt-1 text-sm text-ink/60">Spend, remaining budget, and verified attention from Postgres.</p>
        </div>
        <Link to="/ads/campaigns/new" className="bg-ink px-4 py-2 text-sm text-white">
          Create campaign
        </Link>
      </div>
      {empty ? (
        <div className="mt-16 max-w-lg">
          <h2 className="text-2xl">No campaigns yet</h2>
          <p className="mt-2 text-sm text-ink/60">Create your first campaign to buy verified AI wait-time attention. Sample numbers are never shown.</p>
          <Link to="/ads/campaigns/new" className="mt-6 inline-block bg-ink px-4 py-2 text-sm text-white">
            Create your first campaign
          </Link>
        </div>
      ) : (
        <div className="mt-10 grid gap-x-12 md:grid-cols-2">
          <Card label="Spend" value={formatInrFromMicropaise(data.billing.lifetimeSpentMicropaise)} />
          <Card label="Available balance" value={formatInrFromMicropaise(data.billing.availableMicropaise)} />
          <Card label="Qualified impressions" value={String(data.analytics.qualifiedImpressions)} />
          <Card label="Verified attention" value={`${data.analytics.verifiedAttentionSeconds}s`} />
          <Card label="Avg verified attention" value={`${data.analytics.averageVerifiedAttentionSeconds}s`} />
          <Card label="Clicks" value={String(data.analytics.clicks)} />
          <Card label="CTR" value={formatPct(data.analytics.ctr)} />
          <div className="border-b border-[var(--line)] py-4">
            <p className="text-xs uppercase tracking-[0.14em] text-ink/50">Best surface</p>
            <p className="mt-1 text-2xl font-medium">
              {data.bySurface[0]?.surface ?? "No surface data yet"}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
