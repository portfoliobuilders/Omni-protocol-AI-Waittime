-- Phase 2.1: revenue_event reconciliation fields + micropaise-only campaign contract.
-- Ensures settlement rows carry provider linkage for audit.

ALTER TABLE revenue_events
  ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES demand_providers (id);

ALTER TABLE revenue_events
  ADD COLUMN IF NOT EXISTS provider_key text;

ALTER TABLE revenue_events
  ADD COLUMN IF NOT EXISTS advertiser_id uuid REFERENCES advertisers (id);

ALTER TABLE revenue_events
  ADD COLUMN IF NOT EXISTS wait_session_id uuid REFERENCES wait_sessions (id);

ALTER TABLE revenue_events
  ADD COLUMN IF NOT EXISTS settlement_status text
    CHECK (settlement_status IS NULL OR settlement_status IN (
      'estimated', 'pending', 'confirmed', 'settled', 'reversed'
    ));

ALTER TABLE revenue_events
  ADD COLUMN IF NOT EXISTS provider_reference text;

ALTER TABLE revenue_events
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

ALTER TABLE revenue_events
  ADD COLUMN IF NOT EXISTS settled_at timestamptz;

ALTER TABLE revenue_events
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_revenue_events_provider_key
  ON revenue_events (provider_key, created_at DESC);

-- Move settle_impression into private schema so Data API / clients cannot call it.
CREATE SCHEMA IF NOT EXISTS omni_private;

-- Recreate settlement in private schema; service role / SECURITY DEFINER only.
CREATE OR REPLACE FUNCTION omni_private.settle_impression(p_impression_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, omni_private
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
  v_entry_type text;
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

  IF v_imp.status = 'settled' AND COALESCE(v_imp.financial_status, '') = 'none' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'house', true,
      'impression_id', v_imp.id,
      'gross_micropaise', 0,
      'user_share_micropaise', 0,
      'omni_share_micropaise', 0
    );
  END IF;

  IF v_imp.status NOT IN ('qualified', 'pending') THEN
    RAISE EXCEPTION 'impression_not_qualifiable';
  END IF;

  IF v_imp.source = 'house' OR COALESCE(v_imp.provider_key, 'house') = 'house' THEN
    UPDATE impressions SET
      status = 'settled',
      financial_status = 'none',
      settled_at = now(),
      qualified_at = COALESCE(qualified_at, now())
    WHERE id = v_imp.id;

    -- No monetary revenue_event for house.
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

  v_gross := v_campaign.cpm_micropaise / 1000;
  IF v_gross <= 0 THEN
    RAISE EXCEPTION 'invalid_cpm';
  END IF;

  IF v_campaign.spent_micropaise + v_gross > v_campaign.total_budget_micropaise THEN
    RAISE EXCEPTION 'insufficient_budget';
  END IF;

  SELECT COALESCE((value #>> '{}')::int, 6000) INTO v_user_bps
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
    impression_id, campaign_id, advertiser_id, wait_session_id,
    provider_id, provider_key,
    gross_micropaise, user_share_micropaise, omni_share_micropaise, publisher_share_micropaise,
    settlement_status, settled_at, confirmed_at
  ) VALUES (
    v_imp.id, v_campaign.id, v_campaign.advertiser_id, v_imp.wait_session_id,
    v_provider.id, v_provider.provider_key,
    v_gross, v_user_share, v_omni_share, 0,
    'settled', now(), now()
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
  v_entry_type := CASE WHEN v_provider.provider_key = 'seed_sponsor'
    THEN 'seed_sponsor_earning' ELSE 'direct_ad_earning' END;

  INSERT INTO ledger_entries (
    wallet_id, entry_type, amount_micropaise, balance_after_micropaise,
    reference_type, reference_id, idempotency_key
  ) VALUES (
    v_wallet.id,
    v_entry_type,
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

-- Public wrapper revoked from API roles; only service_role / postgres can execute private fn.
REVOKE ALL ON FUNCTION omni_private.settle_impression(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION omni_private.settle_impression(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION omni_private.settle_impression(uuid) TO postgres;

-- Keep public.settle_impression as thin wrapper for server RPC compatibility,
-- but revoke from anon/authenticated.
CREATE OR REPLACE FUNCTION public.settle_impression(p_impression_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, omni_private
AS $$
BEGIN
  RETURN omni_private.settle_impression(p_impression_id);
END;
$$;

REVOKE ALL ON FUNCTION public.settle_impression(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_impression(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_impression(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_impression(uuid) TO postgres;

COMMENT ON FUNCTION omni_private.settle_impression(uuid) IS
  'Authoritative atomic settlement. House creates no monetary revenue_event. Direct/seed: 60/40 micropaise.';
