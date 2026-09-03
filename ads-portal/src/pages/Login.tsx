import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/api";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <p className="text-xs uppercase tracking-[0.18em] text-moss">Omni Ads</p>
      <h1 className="mt-3 text-4xl font-semibold">Sign in</h1>
      <p className="mt-2 text-sm text-ink/70">We’ll email a magic link. No passwords in the URL, no admin keys.</p>
      {sent ? (
        <p className="mt-8 text-sm">Check {email} for the sign-in link.</p>
      ) : (
        <form
          className="mt-8 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            const { error: err } = await supabase.auth.signInWithOtp({
              email,
              options: { emailRedirectTo: `${window.location.origin}/ads/dashboard` },
            });
            if (err) setError(err.message);
            else setSent(true);
          }}
        >
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="w-full border border-[var(--line)] bg-white/70 px-4 py-3 outline-none"
          />
          {error ? <p className="text-sm text-red-800">{error}</p> : null}
          <button type="submit" className="w-full bg-ink px-4 py-3 text-sm text-white">
            Email magic link
          </button>
        </form>
      )}
      <Link to="/advertise" className="mt-8 text-sm text-ink/60">
        Back
      </Link>
    </div>
  );
}
