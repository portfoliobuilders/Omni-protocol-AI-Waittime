import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatCpm, formatInrFromMicropaise } from "../lib/money";

type Camp = {
  id: string;
  name: string;
  status: string;
  review_status: string | null;
  cpm_micropaise: number;
  total_budget_micropaise: number;
  spent_micropaise: number;
};

export function CampaignsPage() {
  const { session } = useAuth();
  const [campaigns, setCampaigns] = useState<Camp[] | null>(null);

  useEffect(() => {
    api<{ data: { campaigns: Camp[] } }>("/api/ads/campaigns", session)
      .then((r) => setCampaigns(r.data.campaigns))
      .catch(() => setCampaigns([]));
  }, [session]);

  if (!campaigns) return <p className="text-ink/50">Loading…</p>;
  return (
    <div>
      <div className="flex items-end justify-between">
        <h1 className="text-4xl font-semibold">Campaigns</h1>
        <Link to="/ads/campaigns/new" className="bg-ink px-4 py-2 text-sm text-white">
          Create campaign
        </Link>
      </div>
      {campaigns.length === 0 ? (
        <div className="mt-16">
          <h2 className="text-2xl">No campaigns</h2>
          <p className="mt-2 text-sm text-ink/60">Start with inventory, creative, and a rupee CPM. Settlement stays in micropaise.</p>
          <Link to="/ads/campaigns/new" className="mt-6 inline-block bg-ink px-4 py-2 text-sm text-white">
            Create your first campaign
          </Link>
        </div>
      ) : (
        <ul className="mt-10 divide-y divide-[var(--line)]">
          {campaigns.map((c) => (
            <li key={c.id} className="py-4">
              <Link to={`/ads/campaigns/${c.id}`} className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-lg">{c.name}</span>
                <span className="text-sm text-ink/50">
                  {c.status} · {formatCpm(c.cpm_micropaise)} · {formatInrFromMicropaise(c.spent_micropaise)} / {formatInrFromMicropaise(c.total_budget_micropaise)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
