import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { api, supabase } from "./api";

type Me = {
  actor: { profileId: string; email: string; isAdmin: boolean };
  org: { organizationId: string; advertiserId: string; memberRole: string } | null;
  onboarded: boolean;
};

type AuthState = {
  session: Session | null;
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

const Ctx = createContext<AuthState>({
  session: null,
  me: null,
  loading: true,
  refresh: async () => undefined,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const current = (await supabase.auth.getSession()).data.session;
    setSession(current);
    if (!current) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      const res = await api<{ data: Me }>("/api/ads/me", current);
      setMe(res.data);
    } catch {
      setMe(null);
    }
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
    const { data } = supabase.auth.onAuthStateChange(() => {
      void refresh();
    });
    return () => data.subscription.unsubscribe();
  }, []);

  return <Ctx.Provider value={{ session, me, loading, refresh }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  return useContext(Ctx);
}
