# OmniPiggy Supabase (Phase 1 foundation)

Placeholder CLI config lives in `config.toml` (`project_id = "omni-piggy-local"`).
Do **not** invent or commit credentials. Put secrets only in local `.env` (gitignored).

## Typical workflow

```bash
supabase login
supabase link --project-ref <PROJECT_REF>
supabase db push
```

Local stack (optional):

```bash
supabase start
supabase db reset   # applies migrations + seed.sql
```

## Layout

- `migrations/` — schema + RLS
- `seed.sql` — `app_config` defaults (bps, view ms, min CPM)
- `functions/` — Edge Functions (empty in Phase 1)

Money amounts are **BIGINT micropaise**. Client/extension code must never hold the service role key.
