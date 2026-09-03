import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { supabase } from "../lib/api";
import { useAuth } from "../lib/auth";

const LINKS = [
  ["/ads/dashboard", "Overview"],
  ["/ads/campaigns", "Campaigns"],
  ["/ads/creatives", "Creatives"],
  ["/ads/analytics", "Analytics"],
  ["/ads/billing", "Billing"],
  ["/ads/settings", "Settings"],
];

export function AppShell() {
  const { me } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-[var(--line)] bg-[#f7fbfb]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <button type="button" className="text-left" onClick={() => navigate("/ads/dashboard")}>
            <p className="text-xs uppercase tracking-[0.18em] text-moss">Omni Ads</p>
            <p className="text-sm text-ink/70">AI Attention Network</p>
          </button>
          <nav className="hidden gap-4 md:flex">
            {LINKS.map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `text-sm ${isActive ? "text-moss" : "text-ink/60 hover:text-ink"}`
                }
              >
                {label}
              </NavLink>
            ))}
            {me?.actor.isAdmin ? (
              <NavLink to="/ads/admin" className="text-sm text-ink/60 hover:text-ink">
                Admin
              </NavLink>
            ) : null}
          </nav>
          <button
            type="button"
            className="text-sm text-ink/60"
            onClick={() => {
              void supabase.auth.signOut().then(() => navigate("/ads/login"));
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
