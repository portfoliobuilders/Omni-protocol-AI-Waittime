-- OmniPiggy foundation schema
-- Money unit: BIGINT micropaise (1 INR = 100 paise = 100_000 micropaise)
-- PKs: UUID. Timestamps: timestamptz.
-- auth.users linkage: profiles.id is intended to match auth.users.id (application-enforced;
-- optional FK to auth.users can be added when the project is linked to Supabase Auth).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- App config (platform knobs)
-- ---------------------------------------------------------------------------
CREATE TABLE app_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Profiles / installations / wait sessions
-- ---------------------------------------------------------------------------
CREATE TABLE profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Intended to equal auth.users.id when using Supabase Auth
  role text NOT NULL DEFAULT 'user'
    CHECK (role IN ('user', 'advertiser', 'publisher', 'admin')),
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid REFERENCES profiles (id) ON DELETE SET NULL,
  extension_install_id text NOT NULL UNIQUE,
  platform_info text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_installations_profile_id ON installations (profile_id);

CREATE TABLE wait_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id uuid REFERENCES installations (id) ON DELETE SET NULL,
  profile_id uuid REFERENCES profiles (id) ON DELETE SET NULL,
  platform text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'completed', 'abandoned', 'expired', 'cancelled')),
  server_nonce text NOT NULL UNIQUE,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wait_sessions_installation_id ON wait_sessions (installation_id);
CREATE INDEX idx_wait_sessions_profile_id ON wait_sessions (profile_id);
CREATE INDEX idx_wait_sessions_platform_created ON wait_sessions (platform, created_at DESC);

-- ---------------------------------------------------------------------------
-- Advertisers
-- ---------------------------------------------------------------------------
CREATE TABLE advertisers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE RESTRICT,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_advertisers_profile_id ON advertisers (profile_id);

CREATE TABLE advertiser_wallets (
  advertiser_id uuid PRIMARY KEY REFERENCES advertisers (id) ON DELETE CASCADE,
  cached_balance_micropaise bigint NOT NULL DEFAULT 0
    CHECK (cached_balance_micropaise >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE advertiser_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id uuid NOT NULL REFERENCES advertisers (id) ON DELETE RESTRICT,
  entry_type text NOT NULL
    CHECK (entry_type IN (
      'funding_credit',
      'campaign_reservation',
      'campaign_spend',
      'refund',
      'adjustment'
    )),
  amount_micropaise bigint NOT NULL,
  balance_after_micropaise bigint NOT NULL,
  reference_type text,
  reference_id uuid,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_advertiser_ledger_advertiser_created
  ON advertiser_ledger_entries (advertiser_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Campaigns / creatives
-- ---------------------------------------------------------------------------
CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id uuid NOT NULL REFERENCES advertisers (id) ON DELETE RESTRICT,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft',
      'pending_review',
      'active',
      'paused',
      'exhausted',
      'rejected',
      'ended'
    )),
  cpm_micropaise bigint NOT NULL CHECK (cpm_micropaise > 0),
  total_budget_micropaise bigint NOT NULL CHECK (total_budget_micropaise > 0),
  spent_micropaise bigint NOT NULL DEFAULT 0 CHECK (spent_micropaise >= 0),
  daily_budget_micropaise bigint CHECK (daily_budget_micropaise IS NULL OR daily_budget_micropaise > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  review_status text,
  review_notes text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (spent_micropaise <= total_budget_micropaise)
);

CREATE INDEX idx_campaigns_advertiser_id ON campaigns (advertiser_id);
CREATE INDEX idx_campaigns_status ON campaigns (status);
CREATE INDEX idx_campaigns_active_spend
  ON campaigns (status, spent_micropaise, total_budget_micropaise)
  WHERE status = 'active';

CREATE TABLE campaign_surfaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  surface text NOT NULL,
  UNIQUE (campaign_id, surface)
);

CREATE INDEX idx_campaign_surfaces_campaign_id ON campaign_surfaces (campaign_id);

CREATE TABLE creatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  headline text NOT NULL,
  description text,
  cta_label text,
  cta_url text,
  logo_path text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_creatives_campaign_id ON creatives (campaign_id);

-- ---------------------------------------------------------------------------
-- Ad delivery / impressions / clicks
-- ---------------------------------------------------------------------------
CREATE TABLE ad_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wait_session_id uuid NOT NULL REFERENCES wait_sessions (id) ON DELETE RESTRICT,
  installation_id uuid REFERENCES installations (id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES campaigns (id) ON DELETE SET NULL,
  creative_id uuid REFERENCES creatives (id) ON DELETE SET NULL,
  source text NOT NULL
    CHECK (source IN ('paid_campaign', 'house')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ad_requests_wait_session_id ON ad_requests (wait_session_id);
CREATE INDEX idx_ad_requests_campaign_id ON ad_requests (campaign_id);
CREATE INDEX idx_ad_requests_created ON ad_requests (created_at DESC);

CREATE TABLE impressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_request_id uuid NOT NULL UNIQUE REFERENCES ad_requests (id) ON DELETE RESTRICT,
  wait_session_id uuid NOT NULL REFERENCES wait_sessions (id) ON DELETE RESTRICT,
  campaign_id uuid REFERENCES campaigns (id) ON DELETE SET NULL,
  creative_id uuid REFERENCES creatives (id) ON DELETE SET NULL,
  source text NOT NULL
    CHECK (source IN ('paid_campaign', 'house')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'qualified', 'settled', 'rejected')),
  viewable_ms integer CHECK (viewable_ms IS NULL OR viewable_ms >= 0),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Settlement idempotency (partial unique indexes)
CREATE UNIQUE INDEX impressions_one_settled_per_ad_request
  ON impressions (ad_request_id)
  WHERE status = 'settled';

CREATE UNIQUE INDEX impressions_settlement_idempotency_paid
  ON impressions (wait_session_id, campaign_id)
  WHERE status = 'settled' AND campaign_id IS NOT NULL AND source = 'paid_campaign';

CREATE INDEX idx_impressions_wait_session_id ON impressions (wait_session_id);
CREATE INDEX idx_impressions_campaign_id ON impressions (campaign_id);
CREATE INDEX idx_impressions_status_created ON impressions (status, created_at DESC);

CREATE TABLE clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  impression_id uuid NOT NULL REFERENCES impressions (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_clicks_impression_id ON clicks (impression_id);

-- ---------------------------------------------------------------------------
-- User wallets / ledger / revenue
-- ---------------------------------------------------------------------------
CREATE TABLE wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL UNIQUE REFERENCES profiles (id) ON DELETE RESTRICT,
  cached_balance_micropaise bigint NOT NULL DEFAULT 0
    CHECK (cached_balance_micropaise >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
  entry_type text NOT NULL,
  amount_micropaise bigint NOT NULL,
  balance_after_micropaise bigint NOT NULL,
  reference_type text,
  reference_id uuid,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ledger_entries_wallet_created
  ON ledger_entries (wallet_id, created_at DESC);
CREATE INDEX idx_ledger_entries_reference
  ON ledger_entries (reference_type, reference_id);

CREATE TABLE revenue_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  impression_id uuid NOT NULL UNIQUE REFERENCES impressions (id) ON DELETE RESTRICT,
  campaign_id uuid REFERENCES campaigns (id) ON DELETE SET NULL,
  gross_micropaise bigint NOT NULL CHECK (gross_micropaise >= 0),
  user_share_micropaise bigint NOT NULL CHECK (user_share_micropaise >= 0),
  omni_share_micropaise bigint NOT NULL CHECK (omni_share_micropaise >= 0),
  publisher_share_micropaise bigint NOT NULL DEFAULT 0 CHECK (publisher_share_micropaise >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    user_share_micropaise + omni_share_micropaise + publisher_share_micropaise
      = gross_micropaise
  )
);

CREATE INDEX idx_revenue_events_campaign_created
  ON revenue_events (campaign_id, created_at DESC);

CREATE TABLE redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE RESTRICT,
  amount_micropaise bigint NOT NULL CHECK (amount_micropaise > 0),
  method text NOT NULL,
  detail text,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN (
      'requested',
      'under_review',
      'approved',
      'paid',
      'rejected',
      'cancelled'
    )),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX idx_redemptions_profile_id ON redemptions (profile_id);
CREATE INDEX idx_redemptions_status ON redemptions (status);

-- ---------------------------------------------------------------------------
-- Publishers
-- ---------------------------------------------------------------------------
CREATE TABLE publishers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE RESTRICT,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_publishers_profile_id ON publishers (profile_id);

CREATE TABLE publisher_revenue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publisher_id uuid NOT NULL REFERENCES publishers (id) ON DELETE RESTRICT,
  impression_id uuid NOT NULL UNIQUE REFERENCES impressions (id) ON DELETE RESTRICT,
  amount_micropaise bigint NOT NULL CHECK (amount_micropaise >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_publisher_revenue_publisher_created
  ON publisher_revenue (publisher_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Telemetry / audit
-- ---------------------------------------------------------------------------
CREATE TABLE platform_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host text NOT NULL,
  event text NOT NULL,
  installation_id uuid REFERENCES installations (id) ON DELETE SET NULL,
  profile_id uuid REFERENCES profiles (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_platform_events_host_created ON platform_events (host, created_at DESC);
CREATE INDEX idx_platform_events_installation_id ON platform_events (installation_id);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_profile_id uuid REFERENCES profiles (id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_actor_created ON audit_log (actor_profile_id, created_at DESC);
CREATE INDEX idx_audit_log_entity ON audit_log (entity_type, entity_id);
