-- OmniPiggy RLS foundation
-- Client roles: anon (deny financial writes), authenticated (own-row reads / limited writes).
-- Service role bypasses RLS — use only on the server / Edge Functions.
--
-- Anonymous auth note:
--   Extension installs may later use Supabase anonymous sign-in before account linking.
--   Until then, keep enable_anonymous_sign_ins = false and route privileged writes through
--   the Omni API (service role) or SECURITY DEFINER functions. Do not allow anon/authenticated
--   clients to INSERT/UPDATE ledger_entries, revenue_events, or advertiser_ledger_entries.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_advertiser_owner(p_advertiser_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.advertisers a
    WHERE a.id = p_advertiser_id
      AND a.profile_id = auth.uid()
  );
$$;

-- Enable RLS on all user-facing / financial tables
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE wait_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE advertisers ENABLE ROW LEVEL SECURITY;
ALTER TABLE advertiser_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE advertiser_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_surfaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE creatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE impressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE publishers ENABLE ROW LEVEL SECURITY;
ALTER TABLE publisher_revenue ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- profiles: select/update own row only
-- ---------------------------------------------------------------------------
CREATE POLICY profiles_select_own
  ON profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_admin());

CREATE POLICY profiles_update_own
  ON profiles FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- No client INSERT (created by trigger / service role on signup)
-- anon: no policies → deny

-- ---------------------------------------------------------------------------
-- wallets / ledger / revenue / redemptions: SELECT own only; no client mutations
-- ---------------------------------------------------------------------------
CREATE POLICY wallets_select_own
  ON wallets FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR public.is_admin());

CREATE POLICY ledger_entries_select_own
  ON ledger_entries FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR wallet_id IN (SELECT id FROM wallets WHERE profile_id = auth.uid())
  );

CREATE POLICY revenue_events_select_own
  ON revenue_events FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR impression_id IN (
      SELECT i.id
      FROM impressions i
      JOIN wait_sessions ws ON ws.id = i.wait_session_id
      WHERE ws.profile_id = auth.uid()
    )
  );

CREATE POLICY redemptions_select_own
  ON redemptions FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR public.is_admin());

-- Explicit deny note: no INSERT/UPDATE/DELETE policies for authenticated/anon on
-- wallets, ledger_entries, revenue_events → financial writes only via service role.

-- ---------------------------------------------------------------------------
-- advertisers / campaigns / creatives: manage own org
-- ---------------------------------------------------------------------------
CREATE POLICY advertisers_select_own
  ON advertisers FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR public.is_admin());

CREATE POLICY advertisers_update_own
  ON advertisers FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

CREATE POLICY advertisers_insert_own
  ON advertisers FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid());

CREATE POLICY advertiser_wallets_select_own
  ON advertiser_wallets FOR SELECT TO authenticated
  USING (public.is_advertiser_owner(advertiser_id) OR public.is_admin());

-- No client writes to advertiser_wallets / advertiser_ledger_entries
CREATE POLICY advertiser_ledger_select_own
  ON advertiser_ledger_entries FOR SELECT TO authenticated
  USING (public.is_advertiser_owner(advertiser_id) OR public.is_admin());

CREATE POLICY campaigns_select_own
  ON campaigns FOR SELECT TO authenticated
  USING (public.is_advertiser_owner(advertiser_id) OR public.is_admin());

CREATE POLICY campaigns_insert_own
  ON campaigns FOR INSERT TO authenticated
  WITH CHECK (public.is_advertiser_owner(advertiser_id));

CREATE POLICY campaigns_update_own
  ON campaigns FOR UPDATE TO authenticated
  USING (public.is_advertiser_owner(advertiser_id))
  WITH CHECK (public.is_advertiser_owner(advertiser_id));

CREATE POLICY campaign_surfaces_select_own
  ON campaign_surfaces FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR campaign_id IN (
      SELECT c.id FROM campaigns c
      JOIN advertisers a ON a.id = c.advertiser_id
      WHERE a.profile_id = auth.uid()
    )
  );

CREATE POLICY campaign_surfaces_mutate_own
  ON campaign_surfaces FOR ALL TO authenticated
  USING (
    campaign_id IN (
      SELECT c.id FROM campaigns c
      JOIN advertisers a ON a.id = c.advertiser_id
      WHERE a.profile_id = auth.uid()
    )
  )
  WITH CHECK (
    campaign_id IN (
      SELECT c.id FROM campaigns c
      JOIN advertisers a ON a.id = c.advertiser_id
      WHERE a.profile_id = auth.uid()
    )
  );

CREATE POLICY creatives_select_own
  ON creatives FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR campaign_id IN (
      SELECT c.id FROM campaigns c
      JOIN advertisers a ON a.id = c.advertiser_id
      WHERE a.profile_id = auth.uid()
    )
  );

CREATE POLICY creatives_mutate_own
  ON creatives FOR ALL TO authenticated
  USING (
    campaign_id IN (
      SELECT c.id FROM campaigns c
      JOIN advertisers a ON a.id = c.advertiser_id
      WHERE a.profile_id = auth.uid()
    )
  )
  WITH CHECK (
    campaign_id IN (
      SELECT c.id FROM campaigns c
      JOIN advertisers a ON a.id = c.advertiser_id
      WHERE a.profile_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- publishers (own org read)
-- ---------------------------------------------------------------------------
CREATE POLICY publishers_select_own
  ON publishers FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR public.is_admin());

CREATE POLICY publisher_revenue_select_own
  ON publisher_revenue FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR publisher_id IN (SELECT id FROM publishers WHERE profile_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- installations / wait_sessions: own profile reads; writes via service later
-- ---------------------------------------------------------------------------
CREATE POLICY installations_select_own
  ON installations FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR public.is_admin());

CREATE POLICY wait_sessions_select_own
  ON wait_sessions FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR public.is_admin());

CREATE POLICY ad_requests_select_own
  ON ad_requests FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR wait_session_id IN (
      SELECT id FROM wait_sessions WHERE profile_id = auth.uid()
    )
  );

CREATE POLICY impressions_select_own
  ON impressions FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR wait_session_id IN (
      SELECT id FROM wait_sessions WHERE profile_id = auth.uid()
    )
  );

CREATE POLICY clicks_select_own
  ON clicks FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR impression_id IN (
      SELECT i.id
      FROM impressions i
      JOIN wait_sessions ws ON ws.id = i.wait_session_id
      WHERE ws.profile_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- platform_events / audit_log / app_config: no direct client writes
-- ---------------------------------------------------------------------------
CREATE POLICY app_config_select_authenticated
  ON app_config FOR SELECT TO authenticated
  USING (true);

-- platform_events: foundation = no client INSERT (edge functions / API later)
-- audit_log: admin select only; no client writes
CREATE POLICY audit_log_select_admin
  ON audit_log FOR SELECT TO authenticated
  USING (public.is_admin());

-- Deny anon from financial writes: no policies granted to anon on ledger/revenue/wallets.
-- Authenticated also has no INSERT/UPDATE/DELETE on those tables.
