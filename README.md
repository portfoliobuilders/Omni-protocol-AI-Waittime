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
