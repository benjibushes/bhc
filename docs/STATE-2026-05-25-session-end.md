# Stage-3 Session Checkpoint — 2026-05-25 (UPDATED post-Task-11)

## RESUME ORIENTATION (read this first when context lost)

Branch: `stage-3-verticals`. Latest commit: `c87cbd9` (post-Task-11 polish). Build pipeline GREEN.

**Phase 1 progress: 9 of 12 tasks shipped.**

Sequence done: Task 2 → 7 → 4 → 5 → 6a → 8 → 6b → 9 → 11.
Sequence remaining: **11.5 → 12 → 10**.

Pull latest: `git pull origin stage-3-verticals` and you're caught up.

## What shipped this session

| Commit | Task | Status |
|---|---|---|
| `7628e45` | Task 6a feat | shipped (build broke after) |
| `08d3146` | Task 6a fix — idempotency flip on all paths | shipped |
| `e4d1a0b` | **BUILD FIX 1** — lazy-init Stripe client | shipped |
| `c45055b` | **BUILD FIX 2** — Suspense wraps for Next.js 16 prerender | shipped |
| `1b52474` | Task 8 spec fix — metadata.type discriminator | shipped |
| `ca8ca27` | Task 8 quality fix — orphan-payment hardening | shipped |
| `140b5b4` | Task 6b feat — PI succeeded/failed/refunded handlers | shipped |
| `fa49fdf` | Task 6b polish — gate refund Telegram on flip | shipped |
| `e874acb` | Task 9 feat — fulfillment confirm + buyer email | shipped |
| `8afdb19` | Session checkpoint doc | shipped |
| `e410f1c` | Task 11 feat — wizard tier/fulfillment + dashboard banners | shipped |
| `c87cbd9` | Task 11 polish — server-side validation + broader broken-sub banner | shipped |

All deploys after `42d4b30` (Task 2) through `c87cbd9` (current) are now GREEN on Vercel. The ERROR deploys in the middle (`37f252a` through `e4d1a0b`) were fixed by lazy-init + Suspense wraps. Don't revert those.

## Build pipeline state

Latest deploy: `dpl_ANttB56AY5gu758DAPWiiakqqNHr` (commit `e410f1c`) = READY. The polish commit `c87cbd9` deployed after; check Vercel for live status if needed.

## Self-learning notes from this session

1. **Stripe constructor at module load = Vercel build failure.** `new Stripe(process.env.X || '')` at top-of-file runs during "Collecting page data" phase WITHOUT env vars → throws on empty key. Lazy-init via `getStripeClient()` helper is the only safe pattern. Local `tsc --noEmit` does NOT catch this (runtime constructor throw).

2. **Next.js 16 requires Suspense for useSearchParams() on any prerendered page.** Pattern: default export returns `<Suspense fallback={...}><PageContent /></Suspense>` wrapping the original component.

3. **Stripe metadata routing requires discriminator on BOTH `session.metadata` AND `payment_intent_data.metadata`.** Webhook can deliver either object depending on event type.

4. **Direct-charge model means NO Stripe transfer on fulfillment confirm.** Funds split at charge time via `application_fee_amount`. Connect handles payout to rancher bank on the connected account's payout schedule. Task 9 is purely a status marker + comms trigger.

5. **`markDepositRefunded` returning `{ flipped }` is the right shape** — lets caller distinguish "we updated a deposit row" from "no matching row found." Prevents confusing Telegram alerts for non-deposit refunds.

6. **`recordClose` is NOT idempotent** — does capacity decrement etc. Top-of-handler Stripe Events row IS the dedup guard. Document this when wiring /retry-event admin command.

7. **Wizard step ordering trick (Task 11):** new steps wedged in as 7+8 between existing step 4 (Call) and step 5 (Sign) so `setStep(...)` call sites stay unchanged. Traversal: 0→1→2→3→4→7→8→5→6. Comment block warns future devs. Visible labels relabeled to "Step 5 / 6 of 6" matching the mockup.

8. **Treat subscription `trialing` as paying-state everywhere.** Wizard TierPickStep unlocks on active OR trialing; dashboard banners ALSO honor trialing now (post-Task-11 polish). One consistent rule across the codebase.

9. **Broken subscription states grouped:** `past_due | unpaid | incomplete | incomplete_expired | canceled` all map to one red banner that adapts copy. Prevents silent fallthrough where rancher sees no banner but leads still paused.

## Remaining Phase 1 tasks

### Task 11.5 — legacy opt-in upgrade

Endpoint + UI for grandfathered legacy ranchers to opt-in to tier_v2. Atomic flip from `Pricing Model='legacy'` → `'tier_v2'` only AFTER:
- Connect onboarding succeeds (`Stripe Connect Status === 'active'`)
- Tier subscription active (`Subscription Status` in {active, trialing})

Audit log entry on flip. Telegram celebration. Probably a `/api/rancher/legacy-upgrade` endpoint + a banner card on `/rancher` dashboard for legacy ranchers showing "Upgrade to a tier and get marketing + bank deposits" CTA.

### Task 12 — admin payments console

`/admin/payments` page. Lists Payments + Payouts. Admin can refund:
- POST `/api/admin/payments/refund/[paymentId]` — calls Stripe refund API + `lib/contracts/payments.markDepositRefunded`
- Auth via admin password (existing pattern in other admin routes)

### Task 10 — add-on à la carte

`/rancher/billing` already has add-on shop cards (Task 5). Build:
- POST `/api/rancher/addon/purchase` — creates Stripe Invoice for chosen add-on price ID (Pasture+ ranchers only? or all tier_v2? confirm scope)
- Records Add-On Purchases row (table `tblebGHKDzRMc9epT`)
- Webhook already extended in Task 6a `invoice.paid` to mark Add-On Purchases status=paid when `addOnPurchaseId` metadata is present
- Telegram alert to admin

Add-on price IDs (LIVE):
- Video shoot $2500 → `price_1Tb3JhGTWWNqassHXZ8nSuW5`
- Photo refresh $1500 → `price_1Tb3K4GTWWNqassHvTC4w9KE`
- Founder letter $750 → `price_1Tb3KPGTWWNqassHdBaWY8Z8`

## Phase 2 (parallel after Phase 1 lands)

Tasks 13, 13.5, 17, 18, 20, 21, 22, 22.5, 23, 24 — research-backed marketing + ops. Per runbook at `docs/EXECUTION-RUNBOOK.md`. Can be dispatched in parallel once Phase 1 is fully done.

## Critical IDs

**Airtable base:** `appgLT4z009iwAfhs`

**Tables:**
- Ranchers `tbl08y9Be45zNG0OG`
- Referrals `tblBfimb4Gt8C0fu4`
- Consumers `tblAbjQDnLrOtjpoE`
- Payments `tblPfESJ4lxwtGThy`
- Payouts `tbl2lEnCbz0o3VqbH`
- Add-On Purchases `tblebGHKDzRMc9epT`
- Stripe Events `tblPiw7jB7Mm7OxeN`

**Stripe price IDs (LIVE mode):**
- Pasture $150/mo → `price_1Tb3IWGTWWNqassHaIvpNXeC`
- Ranch $350/mo → `price_1Tb3IyGTWWNqassHynt7qAJn`
- Operator $500/mo → `price_1Tb3JLGTWWNqassH0UPyua3j`
- Video shoot $2500 → `price_1Tb3JhGTWWNqassHXZ8nSuW5`
- Photo refresh $1500 → `price_1Tb3K4GTWWNqassHvTC4w9KE`
- Founder letter $750 → `price_1Tb3KPGTWWNqassHdBaWY8Z8`

**Stripe account:** `acct_1TSn5PGTWWNqassH` (platform). Connect uses V2 (`acct_*` doubles as customer_account + connected-account).

**New Referrals field this session:** `Fulfillment Confirmed At` (`fld2qOXNzngGRU1Eh`, dateTime America/Denver)

**Vercel:**
- Project `prj_UiTlxTHcMl277z0QyrAVz82nclVA`
- Team `team_LtooF0XS8M8oDBUwxphrC1RJ`
- Branch alias `bhc-git-stage-3-verticals-benibeauchman-3168s-projects.vercel.app`

## Files changed in Task 11 (for next session orientation)

- `app/rancher/setup/RancherSetupWizard.tsx` — added TierPickStep + FulfillmentStep components, step traversal rewired
- `app/api/rancher/setup/route.ts` — PATCH whitelist + server-side validation on Refund Policy/Delivery Radius/Shipping Lead Time; GET exposes Tier + Subscription Status + Pricing Model
- `app/rancher/page.tsx` — DashboardBannerCascade component with 5 banner states
- `app/api/rancher/dashboard/route.ts` — GET exposes pricingModel + tier + subscriptionStatus + connectStatus

## Constraint reminders for next session

- NEVER push to main. NEVER commit to main. Branch is `stage-3-verticals` only.
- `STRIPE_CONNECT_ENABLED=false` on prod — LIVE Stripe products created but gated. Stays false through Task 12.
- All Stripe V2 SDK calls need `as any` on the resource accessor (not params) due to v20.4.1 type lag.
- Webhook signature verify MUST precede idempotency block (already enforced in current handler).
- Don't modify existing `app/api/webhooks/stripe/route.ts` Stage-1/2 code paths — only add to the switch.
- All Payments + Payouts Airtable writes flow through `lib/contracts/payments.ts`. Direct `createRecord`/`updateRecord` against those tables is a boundary violation.
- Vertical isolation enforced by `tools/check-vertical-boundaries.ts`. Run before commit.
- All Stripe client construction lazy-init via `getStripe()` / `getStripeClient()`. NEVER `new Stripe(...)` at module top.
- Client pages using `useSearchParams()` MUST wrap default export body in `<Suspense fallback={...}>` for Next.js 16 prerender.
- Subscription `trialing` status is treated as paying-state everywhere. Match this rule when adding new gates.

## Workflow used this session

Per `superpowers:subagent-driven-development`:
1. Implementer dispatched as subagent with locked context
2. Spec compliance review subagent (read-only)
3. If issues → fix inline OR re-dispatch implementer → re-review
4. Code quality review subagent (read-only)
5. If issues → fix inline → mark task complete
6. Repeat for next task

Build verify after each commit (Vercel deploy status check via MCP). Lazy-init + Suspense fixes caught via this loop after user flagged "preview deployments failing."
