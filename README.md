# OmniPiggy / Omni Protocol

[![CI](https://github.com/portfoliobuilders/Omni-protocol-AI-Waittime/actions/workflows/ci.yml/badge.svg)](https://github.com/portfoliobuilders/Omni-protocol-AI-Waittime/actions/workflows/ci.yml)

Omni is a **verified AI attention advertising exchange**.

Advertiser-funded paid impression → verified wait-time viewability → atomic Postgres settlement → **60% user / 40% Omni**.

There is **no fixed ₹2/₹10 reward**, **no claim button**, **no Mindful Break / breathing UX**, and **no surveys as the product**. House ads settle at ₹0.

**ChatGPT is the only live-proven inventory surface.** Other adapters exist in code; they are not verified until a human live-test passes.

## Product map

| Product | Role |
|---------|------|
| **OmniPiggy** | Consumer Chrome extension (sponsored wait) |
| **Omni Ads** | Advertiser portal (`ads-portal/`, served at `/advertise`) |
| **Omni Exchange** | Postgres settlement, wallets, campaign serving |

## Architecture (canonical)

- **Supabase Postgres** is the only production financial ledger (micropaise integers).
- The browser never calculates or requests a payout amount.
- Extension money calls: content script → `chrome.runtime.sendMessage` → background worker → API.
- SQLite (`backend-core`, `omni-ledger.db`) is **legacy only**: migration tooling and historical tests. Consumer SQLite money/ad/survey routes return **410**.
- Pilot advertiser funding is **manual admin credit**. There is no Stripe/Razorpay in this phase.

## Environment

Copy `.env.example` to `backend-core/.env`. Required to boot:

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Never put the service-role key in the extension.

Local stack: `npx supabase start` (Docker required). See `supabase/README.md`.

## Run the Exchange API

```bash
cd backend-core
npm install
npm run dev
```

Listens on **http://localhost:3001**. Postgres must be configured; the process refuses to start without it.

## Advertiser portal (Omni Ads)

```bash
cd ads-portal
npm install
npm run build
```

Source lives in `ads-portal/src`. `ads-portal/dist` is a build artifact, not the source of truth.

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

## Tests

```bash
cd backend-core
npm run typecheck
npm run test:money
npm run test:targeting
npm run test:exchange:pg   # local Supabase; never mutates ChatGPT live paid inventory
npm run test:ads           # local Supabase; Omni Ads lifecycle

cd ../client-extension
npm run typecheck
npm run test:unit
npm run build
```

Do **not** reset the production campaign named `ChatGPT live paid inventory`.

## Human live tests

See `docs/human-live-test-matrix.md` and `docs/production-readiness.md`. Hidden-tab, conversation-switch, extension-reload, and Claude/Gemini paid live checks require a human Chrome session.

## Troubleshooting

- **Port 3001 in use** — stop the other Node process, then `npm run dev` again.
- **"Extension context invalidated"** — reload the extension, then refresh AI tabs.
- **Popup shows API offline** — start `backend-core` with a valid Supabase `.env`.
- **Docker / supabase status fails** — start Docker Desktop, then `npx supabase start`.
