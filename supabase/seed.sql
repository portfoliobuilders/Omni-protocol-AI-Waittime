-- OmniPiggy seed data (non-secret platform config only).
-- Applied via: supabase db reset  (or seed during local start)

INSERT INTO app_config (key, value, updated_at) VALUES
  ('user_revenue_share_bps', '6000'::jsonb, now()),
  ('omni_revenue_share_bps', '4000'::jsonb, now()),
  ('minimum_qualified_view_ms', '5000'::jsonb, now()),
  ('minimum_cpm_inr', '10'::jsonb, now())
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = now();
