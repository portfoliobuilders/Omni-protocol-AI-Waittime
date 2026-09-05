# Production-readiness checklist

Engineering live-pass is not the same as public-release sign-off.
Manual browser-lifecycle checks that cannot be executed reliably in this
environment stay listed here until a human confirms them on a real
Chrome profile. They do **not** block continued product development.

Do not weaken security, financial correctness, or viewability to close
these items.

## Phase 3 engineering status

| Platform | Engineering status |
|---|---|
| ChatGPT | **ENGINEERING PASS** |
| Claude | **CODE READY / LIVE VERIFICATION DEFERRED** |
| Gemini | **CODE READY / LIVE VERIFICATION DEFERRED** |
| Perplexity | **CODE READY / LIVE VERIFICATION BACKLOG** |
| Copilot | **CODE READY / LIVE VERIFICATION BACKLOG** |
| DeepSeek | **CODE READY / LIVE VERIFICATION BACKLOG** |
| Grok | **CODE READY / LIVE VERIFICATION BACKLOG** |
| Meta AI | **CODE READY / LIVE VERIFICATION BACKLOG** |
| Mistral | **CODE READY / LIVE VERIFICATION BACKLOG** |
| Poe | **CODE READY / LIVE VERIFICATION BACKLOG** |

Do not claim live verification where it did not occur.
Do not market non-ChatGPT surfaces as confirmed inventory.

Phase 3 engineering is complete enough to continue advertiser-side work.
Remaining items below are a production-readiness track, not an engineering blocker.

Private-pilot target is **not** public Chrome Web Store launch.

Pilot safety controls (code):

- Global paid-inventory kill switch: `POST /api/v1/admin/paid-inventory` and Omni Ads admin
- Platform sponsored-wait kill: `POST /api/v1/admin/platforms/:id/sponsored-wait`
- Surface serving kill: `inventory_surfaces.serving_enabled` (admin inventory toggle)
- Campaign pause / emergency_pause
- Budget exhaustion → house fallback
- Frequency cap: max settled impressions per campaign/user/day
- Duplicate qualification protection
- Backend failure → fail silent / house
- House ads = ₹0

Human checklist: `docs/human-live-test-matrix.md`.

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
      (status, spend, budget, provider, creatives, surfaces)

## ChatGPT (`chatgpt.com`)

**ENGINEERING PASS** (2026-09): generation detection, session, `omni_direct`
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
| New Chat (true navigation) | **DEFERRED MANUAL — logged-in session required** | Guest New Chat opened a sheet/modal and did not change the URL. Do not treat a modal as navigation. Do not hack around authentication. |

## Claude (`claude.ai`)

**CODE READY / LIVE VERIFICATION DEFERRED.** Not failed.

Live engineering in this environment is blocked by login. Claude has no
guest chat. Do not hack around authentication.

SPA path-reset for `/chat/{id}` and `/new` is implemented on the Claude adapter
(unit-tested). ChatGPT's proven `/c/` path is unchanged. This is **not** a live PASS.

| Check | Status | Notes |
|---|---|---|
| Probe before generation | **DEFERRED MANUAL — logged-in session required** | Expected: `adapter=claude`, `platform=claude.ai`, `state=IDLE`, `extensionValid=true` |
| Long generation (house) | **DEFERRED MANUAL — logged-in session required** | Detection, session, one house card, placement, viewability, cleanup. Manual ChatGPT campaign is surface-locked to `chatgpt.com` and must not fill Claude. |
| Responsive UI | **DEFERRED MANUAL** | Wide / medium / narrow |
| Short response | **DEFERRED MANUAL** | No improper settlement |
| Dismiss | **DEFERRED MANUAL** | No qualify |
| SPA / New Chat | **DEFERRED MANUAL — logged-in session required** | Adapter path-reset is coded; not live-proven. |
| One paid impression | **DEFERRED MANUAL** | Use a Claude-targeted campaign. Do not reuse ChatGPT live paid inventory. ₹10 CPM → 1000/600/400. |
| Hidden tab | DEFERRED MANUAL | Same physical-visibility gate as ChatGPT. |
| Conversation switch | DEFERRED MANUAL | Logged-in Claude session required. |

## Gemini (`gemini.google.com`)

**CODE READY / LIVE VERIFICATION DEFERRED.** Adapter exists. No live PASS.

## Other platforms

Perplexity, Copilot, DeepSeek, Grok, Meta AI, Mistral (Le Chat), Poe:
**CODE READY / LIVE VERIFICATION BACKLOG.** Host adapters exist. No live PASS.

## Campaign safety

Manual campaign **ChatGPT live paid inventory**:

- `campaign_surfaces` = `chatgpt.com` only
- Eligible on `chatgpt.com` = YES
- Eligible on `claude.ai` = NO
- Eligible on `gemini.google.com` = NO
- Do not reset `spent_micropaise` (live history must stay intact; do not rewrite past settlements)
- Do not change CPM, budget, provider, or review status in tests
- Automated tests must isolate via `OMNI_TEST_MODE` + `__omni_test_*` names
- House-only live checks on ChatGPT: keep this campaign **paused**
- Paid ChatGPT retests: this campaign only
- Future Claude / Gemini paid tests: create a separate surface-targeted campaign
