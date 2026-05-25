# Stage-3 Session Checkpoint — 2026-05-25

## What shipped this session

| Commit | Task | Status |
|---|---|---|
| `7628e45` | Task 6a feat | shipped (build broke later) |
| `08d3146` | Task 6a fix — idempotency flip on all paths | shipped |
| `e4d1a0b` | Stripe lazy-init build fix | shipped |
| `c45055b` | Suspense wraps build fix | shipped (5 Stage-3 pages) |
| `1b52474` | Task 8 metadata fix — type/buyerId/rancherId | spec review fix |
| `ca8ca27` | Task 8 orphan-payment hardening | quality review fix |
| `140b5b4` | Task 6b feat — PI succeeded/failed/refunded | shipped |
| `fa49fdf` | Task 6b polish — gate refund Telegram on flip | quality review fix |
| `e874acb` | Task 9 feat — fulfillment confirm + buyer email | shipped |

**Phase 1 sequence progress: Task 2 → 7 → 4 → 5 → 6a → 8 → 6b → 9 → [11 next] → 11.5 → 12 → 10**

8 of 12 Phase 1 tasks done.

## Build pipeline state

All deploys after the build fix are GREEN. Latest: `dpl_7SXujH2JUNLJxpEJUzjFGDxgdvpR` (commit `e874acb`) = READY.

## Self-learning notes from this session

1. **Stripe constructor at module load = Vercel build failure.** `new Stripe(process.env.X || '')` at top-of-file runs during "Collecting page data" phase WITHOUT env vars → throws on empty key. Lazy-init via `getStripeClient()` helper is the only safe pattern. Local `tsc --noEmit` does NOT catch this (runtime constructor throw).

2. **Next.js 16 requires Suspense for useSearchParams() on any prerendered page.** Pattern: default export returns `<Suspense fallback={...}><PageContent /></Suspense>` wrapping the original component.

3. **Stripe metadata routing requires discriminator on BOTH `session.metadata` AND `payment_intent_data.metadata`.** Webhook can deliver either object depending on event type.

4. **Direct-charge model means NO Stripe transfer on fulfillment confirm.** Funds split at charge time via `application_fee_amount`. Connect handles payout to rancher bank on the connected account's payout schedule. Task 9 is purely a status marker + comms trigger.

5. **`markDepositRefunded` returning `{ flipped }` is the right shape** — lets caller distinguish "we updated a deposit row" from "no matching row found." Prevents confusing Telegram alerts for non-deposit refunds.

6. **`recordClose` is NOT idempotent** — does capacity decrement etc. Top-of-handler Stripe Events row IS the dedup guard. Document this when wiring /retry-event admin command.

## Remaining Phase 1 tasks

### Task 11 — setup wizard tier + fulfillment + dashboard banners

Big task. Multi-file. Dispatch to subagent.

Wizard surgery in `app/rancher/setup/RancherSetupWizard.tsx` (1100+ lines, steps 0-6). Inject:
- New step: "Pick Your Plan" (tier selection, links to `/partner/checkout/[tier]`)
- New step: "Fulfillment + Refund Policy" (Fulfillment Types multi-select, Pickup City, Delivery Radius, Shipping Lead Time, Refund Policy textarea ≥20 chars)
- Backend endpoint: PATCH `/api/rancher/setup` extended to persist fulfillment + refund fields (Airtable field IDs in runbook)
- Dashboard banners: 5-state cascade per mockup `docs/mockups/2026-05-25-stripe-flow/rancher/07-dashboard-banners.html`
  - No tier → "Pick your plan" CTA → `/partner`
  - Tier active but Connect not_connected → "Connect your bank" CTA → `/api/rancher/connect/start`
  - Connect onboarding → "Finish KYC" CTA → Connect link
  - Connect restricted → "Banking needs attention" CTA → portal
  - Subscription past_due → "Update payment method" CTA → tier portal

### Task 11.5 — legacy opt-in upgrade

Endpoint + UI for grandfathered legacy ranchers to opt-in to tier_v2. Atomic flip from `Pricing Model='legacy'` → `'tier_v2'` only after Connect onboarding succeeds + tier subscription active. Audit log entry. Telegram celebration.

### Task 12 — admin payments console

`/admin/payments` page. Lists Payments + Payouts. Admin can refund (POST `/api/admin/payments/refund/[paymentId]` — calls Stripe refund API + lib/contracts/payments.markDepositRefunded). Auth via admin password (existing pattern).

### Task 10 — add-on à la carte

`/rancher/billing` already has add-on shop cards (Task 5). Endpoint `/api/rancher/addon/purchase` creates Stripe Invoice for the chosen add-on price ID. Records Add-On Purchases row. Telegram alert.

## Phase 2 (parallel after Phase 1 lands)

Tasks 13, 13.5, 17, 18, 20, 21, 22, 22.5, 23, 24 — research-backed marketing + ops. Per runbook.

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
- Pasture $150 → `price_1Tb3IWGTWWNqassHaIvpNXeC`
- Ranch $350 → `price_1Tb3IyGTWWNqassHynt7qAJn`
- Operator $500 → `price_1Tb3JLGTWWNqassH0UPyua3j`
- Video shoot $2500 → `price_1Tb3JhGTWWNqassHXZ8nSuW5`
- Photo refresh $1500 → `price_1Tb3K4GTWWNqassHvTC4w9KE`
- Founder letter $750 → `price_1Tb3KPGTWWNqassHdBaWY8Z8`

**New Referrals field this session:** `Fulfillment Confirmed At` (`fld2qOXNzngGRU1Eh`, dateTime America/Denver)

**Vercel:**
- Project `prj_UiTlxTHcMl277z0QyrAVz82nclVA`
- Team `team_LtooF0XS8M8oDBUwxphrC1RJ`
- Branch alias `bhc-git-stage-3-verticals-benibeauchman-3168s-projects.vercel.app`

## Constraint reminders for next session

- NEVER push to main. NEVER commit to main. Branch is `stage-3-verticals` only.
- `STRIPE_CONNECT_ENABLED=false` on prod — LIVE Stripe products created but gated. Stays false through Task 12.
- All Stripe V2 SDK calls need `as any` on the resource accessor (not params) due to v20.4.1 type lag.
- Webhook signature verify MUST precede idempotency block (already enforced in current handler).
- Don't modify existing `app/api/webhooks/stripe/route.ts` Stage-1/2 code paths — only add to the switch.
- All Payments + Payouts Airtable writes flow through `lib/contracts/payments.ts`. Direct `createRecord`/`updateRecord` against those tables is a boundary violation.
- Vertical isolation enforced by `tools/check-vertical-boundaries.ts`. Run before commit.
