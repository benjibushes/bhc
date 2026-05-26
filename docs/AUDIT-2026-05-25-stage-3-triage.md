# Stage-3 Post-Build Audit — Triage

Compiled 2026-05-25 after 4-pass audit (functional / regression / CX / research). See `docs/AUDIT-2026-05-25-research-d2c-best-practices.md` for the full industry-benchmark research.

## Status

Phase 1 = 12/12 SHIPPED. Audit landed 5 critical fixes already (commits `7d62535` + `49b95f4`). 7 remaining items grouped below by priority.

## Already Fixed This Session

| Commit | Fix | Surface |
|---|---|---|
| `7d62535` | Tier_v2 commission double-charge — skip legacy invoice at 5 sites + cron | quick-action / referrals PATCH / confirm-payment / telegram / commission-invoices cron |
| `49b95f4` | Closed-referral re-pay block + tier_v2 fulfillment gate + post-purchase welcome | /api/checkout/deposit / /api/rancher/fulfillment/confirm / Stripe webhook |

These were the highest-cost-to-business bugs (every tier_v2 close double-billed; buyer could pay twice; missing email = lost retention signal; legacy fallback let tier_v2 confirm fulfillment for free).

## BLOCKING — Must Fix Before Tier_V2 Prod Traffic

### B1. Buyer has no path from intro email to deposit page
**Surface:** `lib/email.ts:876` `sendBuyerIntroNotification` CTA points to `/ranchers/[slug]/contact`, not `/checkout/[refId]/deposit`. Buyer literally cannot reach the deposit page from any current outbound email.

**Fix:** Add a "Reserve with deposit" CTA to the intro email pointing to `/checkout/[referralId]/deposit`. Combined with B2 below.

**Effort:** 1 PR. Email template edit + magic-link integration.

### B2. Buyer locked out of deposit endpoint without member-session
**Surface:** `app/api/checkout/deposit/route.ts:42-49` requires `bhc-member-auth` cookie. Buyer from `/access` signup gets a Consumer row + intro email but no auto-login + no magic-link in the intro. The only paths to set the cookie are `/api/auth/member/verify` (consume magic-link token) or `/api/auth/member/login` (request one).

**Fix:** Include a magic-link token in the deposit-CTA URL (intro email side). Server-side `/api/auth/member/verify?token=...&next=/checkout/[refId]/deposit` lands buyer on deposit page already authed.

**Effort:** 1 PR. Token generation + email template edit + verify route's `next` param.

### B3. No Stripe Connect webhook endpoint for V2 account events
**Surface:** `ls app/api/webhooks/` shows only `stripe/`. Connect account.requirements.updated + capability_status_updated events have no handler. Result: rancher finishes Stripe Express onboarding → `Stripe Connect Status` field never auto-flips on Airtable → `/rancher` dashboard banner cascade shows "Connect bank →" forever. `/rancher/billing` does a live Stripe read so looks correct, but home dashboard stays broken.

**Fix:** New `/api/webhooks/stripe-connect/route.ts` listening to V2 thin events. Same idempotency pattern (Stripe Events table). On `v2.core.account.requirements.updated`: re-read status via `getConnectAccountStatus(account.id)` → write to `Stripe Connect Status` field. Configure Connect webhook endpoint in Stripe Dashboard.

**Effort:** 1 PR + Stripe Dashboard config. Reuses existing Stripe Events idempotency pattern + getConnectAccountStatus helper.

### B4. Rancher dashboard has no "Confirm Fulfillment" UI
**Surface:** `/api/rancher/fulfillment/confirm` endpoint exists (Task 9), but `grep -n "fulfillment" app/rancher/page.tsx` returns zero hits. Endpoint unreachable from any UI. Step 10 of rancher flow can never fire from `/rancher`.

**Fix:** Add "Confirm Fulfillment" button to each Closed Won referral card on `/rancher`. Optional rancher note field. POST `/api/rancher/fulfillment/confirm`.

**Effort:** 1 PR. Just UI wiring + already-built endpoint.

## IMPORTANT — Fix in Next 1-2 Sessions

### I1. Rate limits missing on tier/select + checkout/deposit
**Surface:** `app/api/rancher/tier/select/route.ts` + `app/api/checkout/deposit/route.ts`. Both create Stripe sessions. No throttle. Burst-creating Checkout Sessions on rapid F5 = Stripe rate-limit risk + orphan pending Payments rows.

**Fix:** Wrap with existing rate-limit helper (3-5/min per user).

### I2. Idempotency-check failure on webhook continues
**Surface:** `app/api/webhooks/stripe/route.ts:82`. If Airtable is down, idempotency check fails BUT handler proceeds + fails to write the dedupe row → Stripe retries → potential double-processing. `markDepositSucceeded` is idempotent but `recordClose` is not — would double-decrement capacity.

**Fix:** Return 503 on idempotency-check failure so Stripe retries; or treat Airtable down as "skip processing." Belt-and-suspenders: gate `recordClose` on prevStatus already being ACTIVE_REF_STATES (it does — verify the guard catches this).

### I3. Wizard step 7/8 has no legacy-rancher skip
**Surface:** `app/rancher/setup/RancherSetupWizard.tsx:1175`. Legacy ranchers entering /rancher/setup get pushed through TierPickStep + FulfillmentStep. Step 7 button stays locked. They're stuck unless they hit back-arrow.

**Fix:** Short-circuit step 7 entry: `if (rancher['Pricing Model'] === 'legacy' && !rancher['Tier']) { onContinue() }`. OR add "Skip — stay legacy" link on the step.

### I4. Stripe Connect onboarding has zero BHC branding
**Surface:** `lib/stripeConnect.ts:35-58` (createConnectAccount). No business_profile.url, no logo, no brand color. Rancher who picked tier on BHC-branded page suddenly lands on raw Stripe form. Trust hit.

**Fix:** Add `business_profile.url='https://buyhalfcow.com'` to account create payload. Configure Connect branding in Stripe Dashboard (logo, color, business name) — operator-only.

### I5. Misleading "we hold no funds" copy on deposit page
**Surface:** `app/checkout/[refId]/deposit/page.tsx:213`. Says "We hold no funds at BuyHalfCow" but `lib/stripeConnect.ts:128-150` does take 7%/3%/0% via application_fee_amount. Not deceptive (rancher signs off on the cut + covers it in their price), but the copy reads wrong if a buyer asks the rancher.

**Fix:** Either remove the line OR change to "BuyHalfCow's commission is paid by the rancher — covered in their listed price."

### I6. Refund policy verbatim with no BHC softener
**Surface:** `app/checkout/[refId]/deposit/page.tsx:202-207`. Rancher writes "NO REFUNDS NO EXCEPTIONS" → buyer sees it word-for-word. Trust hit.

**Fix:** Append "For disputes, BuyHalfCow can mediate — reply to your match thread." below rancher's verbatim text. Combined with research recommendation **R1 (BHC Promise floor)** this is the single biggest trust unlock for paid ad traffic.

### I7. Add-on orphan draft invoice on partial-fail
**Surface:** `app/api/rancher/addons/purchase/route.ts:182-191`. If finalize fails after items + invoice created, the draft sits on Stripe with no back-link. Airtable row marked failed, but Stripe side stays draft.

**Fix:** Wrap invoice creation in try/catch with `stripe.invoices.voidInvoice` rollback on partial-fail.

## RESEARCH-DRIVEN PRE-AD-LAUNCH FIXES

From `docs/AUDIT-2026-05-25-research-d2c-best-practices.md`:

### R1. BHC-funded 7-day satisfaction guarantee + cold-chain promise
**Effort:** 2-3 PR. Copy + admin tooling + reserve fund accounting.
**Impact:** Biggest single trust unlock for cold-acquisition Meta ads. Crowd Cow + ButcherBox both have this.

### R2. ~~Verify Stripe Connect loss controller~~
**ALREADY VERIFIED SAFE.** `lib/stripeConnect.ts:45` sets `losses_collector: 'stripe'`. Chargebacks debit rancher Connect account; Stripe (not BHC) covers shortfalls.

### R3. T-7 / T-1 / Day+14 / Day+45 email automations
**Effort:** 1-2 PR. Existing email cron + new helpers in lib/email.ts.
**Impact:** Existing-customer flows convert at 60-70% vs 13% cold. Maps to Klaviyo replenishment standard.

### R4. Deposit page mobile-first redesign
**Effort:** 1 PR. Hero photo above CTA, ETA window, named-rancher provenance, trust cluster, single CTA.
**Impact:** Mobile + above-the-fold + named-customer count = +45% conversion lift trigger.

### R5. $49 sampler funnel for cold acquisition
**Effort:** 2-3 PR. New product tier + landing page + Stripe price ID + sampler-to-share funnel.
**Impact:** AOV-to-CVR math at $500+ on Meta is brutal (<1% CVR). Sampler-to-share is the proven D2C beef playbook (Force of Nature, Snake River Farms).

## Sequencing Recommendation

**Before paid ads launch:**
1. B1 + B2 (buyer can reach deposit page) — without these, NOTHING ELSE matters
2. B3 + B4 (Connect webhook + Fulfillment UI) — rancher dashboard reflects truth
3. R1 (BHC Promise floor) — biggest conversion lift
4. R4 (deposit page mobile redesign) — 45% lift trigger
5. I6 (refund policy softener) — defensive trust fix

**After paid ads launch (compound):**
6. R3 (T-7/T-1/D+14/D+45 emails) — existing-customer retention multiplier
7. R5 ($49 sampler funnel) — cold-acquisition entry that converts at sane CVR

**Defer:**
- I1-I5, I7 — important but not load-bearing for first $10k in ads
- Phase 2 tasks (13, 17-24) — research-backed infra additions

## Verification Notes

Audit A confirmed-clean paths (don't waste effort re-checking these):
- Signup → matching/suggest auto-route (proper failure-alerting + retry queue + state machine)
- Connect onboarding endpoint (JWT auth + idempotent account creation + persist before link)
- Tier select endpoint (refuse-if-active gate + V2 customer_account)
- Webhook idempotency (Stripe Events table + 200 on handler errors)
- payment_intent.succeeded handler (markDepositSucceeded + recordClose + Telegram sequence)
- recordClose contract (capacity + buyer stage + thread close + funnel event)
- /rancher/setup PATCH whitelist + validation
- Billing dashboard (banner cascade + payouts table + add-on shop + live Stripe read)
- recordDeposit failure aborts redirect (no orphan PI)

Audit B confirmed Stage-3 did NOT break:
- legacy commission flow (createCommissionInvoice gated on tier_v2 skip now)
- existing webhook paths (founder, brand listing, founder-subscription cancel)
- buyer signup + matching + intro emails
- map/discovery (no Pricing Model filters added)
- founder + brand-partner Stripe flows

Audit C confirmed comms hygiene CLEAN:
- guardedSend wrap on all 54 send helpers including new ones
- 24h hard gate in email-sequences cron
- Sequence Stage flip prevents replay
- Partner checkout auth gate clear
- Fulfillment-confirm idempotency
- Telegram admin chat NOT overloaded (~30 msgs/day at scale)
- /admin/payments empty-state clean
