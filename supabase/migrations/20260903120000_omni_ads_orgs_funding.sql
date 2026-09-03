-- Phase 4 Omni Ads: organizations, funding requests, inventory, creative safety,
-- and tighter advertiser RLS. Does not alter settle_impression() money math.

-- ---------------------------------------------------------------------------
-- Organizations / members / profiles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advertiser_organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS advertiser_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES advertiser_organizations (id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner'
    CHECK (role IN ('owner', 'admin', 'analyst')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_advertiser_members_profile
  ON advertiser_members (profile_id);
CREATE INDEX IF NOT EXISTS idx_advertiser_members_org
  ON advertiser_members (organization_id);

CREATE TABLE IF NOT EXISTS advertiser_profiles (
  profile_id uuid PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
  full_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE advertisers
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES advertiser_organizations (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_advertisers_organization_id
  ON advertisers (organization_id);

-- ---------------------------------------------------------------------------
-- Campaign / creative columns
-- ---------------------------------------------------------------------------
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS destination_url text,
  ADD COLUMN IF NOT EXISTS targeting_mode text NOT NULL DEFAULT 'all_enabled',
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES profiles (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

ALTER TABLE campaigns
  DROP CONSTRAINT IF EXISTS campaigns_targeting_mode_check;
ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_targeting_mode_check
  CHECK (targeting_mode IN ('all_enabled', 'specific'));

ALTER TABLE campaigns
  DROP CONSTRAINT IF EXISTS campaigns_review_status_check;
ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_review_status_check
  CHECK (
    review_status IS NULL
    OR review_status IN (
      'pending',
      'approved',
      'rejected',
      'changes_requested'
    )
  );

ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS advertiser_name text,
  ADD COLUMN IF NOT EXISTS mime_type text;

-- Backfill: rows with surfaces are specific; active campaigns are approved.
UPDATE campaigns c
SET targeting_mode = 'specific'
WHERE EXISTS (
  SELECT 1 FROM campaign_surfaces cs WHERE cs.campaign_id = c.id
);

UPDATE campaigns
SET review_status = 'approved',
    reviewed_at = COALESCE(reviewed_at, now())
WHERE status = 'active'
  AND COALESCE(review_status, '') NOT IN ('rejected', 'changes_requested');

-- ---------------------------------------------------------------------------
-- Funding requests (pilot: admin-confirmed, never self-credited)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advertiser_funding_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id uuid NOT NULL REFERENCES advertisers (id) ON DELETE RESTRICT,
  amount_micropaise bigint NOT NULL CHECK (amount_micropaise > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'rejected', 'cancelled')),
  notes text,
  requested_by uuid REFERENCES profiles (id) ON DELETE SET NULL,
  reviewed_by uuid REFERENCES profiles (id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  ledger_entry_id uuid REFERENCES advertiser_ledger_entries (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_funding_requests_advertiser
  ON advertiser_funding_requests (advertiser_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funding_requests_status
  ON advertiser_funding_requests (status);

-- ---------------------------------------------------------------------------
-- Inventory catalog
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_surfaces (
  surface_key text PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL
    CHECK (category IN ('browser_ai', 'developer_ide', 'agent_cli', 'partner_apps')),
  serving_enabled boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL
    CHECK (verification_status IN ('live_verified', 'code_ready', 'coming')),
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO inventory_surfaces (surface_key, name, category, serving_enabled, verification_status, sort_order)
VALUES
  ('chatgpt.com', 'ChatGPT', 'browser_ai', true, 'live_verified', 10),
  ('claude.ai', 'Claude', 'browser_ai', false, 'code_ready', 20),
  ('gemini.google.com', 'Gemini', 'browser_ai', false, 'code_ready', 30),
  ('perplexity.ai', 'Perplexity', 'browser_ai', false, 'coming', 40),
  ('copilot.microsoft.com', 'Copilot', 'browser_ai', false, 'coming', 50),
  ('chat.deepseek.com', 'DeepSeek', 'browser_ai', false, 'coming', 60),
  ('grok.com', 'Grok', 'browser_ai', false, 'coming', 70),
  ('meta.ai', 'Meta AI', 'browser_ai', false, 'coming', 80),
  ('chat.mistral.ai', 'Mistral', 'browser_ai', false, 'coming', 90),
  ('poe.com', 'Poe', 'browser_ai', false, 'coming', 100),
  ('developer.ide', 'Developer / IDE', 'developer_ide', false, 'coming', 200),
  ('agent.cli', 'Agent / CLI', 'agent_cli', false, 'coming', 210),
  ('partner.apps', 'Partner AI Apps', 'partner_apps', false, 'coming', 220)
ON CONFLICT (surface_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Backfill orgs for existing advertisers
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  org_id uuid;
BEGIN
  FOR r IN
    SELECT a.id, a.profile_id, a.name
    FROM advertisers a
    WHERE a.organization_id IS NULL
  LOOP
    INSERT INTO advertiser_organizations (name, status)
    VALUES (COALESCE(NULLIF(r.name, ''), 'Advertiser'), 'active')
    RETURNING id INTO org_id;

    UPDATE advertisers SET organization_id = org_id WHERE id = r.id;

    INSERT INTO advertiser_members (organization_id, profile_id, role)
    VALUES (org_id, r.profile_id, 'owner')
    ON CONFLICT (organization_id, profile_id) DO NOTHING;

    INSERT INTO advertiser_profiles (profile_id)
    VALUES (r.profile_id)
    ON CONFLICT (profile_id) DO NOTHING;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Auth signup → profile
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, role, display_name)
  VALUES (NEW.id, 'user', COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email))
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.advertiser_profiles (profile_id)
  VALUES (NEW.id)
  ON CONFLICT (profile_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Membership helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_org_member(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.advertiser_members m
    WHERE m.organization_id = p_org_id
      AND m.profile_id = auth.uid()
  ) OR public.is_admin();
$$;

CREATE OR REPLACE FUNCTION public.is_advertiser_member(p_advertiser_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.advertisers a
    JOIN public.advertiser_members m ON m.organization_id = a.organization_id
    WHERE a.id = p_advertiser_id
      AND m.profile_id = auth.uid()
  ) OR public.is_admin();
$$;

CREATE OR REPLACE FUNCTION public.is_advertiser_owner(p_advertiser_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_advertiser_member(p_advertiser_id);
$$;

CREATE OR REPLACE FUNCTION public.advertiser_can_write(p_advertiser_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.advertisers a
    JOIN public.advertiser_members m ON m.organization_id = a.organization_id
    WHERE a.id = p_advertiser_id
      AND m.profile_id = auth.uid()
      AND m.role IN ('owner', 'admin')
  ) OR public.is_admin();
$$;

-- ---------------------------------------------------------------------------
-- RLS: org tables + drop client mutations on campaigns/money
-- ---------------------------------------------------------------------------
ALTER TABLE advertiser_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE advertiser_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE advertiser_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE advertiser_funding_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_surfaces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS advertisers_insert_own ON advertisers;
DROP POLICY IF EXISTS advertisers_update_own ON advertisers;
DROP POLICY IF EXISTS campaigns_insert_own ON campaigns;
DROP POLICY IF EXISTS campaigns_update_own ON campaigns;
DROP POLICY IF EXISTS campaign_surfaces_mutate_own ON campaign_surfaces;
DROP POLICY IF EXISTS creatives_mutate_own ON creatives;

DROP POLICY IF EXISTS advertisers_select_own ON advertisers;
CREATE POLICY advertisers_select_own
  ON advertisers FOR SELECT TO authenticated
  USING (public.is_advertiser_member(id) OR public.is_admin());

DROP POLICY IF EXISTS advertiser_orgs_select_own ON advertiser_organizations;
CREATE POLICY advertiser_orgs_select_own
  ON advertiser_organizations FOR SELECT TO authenticated
  USING (public.is_org_member(id));

DROP POLICY IF EXISTS advertiser_members_select_own ON advertiser_members;
CREATE POLICY advertiser_members_select_own
  ON advertiser_members FOR SELECT TO authenticated
  USING (public.is_org_member(organization_id));

DROP POLICY IF EXISTS advertiser_profiles_select_own ON advertiser_profiles;
CREATE POLICY advertiser_profiles_select_own
  ON advertiser_profiles FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS advertiser_profiles_update_own ON advertiser_profiles;
CREATE POLICY advertiser_profiles_update_own
  ON advertiser_profiles FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS funding_requests_select_own ON advertiser_funding_requests;
CREATE POLICY funding_requests_select_own
  ON advertiser_funding_requests FOR SELECT TO authenticated
  USING (public.is_advertiser_member(advertiser_id) OR public.is_admin());

DROP POLICY IF EXISTS inventory_surfaces_select_auth ON inventory_surfaces;
CREATE POLICY inventory_surfaces_select_auth
  ON inventory_surfaces FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS campaigns_select_own ON campaigns;
CREATE POLICY campaigns_select_own
  ON campaigns FOR SELECT TO authenticated
  USING (public.is_advertiser_member(advertiser_id) OR public.is_admin());

DROP POLICY IF EXISTS campaign_surfaces_select_own ON campaign_surfaces;
CREATE POLICY campaign_surfaces_select_own
  ON campaign_surfaces FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR campaign_id IN (
      SELECT c.id FROM campaigns c WHERE public.is_advertiser_member(c.advertiser_id)
    )
  );

DROP POLICY IF EXISTS creatives_select_own ON creatives;
CREATE POLICY creatives_select_own
  ON creatives FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR campaign_id IN (
      SELECT c.id FROM campaigns c WHERE public.is_advertiser_member(c.advertiser_id)
    )
  );

DROP POLICY IF EXISTS advertiser_wallets_select_own ON advertiser_wallets;
CREATE POLICY advertiser_wallets_select_own
  ON advertiser_wallets FOR SELECT TO authenticated
  USING (public.is_advertiser_member(advertiser_id) OR public.is_admin());

DROP POLICY IF EXISTS advertiser_ledger_select_own ON advertiser_ledger_entries;
CREATE POLICY advertiser_ledger_select_own
  ON advertiser_ledger_entries FOR SELECT TO authenticated
  USING (public.is_advertiser_member(advertiser_id) OR public.is_admin());

-- Impressions / revenue readable by the campaign's advertiser (analytics)
DROP POLICY IF EXISTS impressions_select_advertiser ON impressions;
CREATE POLICY impressions_select_advertiser
  ON impressions FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR wait_session_id IN (
      SELECT id FROM wait_sessions WHERE profile_id = auth.uid()
    )
    OR (
      campaign_id IS NOT NULL
      AND campaign_id IN (
        SELECT c.id FROM campaigns c WHERE public.is_advertiser_member(c.advertiser_id)
      )
    )
  );

DROP POLICY IF EXISTS clicks_select_advertiser ON clicks;
CREATE POLICY clicks_select_advertiser
  ON clicks FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR impression_id IN (
      SELECT i.id
      FROM impressions i
      JOIN wait_sessions ws ON ws.id = i.wait_session_id
      WHERE ws.profile_id = auth.uid()
    )
    OR impression_id IN (
      SELECT i.id
      FROM impressions i
      JOIN campaigns c ON c.id = i.campaign_id
      WHERE public.is_advertiser_member(c.advertiser_id)
    )
  );

DROP POLICY IF EXISTS revenue_events_select_advertiser ON revenue_events;
CREATE POLICY revenue_events_select_advertiser
  ON revenue_events FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR impression_id IN (
      SELECT i.id
      FROM impressions i
      JOIN wait_sessions ws ON ws.id = i.wait_session_id
      WHERE ws.profile_id = auth.uid()
    )
    OR (
      campaign_id IS NOT NULL
      AND campaign_id IN (
        SELECT c.id FROM campaigns c WHERE public.is_advertiser_member(c.advertiser_id)
      )
    )
  );

DROP POLICY IF EXISTS ad_requests_select_advertiser ON ad_requests;
CREATE POLICY ad_requests_select_advertiser
  ON ad_requests FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR wait_session_id IN (
      SELECT id FROM wait_sessions WHERE profile_id = auth.uid()
    )
    OR (
      campaign_id IS NOT NULL
      AND campaign_id IN (
        SELECT c.id FROM campaigns c WHERE public.is_advertiser_member(c.advertiser_id)
      )
    )
  );

DROP POLICY IF EXISTS audit_log_select_org ON audit_log;
CREATE POLICY audit_log_select_org
  ON audit_log FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR (
      entity_type IN ('campaign', 'advertiser', 'funding')
      AND (
        (entity_type = 'advertiser' AND public.is_advertiser_member(entity_id))
        OR (entity_type = 'campaign' AND entity_id IN (
          SELECT c.id FROM campaigns c WHERE public.is_advertiser_member(c.advertiser_id)
        ))
        OR (entity_type = 'funding' AND entity_id IN (
          SELECT f.id FROM advertiser_funding_requests f
          WHERE public.is_advertiser_member(f.advertiser_id)
        ))
      )
    )
  );

-- ---------------------------------------------------------------------------
-- Storage bucket for logos (public read; writes via service role)
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'campaign-creatives',
  'campaign-creatives',
  true,
  1048576,
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS campaign_creatives_public_read ON storage.objects;
CREATE POLICY campaign_creatives_public_read
  ON storage.objects FOR SELECT
  USING (bucket_id = 'campaign-creatives');
