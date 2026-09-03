import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

type Camp = { id: string; name: string };

export function CreativesPage() {
  const { session } = useAuth();
  const [campaigns, setCampaigns] = useState<Camp[]>([]);
  useEffect(() => {
    api<{ data: { campaigns: Camp[] } }>("/api/ads/campaigns", session).then((r) => setCampaigns(r.data.campaigns));
  }, [session]);
  return (
    <div>
      <h1 className="text-4xl font-semibold">Creatives</h1>
      {campaigns.length === 0 ? (
        <p className="mt-6 text-sm text-ink/60">No creatives yet. Create your first campaign to add one.</p>
      ) : (
        <ul className="mt-8 divide-y divide-[var(--line)]">
          {campaigns.map((c) => (
            <li key={c.id} className="py-3">
              <Link to={`/ads/campaigns/${c.id}`}>{c.name}</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { me } = useAuth();
  return (
    <div className="max-w-lg">
      <h1 className="text-4xl font-semibold">Settings</h1>
      <p className="mt-4 text-sm">Signed in as {me?.actor.email || "unknown"}</p>
      <p className="mt-2 text-sm text-ink/60">Role {me?.org?.memberRole ?? "none"} · org {me?.org?.organizationId ?? "not created"}</p>
    </div>
  );
}
