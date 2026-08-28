-- Phase 2.1: atomic user redemption (available balance only).
-- Called only via service_role from the trusted API — never from the browser.

CREATE OR REPLACE FUNCTION omni_private.request_redemption(
  p_profile_id uuid,
  p_amount_micropaise bigint,
  p_method text,
  p_detail text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, omni_private
AS $$
DECLARE
  v_wallet wallets%ROWTYPE;
  v_redemption_id uuid;
  v_idempotency text;
BEGIN
  IF p_amount_micropaise IS NULL OR p_amount_micropaise <= 0 THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;
  IF p_method IS NULL OR length(trim(p_method)) = 0 THEN
    RAISE EXCEPTION 'method_required';
  END IF;

  INSERT INTO wallets (profile_id, cached_balance_micropaise, available_micropaise)
  VALUES (p_profile_id, 0, 0)
  ON CONFLICT (profile_id) DO NOTHING;

  SELECT * INTO v_wallet FROM wallets WHERE profile_id = p_profile_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet_not_found';
  END IF;

  IF v_wallet.available_micropaise < p_amount_micropaise THEN
    RAISE EXCEPTION 'insufficient_available';
  END IF;

  INSERT INTO redemptions (profile_id, amount_micropaise, method, detail, status)
  VALUES (p_profile_id, p_amount_micropaise, trim(p_method), p_detail, 'requested')
  RETURNING id INTO v_redemption_id;

  v_idempotency := 'redeem:' || v_redemption_id::text;

  INSERT INTO ledger_entries (
    wallet_id, entry_type, amount_micropaise, balance_after_micropaise,
    reference_type, reference_id, idempotency_key
  ) VALUES (
    v_wallet.id,
    'redemption_request',
    -p_amount_micropaise,
    v_wallet.available_micropaise - p_amount_micropaise,
    'redemption',
    v_redemption_id,
    v_idempotency
  );

  UPDATE wallets SET
    available_micropaise = available_micropaise - p_amount_micropaise,
    cached_balance_micropaise = available_micropaise - p_amount_micropaise,
    updated_at = now()
  WHERE id = v_wallet.id;

  RETURN jsonb_build_object(
    'ok', true,
    'redemption_id', v_redemption_id,
    'amount_micropaise', p_amount_micropaise,
    'available_micropaise', v_wallet.available_micropaise - p_amount_micropaise
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.request_redemption(
  p_profile_id uuid,
  p_amount_micropaise bigint,
  p_method text,
  p_detail text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, omni_private
AS $$
BEGIN
  RETURN omni_private.request_redemption(
    p_profile_id, p_amount_micropaise, p_method, p_detail
  );
END;
$$;

REVOKE ALL ON FUNCTION omni_private.request_redemption(uuid, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION omni_private.request_redemption(uuid, bigint, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION omni_private.request_redemption(uuid, bigint, text, text) TO postgres;

REVOKE ALL ON FUNCTION public.request_redemption(uuid, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_redemption(uuid, bigint, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_redemption(uuid, bigint, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_redemption(uuid, bigint, text, text) TO postgres;
