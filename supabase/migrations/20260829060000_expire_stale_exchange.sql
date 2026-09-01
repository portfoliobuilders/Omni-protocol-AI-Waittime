-- Stale unpaid impressions/sessions: expire without money movement.
-- Cron-ready: SELECT expire_stale_exchange_rows(1800);

ALTER TABLE impressions DROP CONSTRAINT IF EXISTS impressions_status_check;
ALTER TABLE impressions
  ADD CONSTRAINT impressions_status_check
  CHECK (status IN (
    'pending',
    'qualified',
    'settled',
    'rejected',
    'expired',
    'cancelled'
  ));

CREATE INDEX IF NOT EXISTS idx_impressions_pending_created
  ON impressions (created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_wait_sessions_open_started
  ON wait_sessions (started_at)
  WHERE status = 'open';

CREATE OR REPLACE FUNCTION expire_stale_exchange_rows(
  p_max_age_seconds integer DEFAULT 1800
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_impressions integer := 0;
  v_sessions integer := 0;
  v_age integer := GREATEST(COALESCE(p_max_age_seconds, 1800), 60);
BEGIN
  UPDATE impressions
  SET
    status = 'expired',
    financial_status = 'none'
  WHERE status = 'pending'
    AND COALESCE(financial_status, 'none') NOT IN ('settled', 'confirmed')
    AND created_at < now() - make_interval(secs => v_age);
  GET DIAGNOSTICS v_impressions = ROW_COUNT;

  UPDATE wait_sessions
  SET status = 'expired'
  WHERE status = 'open'
    AND started_at < now() - make_interval(secs => v_age);
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'expired_impressions', v_impressions,
    'expired_sessions', v_sessions,
    'max_age_seconds', v_age
  );
END;
$$;

REVOKE ALL ON FUNCTION expire_stale_exchange_rows(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_stale_exchange_rows(integer) TO service_role;

INSERT INTO app_config (key, value, updated_at)
VALUES ('inventory_platform_flags', '{}'::jsonb, now())
ON CONFLICT (key) DO NOTHING;
