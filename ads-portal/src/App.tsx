import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/Shell";
import { useAuth } from "./lib/auth";
import { AdminPage } from "./pages/Admin";
import { AdvertisePage } from "./pages/Advertise";
import { AnalyticsPage } from "./pages/Analytics";
import { BillingPage } from "./pages/Billing";
import { CampaignDetailPage } from "./pages/CampaignDetail";
import { CampaignNewPage } from "./pages/CampaignNew";
import { CampaignsPage } from "./pages/Campaigns";
import { CreativesPage, SettingsPage } from "./pages/Creatives";
import { DashboardPage } from "./pages/Dashboard";
import { LoginPage } from "./pages/Login";
import { OnboardingPage } from "./pages/Onboarding";

function OnboardGate() {
  const { session, me, loading } = useAuth();
  if (loading) return <p className="p-8 text-ink/50">Loading…</p>;
  if (!session) return <Navigate to="/ads/login" replace />;
  if (me?.onboarded) return <Navigate to="/ads/dashboard" replace />;
  return <OnboardingPage />;
}

function Guard({ children }: { children: ReactNode }) {
  const { session, me, loading } = useAuth();
  if (loading) return <p className="p-8 text-ink/50">Loading…</p>;
  if (!session) return <Navigate to="/ads/login" replace />;
  if (!me?.onboarded) return <Navigate to="/ads/onboarding" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/advertise" element={<AdvertisePage />} />
      <Route path="/ads/login" element={<LoginPage />} />
      <Route path="/ads/onboarding" element={<OnboardGate />} />
      <Route
        element={
          <Guard>
            <AppShell />
          </Guard>
        }
      >
        <Route path="/ads/dashboard" element={<DashboardPage />} />
        <Route path="/ads/campaigns" element={<CampaignsPage />} />
        <Route path="/ads/campaigns/new" element={<CampaignNewPage />} />
        <Route path="/ads/campaigns/:id" element={<CampaignDetailPage />} />
        <Route path="/ads/creatives" element={<CreativesPage />} />
        <Route path="/ads/billing" element={<BillingPage />} />
        <Route path="/ads/analytics" element={<AnalyticsPage />} />
        <Route path="/ads/settings" element={<SettingsPage />} />
        <Route path="/ads/admin" element={<AdminPage />} />
      </Route>
      <Route path="/" element={<Navigate to="/advertise" replace />} />
      <Route path="*" element={<Navigate to="/advertise" replace />} />
    </Routes>
  );
}
