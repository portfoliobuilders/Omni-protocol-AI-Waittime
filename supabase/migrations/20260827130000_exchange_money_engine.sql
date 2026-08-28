-- Phase 2: Omni Exchange foundation + production-safe config + settlement.
-- Money unit: BIGINT micropaise. Consumer direct ads: 60% user / 40% Omni.
-- Config defaults live HERE (not only seed.sql) so production db push is safe.

-- ---------------------------------------------------------------------------
-- Demand providers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demand_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key text NOT NULL UNIQUE,
  provider_type text NOT NULL
    CHECK (provider_type IN (
      'omni_direct',
      'seed_sponsor',
      'house',
      'external_network',
      'admob_mobile',
      'applovin_mobile',
      'meta_audience_network_mobile',
      'future_programmatic_provider'
    )),
  enabled boolean NOT NULL DEFAULT true,
  supports_browser_extension boolean NOT NULL DEFAULT true,
  supports_web boolean NOT NULL DEFAULT true,
  supports_mobile boolean NOT NULL DEFAULT false,
  supports_ide boolean NOT NULL DEFAULT false,
  supports_agent boolean NOT NULL DEFAULT false,
  supports_publisher_sdk boolean NOT NULL DEFAULT false,
  cash_revenue_share_allowed boolean NOT NULL DEFAULT false,
  settlement_mode text NOT NULL
    CHECK (settlement_mode IN ('instant', 'pending', 'external_reconciliation')),
  settlement_delay_seconds integer NOT NULL DEFAULT 0 CHECK (settlement_delay_seconds >= 0),
  clawback_supported boolean NOT NULL DEFAULT false,
  policy_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_demand_providers_enabled
  ON demand_providers (enabled, provider_type);

INSERT INTO demand_providers (
  provider_key, provider_type, enabled,
  cash_revenue_share_allowed, settlement_mode,
  supports_browser_extension, supports_web
) VALUES
  ('omni_direct', 'omni_direct', true, true, 'instant', true, true),
  ('seed_sponsor', 'seed_sponsor', true, true, 'instant', true, true),
  ('house', 'house', true, false, 'instant', true, true)
ON CONFLICT (provider_key) DO NOTHING;

-- Future external placeholders (disabled; no cash share until contracted)
INSERT INTO demand_providers (
  provider_key, provider_type, enabled,
  cash_revenue_share_allowed, settlement_mode,
  supports_browser_extension, supports_web, supports_mobile
) VALUES
  ('external_network', 'external_network', false, false, 'external_reconciliation', true, true, true),
  ('admob_mobile', 'admob_mobile', false, false, 'external_reconciliation', false, false, true),
  ('applovin_mobile', 'applovin_mobile', false, false, 'external_reconciliation', false, false, true),
  ('meta_audience_network_mobile', 'meta_audience_network_mobile', false, false, 'external_reconciliation', false, false, true)
ON CONFLICT (provider_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Production-safe app_config defaults (authoritative; seed.sql is local-only helper)
-- ---------------------------------------------------------------------------
INSERT INTO app_config (key, value, updated_at) VALUES
  ('user_revenue_share_bps', '6000'::jsonb, now()),
  ('omni_revenue_share_bps', '4000'::jsonb, now()),
  ('minimum_qualified_view_ms', '5000'::jsonb, now()),
  ('minimum_cpm_micropaise', '1000000'::jsonb, now()),
  -- ₹10 CPM = 1_000_000 micropaise per 1000 impressions
  ('max_impressions_per_campaign_user_day', '20'::jsonb, now()),
  ('minimum_repeat_interval_seconds', '30'::jsonb, now()),
  ('exchange_selection_priority', '["omni_direct","seed_sponsor","house"]'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Link campaigns to demand providers
-- ---------------------------------------------------------------------------
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES demand_providers (id);

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS provider_key text;

UPDATE campaigns
SET provider_key = 'omni_direct'
WHERE provider_key IS NULL;

ALTER TABLE campaigns
  ALTER COLUMN provider_key SET DEFAULT 'omni_direct';

CREATE INDEX IF NOT EXISTS idx_campaigns_provider_key ON campaigns (provider_key);

-- ---------------------------------------------------------------------------
-- Wallet: available vs pending architecture
-- ---------------------------------------------------------------------------
ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS available_micropaise bigint NOT NULL DEFAULT 0
    CHECK (available_micropaise >= 0);

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS pending_micropaise bigint NOT NULL DEFAULT 0
    CHECK (pending_micropaise >= 0);

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS lifetime_earned_micropaise bigint NOT NULL DEFAULT 0
    CHECK (lifetime_earned_micropaise >= 0);

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS lifetime_paid_micropaise bigint NOT NULL DEFAULT 0
    CHECK (lifetime_paid_micropaise >= 0);

-- Keep cached_balance_micropaise as alias of available for compatibility
COMMENT ON COLUMN wallets.cached_balance_micropaise IS
  'Legacy cache; prefer available_micropaise. Must equal available_micropaise.';

-- ---------------------------------------------------------------------------
-- Impression financial status (direct vs future external)
-- ---------------------------------------------------------------------------
ALTER TABLE impressions
  ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES demand_providers (id);

ALTER TABLE impressions
  ADD COLUMN IF NOT EXISTS provider_key text;

ALTER TABLE impressions
  ADD COLUMN IF NOT EXISTS financial_status text
    CHECK (financial_status IS NULL OR financial_status IN (
      'none',
      'estimated',
      'pending',
      'confirmed',
      'settled',
      'reversed'
    ));

ALTER TABLE impressions
  ADD COLUMN IF NOT EXISTS required_view_ms integer;

ALTER TABLE impressions
  ADD COLUMN IF NOT EXISTS reported_view_ms integer;

ALTER TABLE impressions
  ADD COLUMN IF NOT EXISTS served_at timestamptz;

ALTER TABLE impressions
  ADD COLUMN IF NOT EXISTS client_rendered_at timestamptz;

ALTER TABLE impressions
  ADD COLUMN IF NOT EXISTS qualified_at timestamptz;

ALTER TABLE ad_requests
  ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES demand_providers (id);

ALTER TABLE ad_requests
  ADD COLUMN IF NOT EXISTS provider_key text;

-- Tighten platform_events event vocabulary for Exchange
ALTER TABLE platform_events DROP CONSTRAINT IF EXISTS platform_events_event_check;
ALTER TABLE platform_events
  ADD CONSTRAINT platform_events_event_check
  CHECK (event IN (
    'detected',
    'shown',
    'rendered',
    'qualified',
    'settled',
    'wait_ended',
    'error'
  ));

-- ---------------------------------------------------------------------------
-- Atomic settlement function (Postgres source of truth)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION settle_impression(p_impression_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_imp impressions%ROWTYPE;
  v_campaign campaigns%ROWTYPE;
  v_provider demand_providers%ROWTYPE;
  v_wallet wallets%ROWTYPE;
  v_profile_id uuid;
  v_gross bigint;
  v_user_bps int;
  v_user_share bigint;
  v_omni_share bigint;
  v_ledger_id uuid;
  v_idempotency text;
BEGIN
  SELECT * INTO v_imp FROM impressions WHERE id = p_impression_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'impression_not_found';
  END IF;

  IF v_imp.status = 'settled' AND COALESCE(v_imp.financial_status, '') = 'settled' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'impression_id', v_imp.id,
      'gross_micropaise', 0,
      'user_share_micropaise', 0,
      'omni_share_micropaise', 0
    );
  END IF;

  IF v_imp.status NOT IN ('qualified', 'pending') THEN
    RAISE EXCEPTION 'impression_not_qualifiable';
  END IF;

  -- House / non-cash providers: zero money, mark settled financially as none
  IF v_imp.source = 'house' OR COALESCE(v_imp.provider_key, 'house') = 'house' THEN
    UPDATE impressions SET
      status = 'settled',
      financial_status = 'none',
      settled_at = now(),
      qualified_at = COALESCE(qualified_at, now())
    WHERE id = v_imp.id;

    RETURN jsonb_build_object(
      'ok', true,
      'duplicate', false,
      'house', true,
      'impression_id', v_imp.id,
      'gross_micropaise', 0,
      'user_share_micropaise', 0,
      'omni_share_micropaise', 0
    );
  END IF;

  SELECT * INTO v_provider
  FROM demand_providers
  WHERE provider_key = COALESCE(v_imp.provider_key, 'omni_direct')
  FOR UPDATE;

  IF NOT FOUND OR v_provider.enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'provider_disabled';
  END IF;

  IF v_provider.cash_revenue_share_allowed IS NOT TRUE THEN
    UPDATE impressions SET
      status = 'settled',
      financial_status = 'none',
      settled_at = now(),
      qualified_at = COALESCE(qualified_at, now())
    WHERE id = v_imp.id;

    RETURN jsonb_build_object(
      'ok', true,
      'duplicate', false,
      'cash_share_disallowed', true,
      'impression_id', v_imp.id,
      'gross_micropaise', 0,
      'user_share_micropaise', 0,
      'omni_share_micropaise', 0
    );
  END IF;

  IF v_imp.campaign_id IS NULL THEN
    RAISE EXCEPTION 'campaign_required_for_paid';
  END IF;

  SELECT * INTO v_campaign FROM campaigns WHERE id = v_imp.campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_not_found';
  END IF;

  IF v_campaign.status <> 'active' THEN
    RAISE EXCEPTION 'campaign_not_active';
  END IF;

  IF v_campaign.starts_at IS NOT NULL AND v_campaign.starts_at > now() THEN
    RAISE EXCEPTION 'campaign_not_started';
  END IF;

  IF v_campaign.ends_at IS NOT NULL AND v_campaign.ends_at < now() THEN
    RAISE EXCEPTION 'campaign_ended';
  END IF;

  -- Gross = CPM micropaise / 1000 (per impression)
  v_gross := v_campaign.cpm_micropaise / 1000;
  IF v_gross <= 0 THEN
    RAISE EXCEPTION 'invalid_cpm';
  END IF;

  IF v_campaign.spent_micropaise + v_gross > v_campaign.total_budget_micropaise THEN
    RAISE EXCEPTION 'insufficient_budget';
  END IF;

  SELECT (value #>> '{}')::int INTO v_user_bps
  FROM app_config WHERE key = 'user_revenue_share_bps';
  IF v_user_bps IS NULL THEN
    v_user_bps := 6000;
  END IF;

  v_user_share := (v_gross * v_user_bps) / 10000;
  v_omni_share := v_gross - v_user_share;

  UPDATE campaigns SET
    spent_micropaise = spent_micropaise + v_gross,
    status = CASE
      WHEN spent_micropaise + v_gross >= total_budget_micropaise THEN 'exhausted'
      ELSE status
    END
  WHERE id = v_campaign.id;

  INSERT INTO advertiser_ledger_entries (
    advertiser_id, entry_type, amount_micropaise, balance_after_micropaise,
    reference_type, reference_id, idempotency_key
  )
  SELECT
    v_campaign.advertiser_id,
    'campaign_spend',
    -v_gross,
    COALESCE((SELECT cached_balance_micropaise FROM advertiser_wallets WHERE advertiser_id = v_campaign.advertiser_id), 0) - v_gross,
    'impression',
    v_imp.id,
    'spend:impression:' || v_imp.id::text
  ON CONFLICT (idempotency_key) DO NOTHING;

  UPDATE advertiser_wallets
  SET cached_balance_micropaise = GREATEST(0, cached_balance_micropaise - v_gross),
      updated_at = now()
  WHERE advertiser_id = v_campaign.advertiser_id;

  INSERT INTO revenue_events (
    impression_id, campaign_id,
    gross_micropaise, user_share_micropaise, omni_share_micropaise, publisher_share_micropaise
  ) VALUES (
    v_imp.id, v_campaign.id, v_gross, v_user_share, v_omni_share, 0
  )
  ON CONFLICT (impression_id) DO NOTHING;

  SELECT ws.profile_id INTO v_profile_id
  FROM wait_sessions ws WHERE ws.id = v_imp.wait_session_id;

  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'profile_required_for_earning';
  END IF;

  INSERT INTO wallets (profile_id, cached_balance_micropaise, available_micropaise)
  VALUES (v_profile_id, 0, 0)
  ON CONFLICT (profile_id) DO NOTHING;

  SELECT * INTO v_wallet FROM wallets WHERE profile_id = v_profile_id FOR UPDATE;

  v_idempotency := 'earn:impression:' || v_imp.id::text;

  INSERT INTO ledger_entries (
    wallet_id, entry_type, amount_micropaise, balance_after_micropaise,
    reference_type, reference_id, idempotency_key
  ) VALUES (
    v_wallet.id,
    CASE WHEN COALESCE(v_imp.provider_key, 'omni_direct') = 'seed_sponsor'
      THEN 'seed_sponsor_earning' ELSE 'direct_ad_earning' END,
    v_user_share,
    v_wallet.available_micropaise + v_user_share,
    'impression',
    v_imp.id,
    v_idempotency
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_ledger_id;

  IF v_ledger_id IS NOT NULL THEN
    UPDATE wallets SET
      available_micropaise = available_micropaise + v_user_share,
      cached_balance_micropaise = available_micropaise + v_user_share,
      lifetime_earned_micropaise = lifetime_earned_micropaise + v_user_share,
      updated_at = now()
    WHERE id = v_wallet.id;
  END IF;

  UPDATE impressions SET
    status = 'settled',
    financial_status = 'settled',
    settled_at = now(),
    qualified_at = COALESCE(qualified_at, now())
  WHERE id = v_imp.id;

  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'impression_id', v_imp.id,
    'gross_micropaise', v_gross,
    'user_share_micropaise', v_user_share,
    'omni_share_micropaise', v_omni_share
  );
END;
$$;

REVOKE ALL ON FUNCTION settle_impression(uuid) FROM PUBLIC;
-- Invoked only via service role / SECURITY DEFINER server paths

COMMENT ON FUNCTION settle_impression(uuid) IS
  'Atomic paid impression settlement. House → ₹0. Direct/seed → 60/40 micropaise. Idempotent.';

-- RLS for demand_providers (read-only for authenticated; writes via service role)
ALTER TABLE demand_providers ENABLE ROW LEVEL SECURITY;

CREATE POLICY demand_providers_select_enabled
  ON demand_providers FOR SELECT TO authenticated, anon
  USING (enabled = true);

-- No INSERT/UPDATE/DELETE policies for anon/authenticated → denied
