# Omni engineering rules

Omni is a **verified AI attention advertising exchange**.

Current economic model:

Advertiser-funded paid impression → verified wait-time viewability → atomic Postgres settlement → **60% user / 40% Omni**.

## Hard invariants

- One AI generation → at most one ad → at most one paid impression.
- If the wait is too short, the tab is hidden, the user dismisses the card, qualification fails, settlement fails, or the generation ends before qualification: **no advertiser charge, no user earning**.
- House inventory settles at **₹0**.
- The browser must **never** calculate or request a payout amount.
- Do not read ChatGPT/Claude prompts, answers, conversation text, or general browsing history. Targeting is inventory/surface context (e.g. “ChatGPT wait”), not prompt content.

## Money ledger

- **Supabase Postgres is the only production financial source of truth.**
- All new advertiser funding, campaign spend, impression settlement, user earnings, and redemption write to Postgres.
- SQLite (`backend-core` / `omni-ledger.db`) is **legacy only**: compatibility, migration tooling, isolated historical tests. It is not the v2 money ledger.
- Financial amounts use integer **BIGINT micropaise**. Do not introduce floating-point currency accounting.
- Settlement is database-atomic via `settle_impression()`. Duplicate qualification must not debit twice.
- Never reset, modify, delete, reseed, or use the production campaign named **ChatGPT live paid inventory** in automated tests (`spent_micropaise` history must remain).

## Extension architecture

Financial HTTP calls originate only through:

content script → `chrome.runtime.sendMessage` → background worker → API.

Content scripts must be guarded with `isExtensionContextValid()`. Direct `fetch` to money APIs does not belong in the content script.

## Inventory honesty

ChatGPT is the only network surface currently **live-proven**. Other adapters existing in code is not enough to market them as verified. Claude / Gemini paid tests require **separate surface-locked campaigns** — never reuse the ChatGPT live campaign.

## Do not add in this phase

IDE/Cursor/VS Code inventory, publisher SDK v2, RTB/auctions, AdMob/AdSense networks, referrals, points, streaks, crypto, DePIN, surveys as product, or conversion tracking.

## Product UX (do not regress)

Sponsored label, dismiss control, sponsored-waits opt-out, Shadow DOM isolation, compact → expanded presentation, quiet earnings feedback, cleanup after generation, no forced clicking, no blocking AI usage.
