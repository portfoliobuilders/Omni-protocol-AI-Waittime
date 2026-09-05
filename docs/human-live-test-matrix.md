# Human live-test matrix (private pilot)

Do **not** automate these against live AI websites from this environment.
Do **not** reuse or reset the production campaign **ChatGPT live paid inventory**.

ChatGPT is the only surface that has already had a paid live settlement. Claude and Gemini remain **code-ready until a human confirms them**.

## Before any paid live test

1. Reload the unpacked extension from `client-extension/dist`.
2. Refresh every open AI tab.
3. Confirm backend is the Postgres Exchange (`SUPABASE_URL` set; not SQLite-only).
4. Confirm the ChatGPT live campaign is **paused** unless you are intentionally retesting ChatGPT paid inventory.
5. For Claude/Gemini paid tests: create a **new** surface-locked campaign. Enable that surface’s `serving_enabled` only for the test window, then turn it back off.

## ChatGPT outstanding (deferred from Phase 3)

| # | Test | How | Expected |
|---|---|---|---|
| 1 | Hidden tab | Start a generation with a sponsored card, switch away for 7–10s so the tab is truly hidden, return | No qualify, no advertiser debit, no user earning |
| 2 | Logged-in conversation switch | Two real `/c/` conversations; switch while a card is mounted | Old session cleaned, no duplicate card, no accidental settlement |
| 3 | Extension reload mid-session | Reload unpacked MV3 on `chrome://extensions` while a generation/session exists, then refresh the AI tab | Fails safe; no request storm; no late settlement |
| 4 | True New Chat navigation | Logged-in New Chat that **changes the URL** (not a modal) | Old state cleared; new generation creates one clean session |

## Claude (only after a Claude-only campaign exists)

Create a campaign with `campaign_surfaces = claude.ai` and `targeting_mode = specific`. Do not use ChatGPT inventory.

Test: detection → session → paid card → viewability → single qualify → settlement → advertiser debit → user ledger → SPA conversation switch → generation cleanup.

Also: hidden tab, dismiss, short wait, one-generation-one-ad.

**Do not mark Claude live PASS until a human completes this list.**

## Gemini (only after Claude passes)

Separate Gemini-only campaign (`gemini.google.com`). Same matrix as Claude.

## Funnel to watch (Postgres / telemetry, not a demo dashboard)

detected → session → ad returned → rendered → viewable → qualified → settled

House fallback must produce **₹0** user earning and **no** advertiser debit.
