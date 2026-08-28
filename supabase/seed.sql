-- OmniPiggy seed data (local helper only).
-- Production-critical defaults are inserted in migration
-- 20260827130000_exchange_money_engine.sql (ON CONFLICT DO NOTHING).
-- Do NOT rely on this file alone for production financial config.

INSERT INTO app_config (key, value, updated_at) VALUES
  ('user_revenue_share_bps', '6000'::jsonb, now()),
  ('omni_revenue_share_bps', '4000'::jsonb, now()),
  ('minimum_qualified_view_ms', '5000'::jsonb, now()),
  ('minimum_cpm_micropaise', '1000000'::jsonb, now()),
  ('max_impressions_per_campaign_user_day', '20'::jsonb, now()),
  ('minimum_repeat_interval_seconds', '30'::jsonb, now())
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = now();
