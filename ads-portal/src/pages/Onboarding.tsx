import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

export function OnboardingPage() {
  const { session, refresh } = useAuth();
  const navigate = useNavigate();
  const [companyName, setCompanyName] = useState("");
  const [error, setError] = useState("");

  return (
    <div className="mx-auto max-w-lg py-16">
      <p className="text-xs uppercase tracking-[0.18em] text-moss">Omni Ads</p>
      <h1 className="mt-3 text-4xl font-semibold">Create your company</h1>
      <p className="mt-2 text-sm text-ink/70">One owner now. Teams (admin, analyst) can join later without a schema rewrite.</p>
      <form
        className="mt-8 space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await api("/api/ads/onboarding", session, {
              method: "POST",
              body: JSON.stringify({ companyName }),
            });
            await refresh();
            navigate("/ads/dashboard");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not create company");
          }
        }}
      >
        <input
          required
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          placeholder="Company name"
          className="w-full border border-[var(--line)] bg-white/70 px-4 py-3"
        />
        {error ? <p className="text-sm text-red-800">{error}</p> : null}
        <button type="submit" className="bg-ink px-5 py-3 text-sm text-white">
          Continue
        </button>
      </form>
    </div>
  );
}
