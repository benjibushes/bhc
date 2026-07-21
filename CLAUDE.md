# BHC — session orientation (auto-loaded)

**FIRST ACTION every session: read `docs/HANDOFF-<latest>.md`** (currently
`docs/HANDOFF-2026-07-19.md`, addendum at top). It is the single source of
truth for current state, open bugs, and build order. Update it before ending
any session that changed anything.

## One session = ONE lane. Declare it, stay in it.
- **OPS** — business operations (lookups, resends, call lists, closes). Use the
  `bhc-ops` / `bhc-flow-debug` skills. Never build features here.
- **BUILD** — exactly one PR-sized item from the handoff build order. Test,
  merge, update handoff, END the session. Never start a second build item.
- **AUDIT** — incidents. `bhc-audit` / `bhc-cron-debug`, read-only. Findings go
  in the handoff; a separate BUILD session fixes them.

If the conversation drifts to another lane, say so and recommend a fresh session.

## Hard rules (each one earned from a real failure)
1. **Read the Airtable schema before asserting anything about a field.** Never
   guess field names (`Deposit Link` ≠ `Deposit Checkout URL`; `Commission
   Amount` ≠ `Commission Paid`). A blank field usually means NOTHING WRITES IT,
   not that the event didn't happen. This caused 5 wrong diagnoses in one night.
2. **Money-path truth gets persisted, not just logged.** Any send/open/paid
   outcome writes a stamp to the record.
3. **Never email raw Stripe checkout URLs** (24h expiry). Durable `/r/p/` links
   only.
4. **Run real `next build`, not just tsc**, before merging route/page changes.
   (~1-in-3 Vercel builds die on a transient Airtable prerender timeout — retry once.)
5. **Never batch-flip ranchers** (Active Status / Pricing Model) without Ben's
   per-rancher OK — relationships.
6. **Before bulk Airtable mutations or mass sends:** use the
   `bhc-mutation-guardrails` skill. No exceptions.
7. Verify claims with live probes before reporting something as broken. Two
   audit-script bugs produced false alarms in one session.

## Facts that don't change often
- Airtable base `appgLT4z009iwAfhs` is shared by this repo AND
  `~/bhc-prospects-dashboard` (rancher outreach machine; local git only,
  deploys via `vercel deploy --prod --yes`).
- This repo: PR flow (`gh pr create` → `gh pr merge --squash --admin`); direct
  push to main is blocked.
- Vercel "Sensitive" env vars pull as BLANK but are set at runtime — never
  diagnose one as missing from a pull.
- North-star metric: **payable ranchers** (Active + can take money). Each ≈
  +$162/mo. $10k/mo ≈ 60.
