# Production-readiness checklist

Engineering live-pass is not the same as public-release sign-off.
Manual browser-lifecycle checks that cannot be executed reliably in this
environment stay listed here until a human confirms them on a real
Chrome profile. They do **not** block continued engineering.

Do not weaken security, financial correctness, or viewability to close
these items.

## Shared money / privacy (already proven on ChatGPT)

These apply to every platform. Do not re-implement them per site.

- [x] Unique nonce on claims; duplicates return 200 with `duplicate: true`
- [x] Server-side `sessionToken` + minimum wait
- [x] Postgres atomic `settle_impression()`
- [x] ₹10 CPM → 1000 / 600 / 400 micropaise (user 60% / Omni 40%)
- [x] Advertiser debit + user ledger, no duplicate financial rows
- [x] House inventory settles ₹0
- [x] No prompt / response content sent to Omni
- [x] Automated Exchange tests must not mutate the manual ChatGPT campaign

## ChatGPT (`chatgpt.com`)

Engineering PASS (2026-09): generation detection, session, `omni_direct`
selection, paid Sponsored card, one-card enforcement, viewability, exactly
one qualify, Postgres settlement, 1000/600/400 split, advertiser debit,
user ledger, no duplicate money rows, no prompt leakage, responsive
placement (1440×900, 1280×800, 1024×768, 900×900, 800×800), short wait,
dismiss before qualification, end-of-generation cleanup, Back navigation
cleanup, Forward navigation cleanup, broken-logo fallback.

| Check | Status | Notes |
|---|---|---|
| Hidden-tab physical visibility | **DEFERRED MANUAL** | Automation cannot set a real `document.visibilityState === "hidden"`. Must switch away from a real Chrome tab for 7–10s, return, and confirm `qualifySent: false` / no settlement. Not a product failure. |
| Conversation switch | **DEFERRED MANUAL — logged-in session required** | Guest ChatGPT has no history list. Must switch between two real `/c/` (or equivalent) conversations while a card is mounted. |
| Extension reload / stale context | **DEFERRED MANUAL** | Requires reloading the unpacked MV3 extension in the user's Chrome while a house card is active, then refreshing the AI tab. Cursor/automation cannot drive `chrome://extensions`. |
| New Chat (true navigation) | **BLOCKED BY GUEST SESSION** | Guest New Chat opened a sheet/modal and did not change the URL. Do not treat a modal as navigation. Do not hack around authentication. Re-test when logged in. |

## Claude (`claude.ai`)

| Check | Status | Notes |
|---|---|---|
| Probe before generation | PENDING | `adapter=claude`, `platform=claude.ai`, `state=IDLE`, `extensionValid=true` |
| Long generation (house) | PENDING | Detection, session, one house card, placement, viewability, cleanup |
| Responsive UI | PENDING | Wide / medium / narrow |
| Short response | PENDING | No improper settlement |
| Dismiss | PENDING | No qualify |
| SPA / New Chat | PENDING | No orphan card. Prefer Claude adapter + placement strategy. |
| One paid impression | PENDING | ₹10 CPM → 1000/600/400; exactly one qualify, revenue event, user earning, advertiser debit. Use server-returned earning. No prompt content. |
| Hidden tab | DEFERRED MANUAL | Same physical-visibility gate as ChatGPT. |
| Conversation switch | DEFERRED MANUAL | Logged-in Claude session required. |

## Gemini (`gemini.google.com`)

Not started. Do not begin until Claude engineering PASS is reported.

| Check | Status |
|---|---|
| Probe / detection / house card / placement | NOT STARTED |
| Paid settlement regression | NOT STARTED |
| Hidden tab | DEFERRED MANUAL (when live work starts) |
| Conversation switch | DEFERRED MANUAL (when live work starts) |

## Other platforms

Perplexity, Copilot, DeepSeek, Grok, Meta AI, Le Chat, Poe: adapters exist
for host matching only. No live engineering PASS. Do not market as
confirmed inventory.

## Campaign safety

Manual campaign **ChatGPT live paid inventory**:

- Do not reset `spent_micropaise`
- Automated tests must isolate via `OMNI_TEST_MODE` + `__omni_test_*` names
- House-only live checks: keep this campaign **paused**
- Paid ChatGPT retests: reactivate this campaign only; do not touch others
