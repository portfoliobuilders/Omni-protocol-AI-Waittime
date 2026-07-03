# OmniPiggy

OmniPiggy is a Chrome extension that detects AI generation wait time on claude.ai and chatgpt.com, shows a "Mindful Break" box, and lets the user claim micro-dividends that are credited to a persistent SQLite ledger via a local Node.js backend.

## Run the backend

```bash
cd backend-core
npm install
npm run dev
```

The server listens on **http://localhost:3001**. The ledger persists to `omni-ledger.db`.

## Build & load the extension

```bash
cd client-extension
npm install
npm run build
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `client-extension/dist` folder

**IMPORTANT:** After every extension reload, refresh any open claude.ai/chatgpt.com tabs.

## API endpoints

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/health` | Liveness check |
| `POST` | `/api/v1/yield` | Body: `userId`, `amount`, `layer`, `nonce` — nonce must be unique per claim; duplicates return 200 with `duplicate: true` |
| `GET` | `/api/v1/balance/:userId` | Returns the user's current balance |
| `GET` | `/api/v1/transactions/:userId?limit=N` | Returns recent transactions (default limit 25, max 100) |

## Troubleshooting

- **Port 3001 in use** — Run `taskkill /F /IM node.exe`, then `npm run dev` again in `backend-core`.
- **"Extension context invalidated" error** — Reload the extension on `chrome://extensions`, then refresh any open AI chat tabs.
- **Popup shows "Bank offline"** — The backend isn't running. Start it with `npm run dev` in `backend-core`.
- **Balance shows but no activity** — Rebuild the extension (`npm run build` in `client-extension`) and reload it on `chrome://extensions`.

## Testing

Automated smoke tests verify the full API surface (health, claims, surveys, ads, redemption guards, admin routes, partner attribution). Run against a local dev server or production:

```bash
cd backend-core
npm run dev          # in another terminal, if testing locally

# Local (default http://localhost:3001)
npm run smoke

# Production or staging with admin coverage
SMOKE_URL=https://omni-protocol-ai-waittime-production.up.railway.app SMOKE_ADMIN_KEY=your-admin-key npm run smoke
```

- `SMOKE_URL` — base URL (default `http://localhost:3001`)
- `SMOKE_ADMIN_KEY` — optional; when set, also verifies admin endpoints, partner flow, and redemptions list. Without it, those checks are skipped with `WARN`.

Exit code is nonzero on any `FAIL`. Use this at the end of every dev session instead of a manual checklist.
