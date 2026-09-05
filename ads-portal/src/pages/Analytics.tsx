import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatInrFromMicropaise, formatPct } from "../lib/money";

type Analytics = {
  totals: {
    qualifiedImpressions: number;
    verifiedAttentionSeconds: number;
    averageVerifiedAttentionSeconds: number;
    clicks: number;
    ctr: number;
    spendMicropaise: number;
    qualificationRate: number;
  };
  bySurface: Array<{ surface: string; qualifiedImpressions: number; verifiedAttentionSeconds: number; clicks: number; ctr: number }>;
  byCreative: Array<{ creativeId: string; impressions: number; qualifiedImpressions: number; clicks: number; ctr: number }>;
};

export function AnalyticsPage() {
  const { session } = useAuth();
  const [data, setData] = useState<Analytics | null>(null);
  useEffect(() => {
    api<{ data: Analytics }>("/api/ads/analytics", session).then((r) => setData(r.data));
  }, [session]);
  if (!data) return <p className="text-ink/50">Loading…</p>;
  if (data.totals.qualifiedImpressions === 0 && data.totals.clicks === 0) {
    return (
      <div>
        <h1 className="text-4xl font-semibold">Analytics</h1>
        <p className="mt-4 max-w-md text-sm text-ink/60">No settled events yet. Spend, impressions, and qualification rates appear from real Postgres rows — not demo data.</p>
      </div>
    );
  }
  return (
    <div>
      <h1 className="text-4xl font-semibold">Analytics</h1>
      <div className="mt-8 grid gap-4 text-sm md:grid-cols-2">
        <p>Qualified impressions {data.totals.qualifiedImpressions}</p>
        <p>Qualified view time {data.totals.verifiedAttentionSeconds}s (from reported view ms)</p>
        <p>Average {data.totals.averageVerifiedAttentionSeconds}s</p>
        <p>Clicks {data.totals.clicks} · CTR {formatPct(data.totals.ctr)}</p>
        <p>Spend {formatInrFromMicropaise(data.totals.spendMicropaise)}</p>
        <p>Qualification rate {formatPct(data.totals.qualificationRate)}</p>
      </div>
      <h2 className="mt-12 text-xl">By surface</h2>
      <ul className="mt-3 space-y-2 text-sm">
        {data.bySurface.map((s) => (
          <li key={s.surface}>{s.surface}: {s.qualifiedImpressions} · {s.verifiedAttentionSeconds}s · CTR {formatPct(s.ctr)}</li>
        ))}
      </ul>
      <h2 className="mt-12 text-xl">By creative</h2>
      <ul className="mt-3 space-y-2 text-sm">
        {data.byCreative.map((c) => (
          <li key={c.creativeId}>{c.creativeId.slice(0, 8)}: {c.qualifiedImpressions} qualified · {c.clicks} clicks</li>
        ))}
      </ul>
    </div>
  );
}
