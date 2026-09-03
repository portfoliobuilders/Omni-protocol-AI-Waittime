import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { SponsoredWaitPreview } from "../components/Preview";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatCpm, formatInrFromMicropaise, formatPct } from "../lib/money";

type Payload = {
  campaign: {
    id: string;
    name: string;
    status: string;
    reviewStatus: string | null;
    reviewNotes: string | null;
    cpmMicropaise: number;
    budgetMicropaise: number;
    spentMicropaise: number;
    remainingMicropaise: number;
    startsAt: string | null;
    endsAt: string | null;
    targetingMode: string;
    surfaces: string[];
    creative: {
      advertiserName: string;
      headline: string;
      body: string;
      ctaLabel: string;
      logoUrl: string | null;
    } | null;
    activity: Array<{ id: string; action: string; created_at: string }>;
  };
  analytics: {
    totals: {
      qualifiedImpressions: number;
      verifiedAttentionSeconds: number;
      clicks: number;
      ctr: number;
    };
    bySurface: Array<{ surface: string; qualifiedImpressions: number; clicks: number; spendMicropaise: number }>;
  };
};

export function CampaignDetailPage() {
  const { id } = useParams();
  const { session } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");

  const reload = () => {
    if (!id) return;
    api<{ data: Payload }>(`/api/ads/campaigns/${id}`, session)
      .then((r) => setData(r.data))
      .catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    reload();
  }, [id, session]);

  if (error) return <p>{error}</p>;
  if (!data) return <p className="text-ink/50">Loading…</p>;
  const c = data.campaign;

  async function act(path: string) {
    await api(`/api/ads/campaigns/${c.id}/${path}`, session, { method: "POST", body: "{}" });
    reload();
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[1.2fr_0.8fr]">
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-moss">{c.status} · {c.reviewStatus || "unreviewed"}</p>
        <h1 className="mt-2 text-4xl font-semibold">{c.name}</h1>
        {c.reviewNotes ? <p className="mt-2 text-sm text-ink/60">{c.reviewNotes}</p> : null}
        <div className="mt-8 grid gap-3 text-sm md:grid-cols-2">
          <p>CPM {formatCpm(c.cpmMicropaise)}</p>
          <p>Budget {formatInrFromMicropaise(c.budgetMicropaise)}</p>
          <p>Spend {formatInrFromMicropaise(c.spentMicropaise)}</p>
          <p>Remaining {formatInrFromMicropaise(c.remainingMicropaise)}</p>
          <p>Inventory {c.targetingMode === "all_enabled" ? "all enabled" : c.surfaces.join(", ") || "none"}</p>
          <p>Dates {c.startsAt || "open"} → {c.endsAt || "open"}</p>
        </div>
        <div className="mt-6 flex gap-3">
          {c.status === "active" ? (
            <button type="button" className="bg-ink px-4 py-2 text-sm text-white" onClick={() => void act("pause")}>
              Pause
            </button>
          ) : null}
          {c.status === "paused" ? (
            <button type="button" className="bg-ink px-4 py-2 text-sm text-white" onClick={() => void act("resume")}>
              Resume
            </button>
          ) : null}
          {c.status === "draft" || c.status === "rejected" ? (
            <button type="button" className="bg-ink px-4 py-2 text-sm text-white" onClick={() => void act("submit")}>
              Submit for review
            </button>
          ) : null}
        </div>
        <h2 className="mt-12 text-xl">Verified attention</h2>
        <p className="mt-2 text-sm text-ink/70">
          {data.analytics.totals.qualifiedImpressions} qualified · {data.analytics.totals.verifiedAttentionSeconds}s · {data.analytics.totals.clicks} clicks · CTR {formatPct(data.analytics.totals.ctr)}
        </p>
        {data.analytics.bySurface.length === 0 ? (
          <p className="mt-4 text-sm text-ink/50">No surface analytics yet.</p>
        ) : (
          <ul className="mt-4 space-y-2 text-sm">
            {data.analytics.bySurface.map((s) => (
              <li key={s.surface}>{s.surface}: {s.qualifiedImpressions} qualified · {s.clicks} clicks</li>
            ))}
          </ul>
        )}
        <h2 className="mt-12 text-xl">Activity</h2>
        <ul className="mt-3 space-y-2 text-sm text-ink/70">
          {c.activity.map((a) => (
            <li key={a.id}>{a.action} · {new Date(a.created_at).toLocaleString()}</li>
          ))}
        </ul>
      </div>
      {c.creative ? (
        <SponsoredWaitPreview
          creative={{
            advertiserName: c.creative.advertiserName || "",
            headline: c.creative.headline,
            body: c.creative.body || "",
            ctaLabel: c.creative.ctaLabel || "Learn more",
            logoUrl: c.creative.logoUrl,
          }}
        />
      ) : null}
    </div>
  );
}
