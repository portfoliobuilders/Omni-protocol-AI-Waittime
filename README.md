# OmniPiggy / Omni Protocol

[![CI](https://github.com/portfoliobuilders/Omni-protocol-AI-Waittime/actions/workflows/ci.yml/badge.svg)](https://github.com/portfoliobuilders/Omni-protocol-AI-Waittime/actions/workflows/ci.yml)

OmniPiggy is a Chrome extension that detects genuine AI generation wait time on supported AI sites, shows a **Sponsored Wait**, and (in later phases) settles advertiser-funded revenue **60% user / 40% Omni**.

There is **no fixed ₹2/₹10 reward**, **no claim button**, and **no Mindful Break / breathing UX**.

## Product map

| Product | Role |
|---------|------|
| **OmniPiggy** | Consumer Chrome / AI extension |
| **Omni Ads** | Advertiser platform |
| **Omni Monetize** | Publisher / developer SDK |
| **Omni Exchange** | Auction, settlement, attribution (Supabase-backed) |

## Phase 1 status

- Supabase foundation schema + RLS live under `supabase/`
- Integer **micropaise** accounting utilities under `shared/money/`
- Railway production URLs removed from extension / SDK defaults
- Legacy SQLite Express backend remains for local CI + historical migration only

## Environment

Copy `.env.example` — placeholders only:

```bash
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
OMNI_API_BASE=http://localhost:3001
```

Never put service-role keys in the extension.

### Supabase CLI (you run these — credentials are yours)

```bash
supabase login
supabase link --project-ref <PROJECT_REF>
supabase db push
```

See `supabase/README.md`.

## Run the legacy local backend (SQLite — migration bridge)

```bash
cd backend-core
npm install
npm run dev
```

Listens on **http://localhost:3001**. Ledger file: `omni-ledger.db` (not production destination).

## Build & load the extension

```bash
cd client-extension
npm install
npm run build
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `client-extension/dist`

**IMPORTANT:** After every extension reload, refresh every open AI tab.

## Money utilities

```bash
cd backend-core
npm run test:money
```

Verifies ₹10 CPM → 1000 micropaise/impression → 600 / 400 split.

## SQLite → Supabase migration (dry-run)

```bash
npx tsx scripts/migrate-sqlite-to-supabase.ts --dry-run
```

Refuse test DBs; no secrets committed. Execute mode requires your service-role env (see script help).

## API (legacy local)

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/health` | Liveness |
| `GET` | `/api/v1/config` | Platform config (share bps, min wait) |
| `POST` | `/api/v1/session/start` | Server wait session |
| `POST` | `/api/v1/yield` | **Deprecated** fixed-reward path (smoke only) |
| `GET` | `/api/v1/balance/:userId` | Wallet balance |

## Testing

```bash
cd backend-core
npm run typecheck
npm run build
npm run smoke          # against local server

cd ../client-extension && npm run build
cd ../b2b-sdk && npm run build
```

```bash
SMOKE_URL=http://localhost:3001 SMOKE_ADMIN_KEY=your-admin-key npm run smoke
```

## Troubleshooting

- **Port 3001 in use** — stop the other Node process, then `npm run dev` again.
- **"Extension context invalidated"** — reload the extension, then refresh AI tabs.
- **Popup shows API offline** — start `backend-core` on localhost:3001.
