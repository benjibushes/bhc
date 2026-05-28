# Stripe Connect Express + Tiered Rancher Subscription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three-tier rancher subscription model (Pasture $150/mo + 7% commission, Ranch $350/mo + 3%, Operator $500/mo + 0%) on top of Stripe Connect Express so the platform owns the deposit, splits funds per-tier on close, bills monthly subscriptions, and offers à la carte add-ons — all on the `stage-3-verticals` branch with prod merge gated behind canary verification.

**Architecture:**
- Each rancher row gets a `Tier` (singleSelect: Pasture / Ranch / Operator) and a `Stripe Subscription Id` (the monthly fee subscription on the platform).
- Per-tier commission rate is the source of truth for `application_fee_amount` on each deposit Checkout Session. Operator ranchers route deposits with 0 fee; Stripe transfers 100% to their Connect account.
- Fulfillment confirm releases a payout from the platform's commission pool — automated for Operator (no-op since 100% already transferred) and explicit for Pasture/Ranch (where the 7%/3% commission was retained as platform fee).
- Add-ons are one-off Stripe Invoices, billed independent of tier. Tracked in a new `Add-Ons` table.
- `/partner` page rebuilds as a 3-tier comparison + add-on menu + live counters.
- Tier upgrades/downgrades route through `/api/rancher/tier/change` which proration-bills the difference via Stripe.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Stripe (Connect Express + Subscriptions + Checkout + Invoices + Customer Portal), Airtable, JWT for rancher session.

**Conventions:**
- Continue on `stage-3-verticals` branch. NO prod merge until Task 13 canary verification.
- Canary env flag `STRIPE_CONNECT_ENABLED=false` until canary; preview-only flip-on for testing.
- Every task: type-check clean → commit → push → smoke against Vercel preview.
- BHC has no Jest. Smoke = curl/UI + Stripe Dashboard test-mode card 4242.

---

## Pricing structure (the locked spec)

| Tier | Monthly | Commission | Promise |
|------|---------|------------|---------|
| Pasture | $150 | 7% | We send you buyers |
| Ranch | $350 | 3% | We send you buyers AND make sure they see you first |
| Operator | $500 | 0% | We send you buyers, position you, and run your marketing |

**Add-ons (à la carte, any tier):**
- Custom on-site video shoot: $2,500 + travel
- Annual brand photo refresh: $1,500
- Founder-letter campaign (3-email sequence): $750
- Brand partner intro + negotiation: 15% of the deal
- PPC management for direct site: 15% of ad spend, $500/mo minimum

**Tier perks (locked, written to `/partner`):**
- Pasture: green-pin map listing, custom landing page, auto matching, intro emails, reply tracking, capacity controls, monthly newsletter mention, 5-min self-serve onboarding
- Ranch: + priority routing, quarterly listing rewrite, social case study post per close, featured in 1 founder letter per quarter, /wins inclusion, monthly performance review, brand partner first-dibs
- Operator: + 2 reels/mo, 1 founder-voice email/mo, listing fully managed, quarterly YouTube long-form feature, brand partner warm-handoff, quarterly 1:1 with Ben, zero commission, podcast first-call

**Operator SLA (lock in plain English on /partner):**
*"2 reels + 1 email + listing updates + quarterly call. Anything beyond that is a separate project quote."*

---

## Business Model — Scope Discipline (locked)

The scariest mistake at this phase is scope creep into shipping / fulfillment / customer-service infrastructure. Lock the boundary here before any code lands.

### What BuyHalfCow IS

1. **Marketing engine** — verified-listing on map, custom landing page per rancher, automated buyer matching, founder-letter newsletter, social proof distribution.
2. **Lead capture** — `/access` quiz, intent scoring, state-based routing, capacity gating per rancher.
3. **Deposit holder** — Stripe Connect direct charge. Buyer pays through BHC; funds split between rancher's Connect account (93% / 97% / 100% by tier) and platform commission pool (7% / 3% / 0%). Buyer sees one branded checkout; rancher sees one payout statement.
4. **Trust intermediary** — buyer trusts BHC because BHC handles the money + has the public proof wall (`/wins`). Rancher trusts BHC because Stripe (not BHC) holds the funds + sends to their bank.
5. **Communication routing** — buyer ↔ rancher Threads (already shipped Tasks 7-10) with email mirror + inbound routing + Telegram visibility for operator.

### What BuyHalfCow is NOT (for this build)

| Out of scope | Why | Who handles it |
|--------------|-----|----------------|
| Shipping logistics | No carrier integration, no cold-chain infrastructure, no label generation | Rancher arranges directly with buyer via Threads |
| Processing scheduling | Each rancher uses different USDA processor on different windows | Rancher posts processing date on their landing page; buyer sees it before deposit |
| Pickup coordination | Local pickup, local delivery, drop-off points — too varied to systematize yet | Rancher arranges via Threads / phone after deposit |
| Refunds | Complex per-rancher policy; legal + tax implications | Manual via Stripe Dashboard for v1; rancher's policy text shown to buyer before deposit |
| Customer service post-deposit | Buyer's question about cut sheet, hanging weight, freezer space | Rancher's responsibility; BHC Threads is the channel |
| Tax forms for rancher | 1099-K, sales tax, ag exemption | Stripe Connect handles 1099-K automatically; rancher handles state-level sales tax / ag exemption per their state |
| Insurance / spoilage / loss in transit | No carrier liability product | Out of scope — rancher's policy |

**The product = "deposit holder + marketing engine."** Anything past that is the rancher's deal. This discipline keeps platform liability narrow + operationally tractable.

### Rancher-side fulfillment data shown to buyer BEFORE deposit

So the buyer makes an informed payment decision without BHC owning logistics, we surface the rancher's setup on the deposit page:

- **Fulfillment Type** (multiselect) — `Local Pickup` / `Local Delivery` / `Cold-Chain Shipping` (rancher picks one or more)
- **Pickup City** + **Delivery Radius Miles** (if local)
- **Next Processing Date** + **Shipping Lead Time Days** (if shipping)
- **Refund Policy** (rancher writes their own, ≤500 chars; shown verbatim under "Before you pay")
- **Pickup / Delivery / Shipping Cost Notes** — optional rancher-written line for extras (e.g. "Cooler shipping $45")

The deposit page shows: rancher's price + rancher's fulfillment info + rancher's refund policy → buyer pays the deposit. After payment, buyer + rancher continue in the Thread to arrange delivery details.

### Legacy rancher path — grandfather + opt-in upgrade

Existing performers (Sackett, High Lonesome, Ashcraft, Hewitson, ZK Ranches, etc.) keep their current model unless they opt in to a tier. This protects revenue continuity.

**Implementation:**
- New Ranchers field `Pricing Model` (singleSelect): `legacy` / `tier_v2`
- All existing ranchers default to `legacy` via a one-time backfill (Task 1 Step 6)
- Legacy ranchers:
  - Keep using their existing Payment Links on landing pages
  - Continue 10% commission via post-close `commission-invoices` cron (unchanged)
  - Don't see tier-pick step in setup wizard
  - DO see a one-time opt-in banner on their dashboard: "Upgrade to a tier with marketing perks · See /partner"
- New ranchers:
  - `Pricing Model = tier_v2` set at signup
  - Tier-pick is required before going live
  - Stripe Connect onboarding flow runs after tier-pick
  - Buyer deposit flow only opens when both `Tier != None` AND `Stripe Connect Status = active`

**Migration policy:** legacy rancher who opts in:
1. Picks tier on `/partner`
2. Stripe Connect onboard runs (V2 API)
3. `Pricing Model` flips to `tier_v2`
4. Old Payment Links on landing page get auto-replaced with BHC checkout buttons
5. Existing referral history stays — historic Sale Amount / Commission Due / Closed At rows untouched

**Reverse migration NOT supported.** Once on `tier_v2`, can't downgrade back to `legacy`. Document in operator playbook.

### Money flow summary

```
Buyer pays $400 deposit (Quarter Cow from a Ranch-tier rancher)
   │
   ▼
Stripe Checkout Session (mode: 'payment')
   • destination_charge with stripeAccount header = rancher's acct_*
   • application_fee_amount = 12_00 cents (3% of $400)
   │
   ▼
Stripe splits:
   • $388 → rancher's Connect account balance (97%)
   • $12  → BHC platform commission balance (3%)
   │
   ▼
On rancher's "Confirm Fulfillment" click:
   • Stripe payout from rancher's Connect balance → rancher's bank (Stripe handles transfer schedule)
   • Platform's $12 stays in BHC's main Stripe balance (paid out to BHC's bank on Stripe's standard schedule)
   │
   ▼
Monthly subscription (separate flow, runs in parallel):
   • Rancher's Tier subscription ($150/$350/$500) charges rancher's saved payment method
   • Subscription customer_account = same acct_* (V2 unifies)
   • Funds flow rancher's account → BHC platform main account on the 1st of each month
```

**Two payment streams:** transactional commission per close (real-time, per-tier) + monthly subscription (recurring, flat). Both billed via Stripe; both visible in admin payments dashboard.

---

<!-- AIRTABLE-IDS — created 2026-05-25 via Airtable MCP on appgLT4z009iwAfhs
TABLES (existing + new from Task 1):
  Ranchers          : tbl08y9Be45zNG0OG
  Consumers         : tblAbjQDnLrOtjpoE
  Referrals         : tblBfimb4Gt8C0fu4
  Threads           : tblIuMAlScXBTNF5w   (Task 7 baseline)
  Thread Messages   : tbl5ORgGghoqabyXr   (Task 7 baseline)
  Funnel Events     : tblpm57rUJJT103l2   (Task 2 baseline)
  Payments          : tblPfESJ4lxwtGThy   (Task 1 stage-3)
  Payouts           : tbl2lEnCbz0o3VqbH   (Task 1 stage-3)
  Add-On Purchases  : tblebGHKDzRMc9epT   (Task 1 stage-3)
  Stripe Events     : tblPiw7jB7Mm7OxeN   (Task 1 stage-3)

NEW RANCHERS FIELD IDS (Task 1):
  Pricing Model                 : fldaIFuo7rCSQvHP6
  Tier                          : fldPY17Titdz4S0EN
  Stripe Subscription Id        : fldJaOgCoQNkHuuMl
  Subscription Status           : fldapRsuf6ITnWJkV
  Subscription Started At       : fldR3vip22BKA6wEV
  Subscription Next Invoice At  : fldP6ZkH4QreqlFy9
  Stripe Connect Account Id     : fldrUOFCKOXQBA40x
  Stripe Connect Status         : fldTdzuQp2sYIlsqV
  Stripe Connect Connected At   : fldaofYC2bcbhLWlX
  Fulfillment Types             : fldvaMCn1ZlAP66OA
  Pickup City                   : fld8mbzIPdZh1NPna
  Delivery Radius Miles         : fld5T3P6sR9IUgAv6
  Shipping Lead Time Days       : fldk282GhxCkc1fZf
  Refund Policy                 : fldAxqGkbCSSTWuMX
  Fulfillment Cost Notes        : fldnhUCDOBljUJX23
  First Payout Celebrated At    : fld8MRiO1aRG1IUJz
  Tier Upgrade Nudge Sent At    : fld2eNbxzO9AzzYPz
  Tier Abandoned Recovery At    : fldErK3OgWGqxTYr0

BACKFILL: 64/64 existing ranchers set Pricing Model='legacy' via batched
update_records_for_table on 2026-05-25 — protects existing performers
from accidental tier_v2 path.
-->

<!-- STRIPE-IDS — created 2026-05-25 via Stripe MCP on acct_1TSn5PGTWWNqassH (LIVE mode)
TIER SUBSCRIPTIONS (recurring monthly):
  Pasture  · prod_UaDjcxTLJgoblh · price_1Tb3IWGTWWNqassHaIvpNXeC · $150/mo
  Ranch    · prod_UaDkkVbIpp1ceb · price_1Tb3IyGTWWNqassHynt7qAJn · $350/mo
  Operator · prod_UaDkDg1aeV38mO · price_1Tb3JLGTWWNqassH0UPyua3j · $500/mo

ADD-ON PRODUCTS (one-time):
  Video Shoot     · prod_UaDlkbPgjnQmOj · price_1Tb3JhGTWWNqassHXZ8nSuW5 · $2,500
  Photo Refresh   · prod_UaDlRFwseE37T8 · price_1Tb3K4GTWWNqassHvTC4w9KE · $1,500
  Founder Letter  · prod_UaDljHPDbVVmSF · price_1Tb3KPGTWWNqassHdBaWY8Z8 · $750

Set these on Vercel Preview env (then prod when canary unlocks):
  STRIPE_PASTURE_PRICE_ID=price_1Tb3IWGTWWNqassHaIvpNXeC
  STRIPE_RANCH_PRICE_ID=price_1Tb3IyGTWWNqassHynt7qAJn
  STRIPE_OPERATOR_PRICE_ID=price_1Tb3JLGTWWNqassH0UPyua3j
  STRIPE_ADDON_VIDEO_PRICE_ID=price_1Tb3JhGTWWNqassHXZ8nSuW5
  STRIPE_ADDON_PHOTO_PRICE_ID=price_1Tb3K4GTWWNqassHvTC4w9KE
  STRIPE_ADDON_FOUNDER_LETTER_PRICE_ID=price_1Tb3KPGTWWNqassHdBaWY8Z8

Brand Intro (15% of deal) + PPC Mgmt (15% + $500/mo min) NOT created — manual billing for v1.
3 perm-test products in account flagged for cleanup (prod_URhMlTT4gOV6IO, prod_URh8Ib9Edjglxf, prod_URh61K4OzhZJGD).
-->

## Stripe V2 API Reference (locked — supersedes earlier plan drafts)

Stripe's official integration prompt (2026-05) directs us to use the **V2 Accounts API** for Connect onboarding. V2 unifies Express / Standard / Custom into a single `account` object with `configuration.merchant` + `configuration.customer` capability blocks. This is the API we build against. Older `type: 'express'` / `type: 'standard'` patterns from V1 are obsolete.

### Account creation (V2)

```ts
const account = await stripeClient.v2.core.accounts.create({
  display_name: rancher.operatorName,
  contact_email: rancher.email,
  identity: { country: 'us' },
  dashboard: 'full',                          // V2 full-dashboard equivalent of Express
  defaults: {
    responsibilities: {
      fees_collector: 'stripe',                // Stripe handles platform fees
      losses_collector: 'stripe',              // Stripe handles dispute losses
    },
  },
  configuration: {
    customer: {},                              // Enable as customer (subscription billing recipient)
    merchant: {
      capabilities: {
        card_payments: { requested: true },    // Enable as merchant (accept buyer deposits)
      },
    },
  },
});
// returns { id: 'acct_XXX', ... } — store on Ranchers.Stripe Connect Account Id
```

**Never pass `type:` at top level. V2 rejects it.**

### Account Links (V2 onboarding)

```ts
const accountLink = await stripeClient.v2.core.accountLinks.create({
  account: rancher.stripeConnectAccountId,
  use_case: {
    type: 'account_onboarding',
    account_onboarding: {
      configurations: ['merchant', 'customer'],
      refresh_url: `${SITE_URL}/rancher/billing`,
      return_url: `${SITE_URL}/rancher/billing?onboarding=done`,
    },
  },
});
// returns { url: 'https://connect.stripe.com/...' } — redirect rancher
```

### Account status read (V2)

```ts
const account = await stripeClient.v2.core.accounts.retrieve(
  rancher.stripeConnectAccountId,
  { include: ['configuration.merchant', 'requirements'] },
);
const cardPaymentsActive =
  account?.configuration?.merchant?.capabilities?.card_payments?.status === 'active';
const reqStatus = account.requirements?.summary?.minimum_deadline?.status;
const onboardingComplete = reqStatus !== 'currently_due' && reqStatus !== 'past_due';
```

**For this integration we always read account state from the API — never trust a cached field.** Airtable's `Stripe Connect Status` is a UI hint that gets refreshed by the webhook, not a source of truth.

### Thin event webhooks (V2)

V2 emits `thin` events — payload is just `{ id, type }`. To get full event data, retrieve via `stripeClient.v2.core.events.retrieve(thinEvent.id)`.

```ts
const thinEvent = client.parseThinEvent(req.body, sig, webhookSecret);
const event = await client.v2.core.events.retrieve(thinEvent.id);
// event.type drives handler:
//   v2.core.account[requirements].updated
//   v2.core.account[configuration.merchant].capability_status_updated
//   v2.core.account[configuration.customer].capability_status_updated
//   v2.core.account[.recipient].capability_status_updated
```

Local dev listener:
```bash
stripe listen \
  --thin-events 'v2.core.account[requirements].updated,v2.core.account[configuration.merchant].capability_status_updated,v2.core.account[configuration.customer].capability_status_updated' \
  --forward-thin-to http://localhost:3000/api/webhooks/stripe-connect
```

### V2 subscription on connected account

V2 unifies customer + connected account ID. **The connected account IS the customer.**

```ts
const session = await stripeClient.checkout.sessions.create({
  customer_account: rancher.stripeConnectAccountId,  // acct_XXX (NOT cus_XXX)
  mode: 'subscription',
  line_items: [{ price: process.env.STRIPE_PASTURE_PRICE_ID, quantity: 1 }],
  success_url: `${SITE_URL}/rancher/billing?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${SITE_URL}/partner/checkout/pasture?canceled=1`,
});
```

On subscription webhook: `subscription.customer_account` returns `acct_*` (not `subscription.customer`). All V2-account-keyed reads use `customer_account`.

Billing Portal:
```ts
const portal = await stripeClient.billingPortal.sessions.create({
  customer_account: rancher.stripeConnectAccountId,
  return_url: `${SITE_URL}/rancher/billing`,
});
```

### Direct charges with application fee (buyer deposits → connected rancher)

```ts
const session = await stripeClient.checkout.sessions.create(
  {
    mode: 'payment',
    line_items: [{ price_data: depositPriceData, quantity: 1 }],
    payment_intent_data: {
      application_fee_amount: platformFeeCents,  // 7% / 3% / 0 based on rancher tier
    },
    success_url: `${SITE_URL}/checkout/${referralId}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${SITE_URL}/checkout/${referralId}/deposit`,
  },
  {
    stripeAccount: rancher.stripeConnectAccountId,  // Stripe-Account header for direct charge
  },
);
```

Same pattern applies to product create / list on rancher's connected account: pass `{ stripeAccount: acct_XXX }` as the second arg.

### General tips locked from Stripe prompt

- Always create a `stripeClient` instance (don't use bare `stripe.*` calls).
- The SDK auto-sets API version `2026-04-22.dahlia`. Don't override unless pinning intentionally.
- For V2 accounts, `subscription.customer_account` returns `acct_*` IDs. Don't try `subscription.customer.id` on V2 — it doesn't exist.
- Application fee on direct charges goes in `payment_intent_data.application_fee_amount` (cents).
- Test mode webhook events fire from Stripe Dashboard "Send test webhook" button.

---

## Operator setup (Task 0 — one-time, run via Stripe MCP from inside Claude Code)

**Why MCP-driven:** plan executor (me or subagent) has Stripe MCP access. Don't ask user to click through dashboard — create products + prices programmatically, copy IDs into Vercel env in one pass.

- [ ] **Step 1: Audit existing products via Stripe MCP**

```
mcp__...__list_products(limit=50)
```

As of 2026-05-25 the BUYHALFCOW account (`acct_1TSn5PGTWWNqassH`) has 13 products:
- 3 Brand partner tier products (`prod_URoKVpIoMzWGUM`, `prod_URoK3HPW9xWTMu`, `prod_URoKANkkJN19bC`)
- 7 Founding Herd backer products (`prod_URhN*`)
- 3 perm-test cruft products (`prod_URhMlTT4gOV6IO`, `prod_URh8Ib9Edjglxf`, `prod_URh61K4OzhZJGD`) — delete after verification

NO rancher subscription products yet. Confirmed gap.

- [ ] **Step 2: Create 3 tier subscription products via Stripe MCP**

```
mcp__...__create_product(name="Rancher · Pasture", description="Pasture tier — verified listing + auto buyer matching. $150/mo + 7% commission.")
mcp__...__create_price(product=<id from above>, unit_amount=15000, currency="usd", recurring={interval: "month"})
```

Repeat for Ranch ($350) and Operator ($500). Capture all 3 product IDs + 3 price IDs in this doc as a `<!-- STRIPE-IDS -->` HTML comment block before proceeding.

- [ ] **Step 3: Create 3 add-on one-off products via Stripe MCP**

```
mcp__...__create_product(name="Rancher Add-On · Custom Video Shoot")
mcp__...__create_price(product=<id>, unit_amount=250000, currency="usd")  # one-off
```

Repeat for Photo Refresh ($1,500) and Founder Letter ($750). Note: Brand Intro (15% of deal) + PPC Mgmt (15% + $500 min) are NOT created here — they're manual billing for v1.

- [ ] **Step 4: Activate Connect Express on platform**

User confirmed Connect profile created. Verify capabilities are activated by retrieving the platform account:
```
mcp__...__get_stripe_account_info()
```
Returns `acct_1TSn5PGTWWNqassH`. Confirm Connect enabled at https://dashboard.stripe.com/connect/accounts/overview.

- [ ] **Step 5: Create webhook endpoints in Stripe Dashboard**

Two endpoints, both pointing at preview deploy first (`bhc-git-stage-3-verticals-...vercel.app`):
- Platform: `/api/webhooks/stripe` (existing — extend in Task 6)
  - Events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `payment_intent.succeeded`, `application_fee.created`
- Connect (THIN events): `/api/webhooks/stripe-connect` (new — Task 6)
  - Payload style: `Thin`
  - Events: `v2.core.account[requirements].updated`, `v2.core.account[configuration.merchant].capability_status_updated`, `v2.core.account[configuration.customer].capability_status_updated`, `v2.core.account[.recipient].capability_status_updated`

Copy each endpoint's signing secret. Set on Vercel **Preview env only** initially:
- `STRIPE_WEBHOOK_SECRET` (already exists for platform — verify still valid)
- `STRIPE_CONNECT_WEBHOOK_SECRET` (new — Connect endpoint thin-events secret)

- [ ] **Step 6: Set price IDs on Vercel Preview env**

7 vars total (use Vercel CLI or dashboard):
- `STRIPE_PASTURE_PRICE_ID`
- `STRIPE_RANCH_PRICE_ID`
- `STRIPE_OPERATOR_PRICE_ID`
- `STRIPE_ADDON_VIDEO_PRICE_ID`
- `STRIPE_ADDON_PHOTO_PRICE_ID`
- `STRIPE_ADDON_FOUNDER_LETTER_PRICE_ID`
- `STRIPE_CONNECT_ENABLED=true` (preview only — keep prod at `false`)

Production env stays `STRIPE_CONNECT_ENABLED=false` until Task 16 canary.

- [ ] **Step 7: Resend Inbound — verify `thread-` prefix routes**

Send synthetic email to `thread-recXXXXXXXXXXXXXX@replies.buyhalfcow.com` from a personal address. Verify `/api/webhooks/resend-inbound` receives it and posts into the corresponding Thread Messages row (Task 10 already deployed on baseline).

---

## Research-backed Onboarding Flow Spec

**Audience profile (locked from BHC.md + ops experience):**
- D2C beef ranchers running ~5-50 head pasture operation
- 80% over age 45, rural broadband, mobile-first
- Skeptical of "platforms" — many burned by Etsy/Amazon/marketplace fees
- Decision pattern: **"show me a real rancher who got paid recently"** beats every other persuasion lever
- Often onboarding from a tractor cab or kitchen table on phone
- Tax-conscious (Form 1099-K threshold + ag-specific deductions)
- Prefer text/email over phone calls (Telegram/SMS opens 80%+; calls open 20%)

**Research backing for each design choice:**

| Stage | Friction | Research basis | Design response |
|-------|---------|----------------|-----------------|
| Public /partner | "Is this real?" | Social proof + recency (Cialdini, peak-end rule) | Live counter "X ranchers paid this month · $Y total". Pin most recent close at top. |
| Tier pick | Choice paralysis (Schwartz) | Default-bias + anchoring | Pre-highlight "Most ranchers start with Pasture · upgrade anytime." Anchor Operator at top so $150 looks cheap. |
| Subscription Checkout | $150 entry friction | Hyperbolic discounting + loss aversion | Frame as "Your first lead lands in <state> within 48 hours · cancel anytime if it's not a fit." |
| Stripe Connect KYC | "Why do they need my SSN?" | Trust transfer + authority bias (Cialdini) | Pre-step explainer card: "Same identity check PayPal + Square use. Federal law (KYC) — every payments platform requires this. Stripe holds your data, not BHC. Takes ~5 min." |
| Bank account verify | Drop-off (industry avg 30% at this step) | Goal gradient + sunk cost | Progress bar showing "4 of 5 steps complete · 90 seconds to first payout-ready." |
| Activation moment | Long wait until first sale | Endowment + peak-end | Auto-celebrate: "🐂 Live on the map" Telegram alert + email + ranch slug pinned at top of dashboard within 30s of webhook flip. |
| First lead | "Will they actually pay me?" | Loss aversion frame | "Buyer reserved at $X deposit. Stripe holds it until you confirm delivery. You see the money in your bank in 48h." |
| First payout | Skepticism of platform | Trust by proof (Lindy effect) | After first payout lands: email + Telegram with screenshot of Stripe payout statement + "Here's what just hit your bank: $X." |

**Onboarding sequence (locked):**

### Stage 1 — Discovery (public, no account)
- `/partner` page loads with: 3 tier cards · live counter row · most-recent-close case study card · Operator SLA · add-on menu (collapsed)
- CTA: each tier card has "Get Started — $X/mo" button
- Click → check session cookie → if not logged in, redirect to `/rancher/login?return=/partner/checkout/<tier>`

### Stage 2 — Account creation (existing flow, slightly extended)
- Existing `/rancher/setup` wizard runs. Captures: Operator Name, Ranch Name, Email, Phone, State, Beef Type, Capacity, Slug.
- NEW step inserted AFTER slug: **"Pick your plan"** with 3 cards. Already-chosen tier from /partner is pre-selected. Continue button = "Start <Tier> · $X/mo"
- Click → POST `/api/rancher/tier/select` → Stripe Checkout (subscription mode, `customer_account` = rancher's connected account ID — see Stage 3 caveat)

**CAVEAT:** Subscription on connected account requires the connected account to exist FIRST. So we actually create the V2 connected account here BEFORE Checkout, then pass its `acct_*` ID as `customer_account` to Checkout. Subscription billing target = the rancher's own connected account (V2 unifies these). Order:

  1. POST `/api/rancher/tier/select` body: `{ tier }`
  2. Server: `stripeClient.v2.core.accounts.create({...})` → get `acct_XXX`
  3. Server: write `Stripe Connect Account Id = acct_XXX` to Ranchers row immediately
  4. Server: `stripeClient.checkout.sessions.create({ customer_account: acct_XXX, mode: 'subscription', ... })`
  5. Return checkout URL → rancher pays for tier

### Stage 3 — Stripe Connect KYC (HIGHEST DROP-OFF — most attention here)
- On Stripe Checkout success (return_url hits `/partner/checkout/<tier>?session_id=cs_xxx`):
  - Show interstitial: **"One more step · Connect your bank to receive payouts."**
  - **CRITICAL** explainer card BEFORE the Stripe Account Link:
    > **Why this step?**
    > By federal law (KYC), any platform that handles payments must verify the operator's identity before sending money. Stripe (not BHC) holds your data.
    > **What you'll need (~5 min):**
    > • Your legal name + SSN or EIN
    > • Bank account routing + account number
    > • Photo ID (driver's license)
    > • Date of birth + address
    > Same flow PayPal, Square, and DoorDash use. You can pause and resume anytime.
  - Single button: **"Continue with Stripe →"**
  - Click → POST `/api/rancher/connect/start` → `stripeClient.v2.core.accountLinks.create({...})` → redirect to Stripe-hosted onboarding
- On return from Stripe (`?onboarding=done`): redirect to `/rancher/billing` with status check

### Stage 4 — Live activation moment
- Webhook `v2.core.account[configuration.merchant].capability_status_updated` fires with `card_payments.status === 'active'`
- Server reads requirements: `currently_due` empty? `past_due` empty?
- If yes:
  - Flip `Active Status` → `Active`, `Page Live` → `true`
  - Trigger launch warmup cron (existing `triggerLaunchWarmup` lib helper) — fires intro emails to waitlisted buyers in their state
  - Fire celebration email to rancher: "🐂 You're live · Your page: buyhalfcow.com/ranchers/<slug>"
  - Fire Telegram alert: "🐂 NEW RANCHER LIVE · <name> in <state> · tier <X>"

### Stage 5 — First lead (24-72h)
- Existing matching engine routes a buyer to them
- Email arrives w/ quick-action buttons + link to `/rancher` dashboard
- Dashboard banner pinned: "🎉 Your first lead from BHC · Reply within 24h gets 3× close rate"

### Stage 6 — First deposit (when buyer pays)
- Buyer hits `/checkout/<refId>/deposit` → Stripe Checkout w/ tier-based application fee
- `payment_intent.succeeded` webhook fires
- Funnel Event `deposit_paid` written
- Rancher gets email + Telegram: "💵 Deposit confirmed · <buyer> paid $X · Confirm fulfillment within 14 days to receive payout."

### Stage 7 — First payout (after fulfillment confirm)
- Rancher hits "Confirm fulfillment" button on `/rancher` dashboard
- Server fires payout via V2 (transfer on connected account)
- Webhook `payout.paid` confirms
- Email + Telegram to rancher with screenshot of Stripe statement: "💰 $X just hit your bank account · This was BuyHalfCow buyer #N · Your lifetime BHC payout: $Y."
- THIS is the magic moment — trust unlocked. Subsequent payouts have higher LTV because the rancher saw the first one land.

### Stage 8 — Habit loop (recurring)
- After 3 closed deals: email triggers "Want to upgrade tier? Here's what Ranch unlocks at your volume."
- After 5 closed deals: nudge for testimonial → goes on `/wins` + social
- Monthly cron sends "Your X-month BHC summary: $Y total payout, $Z saved in commission vs Etsy" — recurring loss-aversion lever to keep them subscribed

**Anti-patterns blocked:**

- ❌ No "demo" or "preview" before paying — kills trust ("show me real ranchers, not vapor demos")
- ❌ No "we'll review your application" — autonomous routing in <30s after Connect activate
- ❌ No phone calls in onboarding — rancher should never have to call us; if they want to, give them a 5-min Calendly link in dashboard ("Stuck? Book a 5-min call.")
- ❌ No Long Forms™ — every step has ≤5 fields. Defer profile completion to AFTER they're earning.
- ❌ No "verify by uploading W9" before earning — Stripe Connect handles tax forms post-payout (1099-K issued at threshold).

**Operator monitoring (Telegram cockpit):**
- New rancher signup → Telegram alert (existing)
- Tier picked → NEW: "🎯 <name> picked <tier> ($X/mo)"
- KYC started → NEW: "🔐 <name> started Stripe onboarding"
- KYC complete → "🐂 NEW RANCHER LIVE" (existing pattern, extend)
- 7-day Telegram digest: # ranchers in each pipeline stage (signups / tier-picked / KYC-started / KYC-complete / live)

---

## File Structure (locked)

**New files:**
- `lib/tiers.ts` — single source of truth for tier definitions (price, commission, slug, perks, Stripe price id env var)
- `lib/stripeConnect.ts` — Stripe Connect helpers (createConnectAccount, createOnboardingLink, createDepositCheckout w/ per-tier fee, releaseToRancher, billAddOn)
- `lib/stripeSubscription.ts` — tier subscription helpers (createTierSubscription, changeTier, cancelTier)
- `app/api/rancher/tier/select/route.ts` — initial tier pick → Stripe Checkout Subscription
- `app/api/rancher/tier/change/route.ts` — upgrade/downgrade → proration-billed subscription update
- `app/api/rancher/tier/portal/route.ts` — Stripe Customer Portal session (manage card / cancel)
- `app/api/rancher/connect/start/route.ts` — initiate Connect Express OAuth (only enabled post-subscription-active)
- `app/api/rancher/connect/callback/route.ts` — OAuth callback (Stripe redirects here post-onboarding)
- `app/api/rancher/addons/purchase/route.ts` — one-off add-on Stripe Invoice
- `app/api/rancher/fulfillment/confirm/route.ts` — rancher confirms delivery → release payout
- `app/api/checkout/deposit/route.ts` — buyer deposit Checkout Session (tier-aware fee)
- `app/api/webhooks/stripe-connect/route.ts` — `account.updated` handler
- `app/partner/page.tsx` — public 3-tier comparison + add-on menu
- `app/partner/checkout/[tier]/page.tsx` — landing after Stripe Checkout success
- `app/rancher/billing/page.tsx` — tier status + Stripe Customer Portal link + add-on shop + payout history
- `app/checkout/[refId]/deposit/page.tsx` — buyer deposit page
- `app/checkout/[refId]/success/page.tsx` — post-deposit confirmation
- `app/admin/payments/page.tsx` — admin overview: per-tier MRR, payouts pending, payouts paid

**Modified files:**
- `lib/contracts/payments.ts` — add `tier` field to deposit + payout types; tier-aware payout amount calc
- `lib/contracts/rancher.ts` — `recordClose` reads tier from Ranchers row, emits funnel event with tier metadata
- `app/api/webhooks/stripe/route.ts` — handle `customer.subscription.created/updated/deleted`, `invoice.paid`, `payment_intent.succeeded` for deposits, `application_fee.created`
- `app/api/rancher/setup/route.ts` — onboarding wizard adds Tier-select step (between rancher profile and Connect bank link)
- `app/rancher/page.tsx` — dashboard header shows tier badge + monthly fee + connect status; pending action banner if Connect not active
- `vercel.json` — add new cron `payout-reconcile` (daily 11 UTC) for stuck payouts
- `tools/check-vertical-boundaries.ts` — add `app/partner/` to buyer vertical (public page) OR shared (no consumer/rancher gating on the public page)

**Airtable schema additions (Task 1 below adds via MCP):**
- Ranchers fields:
  - `Pricing Model` (singleSelect: `legacy` / `tier_v2`) — backfill all existing ranchers to `legacy`
  - `Tier` (singleSelect: Pasture / Ranch / Operator / None) — `tier_v2` ranchers only
  - `Stripe Subscription Id` (text)
  - `Subscription Status` (singleSelect: trialing / active / past_due / canceled / unpaid / none)
  - `Subscription Started At` (datetime)
  - `Subscription Next Invoice At` (datetime)
  - `Stripe Connect Account Id` (text)
  - `Stripe Connect Status` (singleSelect: not_connected / onboarding / active / restricted)
  - `Stripe Connect Connected At` (datetime)
  - **NEW fulfillment fields shown to buyer pre-deposit:**
  - `Fulfillment Types` (multipleSelects: `Local Pickup` / `Local Delivery` / `Cold-Chain Shipping`)
  - `Pickup City` (text)
  - `Delivery Radius Miles` (number)
  - `Shipping Lead Time Days` (number) — typical processing → ship window
  - `Refund Policy` (multilineText, ≤500 chars) — rancher writes their own; shown verbatim on deposit page
  - `Fulfillment Cost Notes` (multilineText) — optional extras line (e.g., "Cooler shipping $45")
- `Payments` table (already specced in earlier plan — Task 1 creates)
- `Payouts` table (already specced — Task 1 creates)
- `Add-On Purchases` table:
  - `Id`, `Rancher` (link), `Type` (singleSelect: Video / Photo / Founder Letter / Brand Intro / PPC), `Amount Cents`, `Stripe Invoice Id`, `Status` (pending / paid / canceled), `Purchased At`, `Notes`

---

## What we already shipped (Tasks 0-10 + hardening on `stage-3-verticals`)

Baseline ready for Stripe Connect to layer onto:

- ✅ 4 verticals separated (Data / Buyer / Rancher / Admin) + boundary checker enforces no cross-imports
- ✅ Contracts module (`lib/contracts/*`) — every state mutation has typed entry point
- ✅ Funnel telemetry (`lib/funnelMetrics.ts` + `Funnel Events` Airtable table) — every transition logged
- ✅ Buyer signup + engage route through contracts
- ✅ Rancher close paths emit funnel events (4 entry points: dashboard / quick-action / Telegram close-reply / clcheck_lost)
- ✅ Admin `/funnel` dashboard with conversion rate tiles
- ✅ Threads + Thread Messages tables live (`tblIuMAlScXBTNF5w`, `tbl5ORgGghoqabyXr`)
- ✅ Buyer pre-purchase ask form at `/checkout/[refId]/ask`
- ✅ Rancher inbox at `/rancher/inbox` with unread badges
- ✅ Inbound email → thread routing via `thread-<id>@replies.<domain>` prefix
- ✅ Thread close-on-referral-close hook
- ✅ Telegram alert on every inbound thread message
- ✅ Rate limit on POST `/api/threads/[id]/message` (10/min per sender)

State verified: type-check clean, boundary check 0 violations, 10 commits live on `stage-3-verticals` branch, latest deploy `dpl_3NCAE85YzEPenYeEoedvrm3KnayF` READY on Vercel.

---

## Task 1: Airtable schema additions (via MCP)

**Files:**
- (Schema only — no code)

- [ ] **Step 1: Add tier + Stripe + fulfillment fields to Ranchers**

Using Airtable MCP create_field on `tbl08y9Be45zNG0OG`:

```
// Business-model gate: legacy vs tier_v2
field: { name: "Pricing Model", type: "singleSelect", options: { choices: [
  { name: "legacy" }, { name: "tier_v2" }
]}}

// Tier subscription
field: { name: "Tier", type: "singleSelect", options: { choices: [
  { name: "None" }, { name: "Pasture" }, { name: "Ranch" }, { name: "Operator" }
]}}

field: { name: "Stripe Subscription Id", type: "singleLineText" }

field: { name: "Subscription Status", type: "singleSelect", options: { choices: [
  { name: "none" }, { name: "trialing" }, { name: "active" },
  { name: "past_due" }, { name: "canceled" }, { name: "unpaid" }
]}}

field: { name: "Subscription Started At", type: "dateTime", options: {
  dateFormat: { name: "iso" }, timeFormat: { name: "24hour" }, timeZone: "utc"
}}

field: { name: "Subscription Next Invoice At", type: "dateTime", options: {
  dateFormat: { name: "iso" }, timeFormat: { name: "24hour" }, timeZone: "utc"
}}

// Stripe Connect (V2 account)
field: { name: "Stripe Connect Account Id", type: "singleLineText" }

field: { name: "Stripe Connect Status", type: "singleSelect", options: { choices: [
  { name: "not_connected" }, { name: "onboarding" },
  { name: "active" }, { name: "restricted" }
]}}

field: { name: "Stripe Connect Connected At", type: "dateTime", options: {
  dateFormat: { name: "iso" }, timeFormat: { name: "24hour" }, timeZone: "utc"
}}

// Fulfillment info — shown to buyer on deposit page BEFORE payment.
// Rancher self-reports; BHC never owns logistics.
field: { name: "Fulfillment Types", type: "multipleSelects", options: { choices: [
  { name: "Local Pickup" }, { name: "Local Delivery" }, { name: "Cold-Chain Shipping" }
]}}

field: { name: "Pickup City", type: "singleLineText" }

field: { name: "Delivery Radius Miles", type: "number", options: { precision: 0 }}

field: { name: "Shipping Lead Time Days", type: "number", options: { precision: 0 }}

field: { name: "Refund Policy", type: "multilineText" }

field: { name: "Fulfillment Cost Notes", type: "multilineText" }
```

- [ ] **Step 2: Create Payments table via MCP**

```
create_table:
  name: "Payments"
  description: "On-platform buyer deposits via Stripe Connect destination charge. One row per deposit attempt; idempotency keyed on Stripe Payment Intent Id."
  fields:
    - { name: "Stripe Payment Intent Id", type: "singleLineText" }  // primary
    - { name: "Referral", type: "multipleRecordLinks", options: { linkedTableId: tblBfimb4Gt8C0fu4 }}
    - { name: "Buyer", type: "multipleRecordLinks", options: { linkedTableId: tblAbjQDnLrOtjpoE }}
    - { name: "Rancher", type: "multipleRecordLinks", options: { linkedTableId: tbl08y9Be45zNG0OG }}
    - { name: "Tier", type: "singleSelect", options: { choices: [
        { name: "Pasture" }, { name: "Ranch" }, { name: "Operator" }
      ]}}
    - { name: "Amount Cents", type: "number", options: { precision: 0 }}
    - { name: "Platform Fee Cents", type: "number", options: { precision: 0 }}
    - { name: "Status", type: "singleSelect", options: { choices: [
        { name: "pending" }, { name: "succeeded" }, { name: "refunded" }, { name: "failed" }
      ]}}
    - { name: "Created At", type: "dateTime" }
    - { name: "Captured At", type: "dateTime" }
    - { name: "Refunded At", type: "dateTime" }
```

- [ ] **Step 3: Create Payouts table via MCP**

```
create_table:
  name: "Payouts"
  description: "Platform → rancher payouts via Stripe Connect transfer. One row per release."
  fields:
    - { name: "Stripe Transfer Id", type: "singleLineText" }  // primary
    - { name: "Payment", type: "multipleRecordLinks", options: { linkedTableId: <Payments table id> }}
    - { name: "Rancher", type: "multipleRecordLinks", options: { linkedTableId: tbl08y9Be45zNG0OG }}
    - { name: "Amount Cents", type: "number", options: { precision: 0 }}
    - { name: "Status", type: "singleSelect", options: { choices: [
        { name: "pending" }, { name: "paid" }, { name: "failed" }
      ]}}
    - { name: "Reason", type: "singleSelect", options: { choices: [
        { name: "fulfillment_confirmed" }, { name: "dispute_resolved" }, { name: "manual" }
      ]}}
    - { name: "Released At", type: "dateTime" }
```

- [ ] **Step 4: Create Add-On Purchases table via MCP**

```
create_table:
  name: "Add-On Purchases"
  description: "One-off à la carte purchases (video shoot, brand photos, founder letter, etc) billed via Stripe Invoice independent of tier subscription."
  fields:
    - { name: "Stripe Invoice Id", type: "singleLineText" }  // primary
    - { name: "Rancher", type: "multipleRecordLinks", options: { linkedTableId: tbl08y9Be45zNG0OG }}
    - { name: "Type", type: "singleSelect", options: { choices: [
        { name: "Video Shoot" }, { name: "Photo Refresh" },
        { name: "Founder Letter" }, { name: "Brand Intro" }, { name: "PPC Mgmt" }
      ]}}
    - { name: "Amount Cents", type: "number", options: { precision: 0 }}
    - { name: "Status", type: "singleSelect", options: { choices: [
        { name: "pending" }, { name: "paid" }, { name: "canceled" }
      ]}}
    - { name: "Purchased At", type: "dateTime" }
    - { name: "Notes", type: "multilineText" }
```

- [ ] **Step 5: Verify via MCP list_tables_for_base + commit zero code**

Schema-only task. Log table IDs in a comment block at top of `lib/tiers.ts` (Task 2).

- [ ] **Step 6: Backfill `Pricing Model = legacy` on every existing rancher**

Via Airtable MCP `list_records_for_table` (paginated) + `update_records_for_table`:

```
all existing Ranchers (Pricing Model is empty) → set Pricing Model = "legacy"
```

This is the grandfather flip. Locks existing performers into the old 10%-commission post-close invoice flow. New ranchers signing up after the setup-wizard tier-pick step (Task 11) get `tier_v2` written at signup.

Verify count via MCP:
- Total Ranchers: should match pre-backfill count
- `Pricing Model = legacy`: should equal total Ranchers (all of them)
- `Pricing Model = tier_v2`: should be 0 immediately after backfill

Document the backfill count in the Task 1 commit message + the soak log (Task 14).

---

## Task 2: Tier source-of-truth module

**Files:**
- Create: `lib/tiers.ts`

- [ ] **Step 1: Implement tier definitions**

```ts
// lib/tiers.ts
//
// Single source of truth for the 3-tier rancher subscription model.
// Any code that needs price, commission rate, Stripe Price ID, or perks
// imports from here. Tier changes happen in ONE place.
//
// AIRTABLE TABLE IDS (verified 2026-05-25):
//   Ranchers          : tbl08y9Be45zNG0OG
//   Payments          : <set after Task 1 Step 2>
//   Payouts           : <set after Task 1 Step 3>
//   Add-On Purchases  : <set after Task 1 Step 4>

export type TierSlug = 'pasture' | 'ranch' | 'operator';

export interface TierConfig {
  slug: TierSlug;
  label: string;
  monthlyCents: number;
  commissionRate: number; // 0.07 = 7%
  stripePriceIdEnv: string;
  promise: string;
  perks: string[];
}

export const TIERS: Record<TierSlug, TierConfig> = {
  pasture: {
    slug: 'pasture',
    label: 'Pasture',
    monthlyCents: 15000,
    commissionRate: 0.07,
    stripePriceIdEnv: 'STRIPE_PASTURE_PRICE_ID',
    promise: 'We send you buyers',
    perks: [
      'Verified green-pin listing on /map (organic buyer discovery)',
      'Custom landing page at buyhalfcow.com/ranchers/[your-ranch] — SEO-optimized, photos, story, pricing',
      'Automatic buyer matching when someone in your state takes the /access quiz',
      'Intro emails fired to the buyer with your contact + ranch profile',
      'Reply tracking in your rancher dashboard (you see every conversation)',
      'Capacity controls — you set max active leads, we never overload you',
      'Listing mention in the monthly buyer newsletter when you close a deal',
      'Self-serve onboarding wizard (live in 5 minutes)',
    ],
  },
  ranch: {
    slug: 'ranch',
    label: 'Ranch',
    monthlyCents: 35000,
    commissionRate: 0.03,
    stripePriceIdEnv: 'STRIPE_RANCH_PRICE_ID',
    promise: 'We send you buyers AND make sure they see you first',
    perks: [
      'Everything in Pasture',
      'Priority routing — when a buyer in your state qualifies, you get the match before any other rancher',
      'Listing optimization — Ben personally rewrites your landing page copy quarterly',
      'Case study post to BHC Instagram + Twitter every time you close a deal',
      'Featured rancher in 1 founder letter per quarter (1,600+ qualified buyers)',
      'Inclusion on the /wins page — public proof wall of closed deals',
      'Monthly performance review — 30-min call or written breakdown',
      'First-dibs on brand partner co-marketing',
    ],
  },
  operator: {
    slug: 'operator',
    label: 'Operator',
    monthlyCents: 50000,
    commissionRate: 0,
    stripePriceIdEnv: 'STRIPE_OPERATOR_PRICE_ID',
    promise: 'We send you buyers, position you, and run your marketing',
    perks: [
      'Everything in Ranch',
      '2 custom reels per month produced for your ranch',
      '1 founder-voice email per month written for your direct customer list',
      'Listing fully managed — pricing, photos, copy refreshes all handled',
      'Quarterly feature in BHC YouTube long-form',
      'Brand partner intros, warm-handoff',
      'Quarterly 1:1 strategy call with Ben',
      'Zero commission on deals — every dollar a buyer pays you is yours',
      'First call on speaking + podcast opportunities when BHC books regen-ag media',
    ],
  },
};

// Add-ons (à la carte, any tier)
export interface AddOnConfig {
  slug: 'video' | 'photo' | 'founder_letter' | 'brand_intro' | 'ppc';
  label: string;
  description: string;
  pricing: { kind: 'one_time'; cents: number } | { kind: 'percent_of_deal'; rate: number } | { kind: 'percent_plus_minimum'; rate: number; monthlyMinCents: number };
  stripePriceIdEnv?: string;
}

export const ADD_ONS: AddOnConfig[] = [
  {
    slug: 'video',
    label: 'Custom on-site video shoot (Ben travels)',
    description: '$2,500 + travel expenses billed separately',
    pricing: { kind: 'one_time', cents: 250000 },
    stripePriceIdEnv: 'STRIPE_ADDON_VIDEO_PRICE_ID',
  },
  {
    slug: 'photo',
    label: 'Annual brand photo refresh',
    description: 'On-site photo shoot, full delivery within 30 days',
    pricing: { kind: 'one_time', cents: 150000 },
    stripePriceIdEnv: 'STRIPE_ADDON_PHOTO_PRICE_ID',
  },
  {
    slug: 'founder_letter',
    label: 'Founder-letter campaign',
    description: '3-email sequence written + sent to your direct customer list',
    pricing: { kind: 'one_time', cents: 75000 },
    stripePriceIdEnv: 'STRIPE_ADDON_FOUNDER_LETTER_PRICE_ID',
  },
  {
    slug: 'brand_intro',
    label: 'Brand partner intro + negotiation',
    description: 'We pair you with cooler/knife/supplement brands looking for D2C rancher partners',
    pricing: { kind: 'percent_of_deal', rate: 0.15 },
  },
  {
    slug: 'ppc',
    label: 'PPC management for your direct site',
    description: 'Google + Meta ads for your own ranch site (not BHC)',
    pricing: { kind: 'percent_plus_minimum', rate: 0.15, monthlyMinCents: 50000 },
  },
];

export function tierFor(rancher: any): TierSlug | null {
  const raw = String(rancher?.['Tier'] || '').toLowerCase();
  if (raw === 'pasture' || raw === 'ranch' || raw === 'operator') return raw as TierSlug;
  return null;
}

export function commissionRateForTier(tier: TierSlug | null): number {
  if (!tier) return Number(process.env.COMMISSION_RATE_DEFAULT || '0.10');
  return TIERS[tier].commissionRate;
}
```

- [ ] **Step 2: Type-check + commit**

```bash
npx tsc --noEmit
git add lib/tiers.ts
git commit -m "feat(tiers): single source of truth for Pasture/Ranch/Operator pricing"
git push
```

---

## Task 3: /partner page (public, 3-tier comparison)

**Files:**
- Create: `app/partner/page.tsx`
- Modify: `tools/check-vertical-boundaries.ts` (add app/partner/ to shared OR buyer vertical)

- [ ] **Step 1: Build the page**

Three tier cards side-by-side. Header line: *"Pick the marketing engine that fits your ranch. We send you buyers. You raise the cattle. Cancel anytime."*

Pull live counters from `/api/stats/public` (buyer count + state count) above the cards.

Each card:
- Tier name + price + commission line
- Promise (1 sentence)
- Bulleted perks (full list from TIERS[slug].perks)
- "Get started" button → `/partner/checkout/<slug>` (Task 5 wires it)

Below cards: collapsible Add-On Menu listing each ADD_ONS entry with description + pricing.

Bottom of page: Operator SLA statement verbatim.

Token discipline: bone / charcoal / saddle / dust / divider only.

- [ ] **Step 2: Update boundary checker**

Add `'app/partner/'` to `tools/check-vertical-boundaries.ts` shared-allowed prefixes (public marketing page; not a vertical).

- [ ] **Step 3: Smoke + commit**

```bash
npx tsc --noEmit && npx tsx tools/check-vertical-boundaries.ts
curl -sI https://<preview-alias>/partner | head -3   # expect 200
git add app/partner/ tools/check-vertical-boundaries.ts
git commit -m "feat(partner): 3-tier comparison page with add-on menu"
git push
```

---

## Task 4: Tier subscription endpoints

**Files:**
- Create: `lib/stripeSubscription.ts`
- Create: `app/api/rancher/tier/select/route.ts`
- Create: `app/api/rancher/tier/change/route.ts`
- Create: `app/api/rancher/tier/portal/route.ts`

- [ ] **Step 1: stripeSubscription helpers (V2 API)**

```ts
// lib/stripeSubscription.ts — V2 Stripe Subscription helpers for the 3-tier model.
//
// V2 unifies Customer + Connected Account. The rancher's `acct_*` ID is used
// as both:
//   - the Connected Account (receives buyer deposits via direct charge)
//   - the Customer (billed for monthly tier subscription)
// Pass `customer_account: 'acct_*'` to checkout.sessions.create + billingPortal.
// Do NOT create a separate cus_* customer.
//
// Each rancher gets ONE subscription. Tier changes proration via subscriptions.update.

import Stripe from 'stripe';
import { TIERS, TierSlug } from '@/lib/tiers';

// Stripe Client — single instance per process. SDK auto-sets API version
// 2026-04-22.dahlia (or whatever is current at SDK install time).
const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY || '');

export interface TierCheckoutInput {
  rancherId: string;
  connectedAccountId: string;  // acct_XXX — created via stripeConnect.createConnectAccount BEFORE this call
  tier: TierSlug;
  successUrl: string;
  cancelUrl: string;
}

export async function createTierCheckoutSession(input: TierCheckoutInput): Promise<{ url: string }> {
  const priceId = process.env[TIERS[input.tier].stripePriceIdEnv];
  if (!priceId) throw new Error(`Missing ${TIERS[input.tier].stripePriceIdEnv} env var`);
  const session = await stripeClient.checkout.sessions.create({
    mode: 'subscription',
    // V2: the connected account IS the customer. Use customer_account, NOT customer.
    customer_account: input.connectedAccountId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: { rancherId: input.rancherId, tier: input.tier },
    subscription_data: { metadata: { rancherId: input.rancherId, tier: input.tier } },
  });
  return { url: session.url || '' };
}

export async function changeSubscriptionTier(subscriptionId: string, newTier: TierSlug): Promise<void> {
  const newPriceId = process.env[TIERS[newTier].stripePriceIdEnv];
  if (!newPriceId) throw new Error(`Missing ${TIERS[newTier].stripePriceIdEnv} env var`);
  const sub = await stripeClient.subscriptions.retrieve(subscriptionId);
  const itemId = sub.items.data[0].id;
  await stripeClient.subscriptions.update(subscriptionId, {
    items: [{ id: itemId, price: newPriceId }],
    proration_behavior: 'always_invoice',
    metadata: { ...sub.metadata, tier: newTier },
  });
}

export async function createBillingPortalSession(connectedAccountId: string, returnUrl: string): Promise<{ url: string }> {
  // V2: use customer_account, not customer
  const session = await stripeClient.billingPortal.sessions.create({
    customer_account: connectedAccountId,
    return_url: returnUrl,
  });
  return { url: session.url };
}

// Helper to extract V2 connected account id from a subscription webhook payload.
// V2: subscription.customer_account is the acct_* id. subscription.customer DOES NOT EXIST on V2.
export function rancherIdFromSubscription(subscription: any): { connectedAccountId: string } {
  return { connectedAccountId: subscription.customer_account as string };
}
```

- [ ] **Step 2: /api/rancher/tier/select POST**

Auth: rancher-session JWT. Body: `{ tier: TierSlug }`. Flow:
1. Read rancher row, check no existing active subscription
2. If no `Stripe Connect Account Id`: call `stripeConnect.createConnectAccount()` (Task 7 — V2 accounts.create), persist `acct_*` to Ranchers row IMMEDIATELY (so refresh-mid-flow doesn't duplicate)
3. createTierCheckoutSession with `connectedAccountId = acct_*`
4. Return `{ url }` → page redirects to Stripe Checkout

- [ ] **Step 3: /api/rancher/tier/change POST**

Auth: rancher-session JWT. Body: `{ tier: TierSlug }`. Requires `Stripe Subscription Id` present. Calls `changeSubscriptionTier`. Returns success or 4xx with reason.

- [ ] **Step 4: /api/rancher/tier/portal GET**

Auth: rancher-session JWT. Returns Stripe Customer Portal URL for card management + cancel.

- [ ] **Step 5: Type-check, smoke, commit, push**

Smoke command for `/select` once `STRIPE_PASTURE_PRICE_ID` set on preview:
```bash
curl -X POST "$PREVIEW_URL/api/rancher/tier/select" \
  -H "cookie: bhc-rancher-auth=<jwt>" \
  -H 'content-type: application/json' \
  -d '{"tier":"pasture"}'
```
Expect `{ url: "https://checkout.stripe.com/..." }`.

---

## Task 5: Tier checkout landing pages

**Files:**
- Create: `app/partner/checkout/[tier]/page.tsx`
- Create: `app/rancher/billing/page.tsx`

- [ ] **Step 1: Tier-select page**

Reachable from `/partner` "Get started" buttons. Asks for rancher login if not logged in (redirect to `/rancher/login?return=/partner/checkout/<tier>`). Once logged in, fires POST `/api/rancher/tier/select` → redirects to returned Stripe Checkout URL.

If rancher already has the same tier active: show "You're already on this tier" + link to `/rancher/billing`.

If rancher has a different active tier: show comparison + "Switch to this tier" button → POST `/api/rancher/tier/change`.

- [ ] **Step 2: Billing dashboard**

`/rancher/billing` shows:
- Current tier badge + monthly fee + commission rate
- Subscription Status with color (green / yellow / red)
- Next invoice date + amount
- Manage payment / cancel button → POST `/api/rancher/tier/portal` → redirect
- Connect bank status (links to `/api/rancher/connect/start` if not active)
- Pending payouts list
- Add-on shop (one card per ADD_ONS entry with "Purchase" button → `/api/rancher/addons/purchase`)

- [ ] **Step 3: Type-check, commit, push, smoke**

Once Stripe webhook delivers `customer.subscription.created` (Task 6), the billing page renders the live tier.

---

## Task 6: Stripe webhooks — subscription + invoice + deposit events

**Files:**
- Modify: `app/api/webhooks/stripe/route.ts` (existing webhook — extend)
- Create: `app/api/webhooks/stripe-connect/route.ts` (new)

- [ ] **Step 1: Extend platform webhook for subscription events**

Add handlers to `app/api/webhooks/stripe/route.ts`:

```ts
case 'customer.subscription.created':
case 'customer.subscription.updated': {
  const sub = event.data.object as any;
  const rancherId = sub.metadata?.rancherId;
  const tier = sub.metadata?.tier;
  if (rancherId) {
    await updateRecord(TABLES.RANCHERS, rancherId, {
      'Tier': tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : 'None',
      'Stripe Subscription Id': sub.id,
      'Subscription Status': sub.status,
      'Subscription Started At': new Date(sub.start_date * 1000).toISOString(),
      'Subscription Next Invoice At': sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
      'Commission Rate': tier === 'pasture' ? 0.07 : tier === 'ranch' ? 0.03 : tier === 'operator' ? 0 : null,
      'Commission Rate Locked At': new Date().toISOString(),
    });
  }
  break;
}

case 'customer.subscription.deleted': {
  const sub = event.data.object as any;
  const rancherId = sub.metadata?.rancherId;
  if (rancherId) {
    await updateRecord(TABLES.RANCHERS, rancherId, {
      'Subscription Status': 'canceled',
      'Tier': 'None',
    });
  }
  break;
}

case 'invoice.paid': {
  const inv = event.data.object as any;
  // Subscription invoice → no per-rancher row write (subscription update handles tier).
  // Commission invoice → existing handler (already in this file).
  // Add-on invoice → flip Add-On Purchases row to paid.
  if (inv.metadata?.addOnPurchaseId) {
    await updateRecord('Add-On Purchases', inv.metadata.addOnPurchaseId, {
      'Status': 'paid',
    });
  }
  break;
}

case 'payment_intent.succeeded': {
  const pi = event.data.object as any;
  // Buyer deposit succeeded — handled by lib/contracts/payments.markDepositSucceeded.
  // pi.metadata.referralId is set by createDepositCheckout in Task 8.
  if (pi.metadata?.referralId) {
    const { markDepositSucceeded } = await import('@/lib/contracts/payments');
    await markDepositSucceeded(pi.id);
    const { funnelRecord } = await import('@/lib/funnelMetrics');
    await funnelRecord({
      stage: 'deposit_paid',
      referralId: pi.metadata.referralId,
      amount: pi.amount_received / 100,
    });
  }
  break;
}
```

- [ ] **Step 2: Build Connect webhook (V2 THIN events)**

```ts
// app/api/webhooks/stripe-connect/route.ts
//
// V2 Connect events are THIN — payload is just { id, type }. We must:
//   1. Parse via stripeClient.parseThinEvent()
//   2. Retrieve full event data via stripeClient.v2.core.events.retrieve()
//   3. For account events, retrieve the account via v2.core.accounts.retrieve()
//      with the include[] for the fields we need.

import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY || '');
const WEBHOOK_SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  const rawBody = await req.text();
  const sig = req.headers.get('stripe-signature') || '';

  let thinEvent;
  try {
    thinEvent = stripeClient.parseThinEvent(rawBody, sig, WEBHOOK_SECRET);
  } catch (e: any) {
    return NextResponse.json({ error: `Invalid signature: ${e?.message}` }, { status: 400 });
  }

  // Capability change OR requirements change — both indicate onboarding state shift.
  const isCapabilityEvent =
    thinEvent.type === 'v2.core.account[configuration.merchant].capability_status_updated' ||
    thinEvent.type === 'v2.core.account[configuration.customer].capability_status_updated' ||
    thinEvent.type === 'v2.core.account[.recipient].capability_status_updated';
  const isRequirementsEvent = thinEvent.type === 'v2.core.account[requirements].updated';

  if (!isCapabilityEvent && !isRequirementsEvent) {
    return NextResponse.json({ ok: true, skipped: thinEvent.type });
  }

  // Fetch full event data to get account context
  const event = await stripeClient.v2.core.events.retrieve(thinEvent.id);
  // The thin event carries account_id in event.related_object.id (per Stripe V2 docs)
  const accountId = (event as any).related_object?.id;
  if (!accountId) return NextResponse.json({ ok: true, skipped: 'no account_id' });

  // Retrieve account with merchant + requirements included
  const account = await stripeClient.v2.core.accounts.retrieve(accountId, {
    include: ['configuration.merchant', 'requirements'],
  });

  // Look up rancher by stored Connect account id
  const safeId = accountId.replace(/"/g, '\\"');
  const matches: any[] = await getAllRecords(TABLES.RANCHERS, `{Stripe Connect Account Id} = "${safeId}"`);
  if (!matches[0]) return NextResponse.json({ ok: true, skipped: 'rancher not found' });
  const rancher = matches[0];

  // V2 status check
  const cardPaymentsActive =
    (account as any)?.configuration?.merchant?.capabilities?.card_payments?.status === 'active';
  const reqStatus = (account as any)?.requirements?.summary?.minimum_deadline?.status;
  const onboardingComplete = reqStatus !== 'currently_due' && reqStatus !== 'past_due';

  const status: 'active' | 'restricted' | 'onboarding' | 'not_connected' =
    cardPaymentsActive && onboardingComplete ? 'active' :
    reqStatus === 'past_due' ? 'restricted' :
    'onboarding';

  const updates: Record<string, any> = { 'Stripe Connect Status': status };
  if (status === 'active' && !rancher['Stripe Connect Connected At']) {
    updates['Stripe Connect Connected At'] = new Date().toISOString();
    // Activation moment — trigger downstream effects.
    // 1. Flip rancher Live so matching/suggest can route them
    updates['Active Status'] = 'Active';
    updates['Page Live'] = true;
    // 2. Telegram celebration
    try {
      const { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } = await import('@/lib/telegram');
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `🐂 <b>NEW RANCHER LIVE</b>\n\n${rancher['Operator Name'] || rancher['Ranch Name']} (${rancher['State']})\nTier: ${rancher['Tier']}\nStripe acct: <code>${accountId}</code>`,
      );
    } catch {}
    // 3. Launch warmup — fires intro emails to waitlisted buyers in their state
    try {
      const { triggerLaunchWarmup } = await import('@/lib/triggerLaunchWarmup');
      await triggerLaunchWarmup(rancher.id);
    } catch {}
  }
  await updateRecord(TABLES.RANCHERS, rancher.id, updates);
  return NextResponse.json({ ok: true, status });
}
```

- [ ] **Step 3: Type-check + commit + push**

---

## Task 7: Connect onboarding (V2 API)

**Files:**
- Create: `lib/stripeConnect.ts`
- Create: `app/api/rancher/connect/start/route.ts`

- [ ] **Step 1: stripeConnect helpers (V2)**

```ts
// lib/stripeConnect.ts
//
// V2 Connect helpers. NO `type: 'express'` — V2 unifies account types into a
// single object with configuration.{merchant,customer} capability blocks.
// See https://docs.stripe.com/api/v2/core/accounts/object for the full schema.

import Stripe from 'stripe';

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY || '');

export interface CreateConnectAccountInput {
  email: string;
  displayName: string;       // shown in Stripe dashboard, on payout statements
  rancherId: string;          // metadata for our own lookups
}

export async function createConnectAccount(input: CreateConnectAccountInput): Promise<{ accountId: string }> {
  const account = await stripeClient.v2.core.accounts.create({
    display_name: input.displayName,
    contact_email: input.email,
    identity: { country: 'us' },
    dashboard: 'full',                          // V2 equivalent of legacy Express
    defaults: {
      responsibilities: {
        fees_collector: 'stripe',
        losses_collector: 'stripe',
      },
    },
    configuration: {
      customer: {},                              // Subscription billing recipient
      merchant: {
        capabilities: {
          card_payments: { requested: true },    // Accept buyer deposits
        },
      },
    },
    metadata: { rancherId: input.rancherId },
  });
  return { accountId: account.id };
}

export async function createOnboardingLink(input: {
  accountId: string;
  returnUrl: string;
  refreshUrl: string;
}): Promise<{ url: string }> {
  const link = await stripeClient.v2.core.accountLinks.create({
    account: input.accountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        configurations: ['merchant', 'customer'],
        refresh_url: input.refreshUrl,
        return_url: input.returnUrl,
      },
    },
  });
  return { url: link.url };
}

export async function getConnectAccountStatus(accountId: string): Promise<{
  cardPaymentsActive: boolean;
  onboardingComplete: boolean;
  requirementsStatus: string | null;
  status: 'not_connected' | 'onboarding' | 'active' | 'restricted';
}> {
  const account = await stripeClient.v2.core.accounts.retrieve(accountId, {
    include: ['configuration.merchant', 'requirements'],
  });
  const cardPaymentsActive =
    (account as any)?.configuration?.merchant?.capabilities?.card_payments?.status === 'active';
  const reqStatus = (account as any)?.requirements?.summary?.minimum_deadline?.status ?? null;
  const onboardingComplete = reqStatus !== 'currently_due' && reqStatus !== 'past_due';
  const status: 'not_connected' | 'onboarding' | 'active' | 'restricted' =
    cardPaymentsActive && onboardingComplete ? 'active' :
    reqStatus === 'past_due' ? 'restricted' :
    'onboarding';
  return { cardPaymentsActive, onboardingComplete, requirementsStatus: reqStatus, status };
}
```

- [ ] **Step 2: /api/rancher/connect/start POST**

Auth: rancher-session JWT. Refuses if `STRIPE_CONNECT_ENABLED !== 'true'`.

Flow:
1. Read rancher row.
2. If no `Stripe Connect Account Id`: call `createConnectAccount({ email, displayName: operatorName || ranchName, rancherId })` — persist `acct_*` to Airtable IMMEDIATELY (so refresh-mid-flow doesn't duplicate). Mark `Stripe Connect Status='onboarding'`.
3. Call `createOnboardingLink` with:
   - `returnUrl=${SITE_URL}/rancher/billing?onboarding=done`
   - `refreshUrl=${SITE_URL}/api/rancher/connect/start` (Stripe redirects here if rancher abandons mid-flow; same endpoint re-issues a fresh link)
4. Return `{ url }`.

Note: this endpoint is ALSO called from Task 4 Step 2 (tier-select) BEFORE the subscription Checkout, so the connected account exists when we pass `customer_account: acct_*` to the subscription Checkout.

- [ ] **Step 3: Status read endpoint (`/api/rancher/connect/status` GET)**

Auth: rancher-session JWT. Reads rancher's `Stripe Connect Account Id`. If empty: return `{ status: 'not_connected' }`. Else: calls `getConnectAccountStatus(accountId)` LIVE — never trusts the cached Airtable field — and returns the result. Dashboard polls this on `/rancher/billing` mount.

- [ ] **Step 4: Type-check + commit + push**

---

## Task 8: Buyer on-platform deposit flow

**Files:**
- Create: `app/api/checkout/deposit/route.ts`
- Create: `app/checkout/[refId]/deposit/page.tsx`
- Create: `app/checkout/[refId]/success/page.tsx`
- Modify: `lib/stripeConnect.ts` — add `createDepositCheckout` w/ per-tier fee
- Modify: `lib/contracts/payments.ts` — add `tier` + `platformFeeCents` fields

- [ ] **Step 1: stripeConnect.createDepositCheckout**

```ts
import { TIERS, TierSlug } from '@/lib/tiers';

export async function createDepositCheckout(input: {
  rancherConnectAccountId: string;
  tier: TierSlug;
  amountCents: number;
  buyerEmail: string;
  referralId: string;
  productLabel: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string; paymentIntentId: string }> {
  const feeRate = TIERS[input.tier].commissionRate; // 0.07 / 0.03 / 0
  const platformFeeCents = Math.round(input.amountCents * feeRate);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: input.productLabel },
        unit_amount: input.amountCents,
      },
      quantity: 1,
    }],
    customer_email: input.buyerEmail,
    payment_intent_data: {
      application_fee_amount: platformFeeCents,
      transfer_data: { destination: input.rancherConnectAccountId },
      metadata: { referralId: input.referralId, tier: input.tier },
    },
    metadata: { referralId: input.referralId, tier: input.tier },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });
  return { url: session.url || '', paymentIntentId: String(session.payment_intent || '') };
}
```

- [ ] **Step 2: Update payments contract**

```ts
// In lib/contracts/payments.ts
export interface CreateDepositInput {
  referralId: string;
  buyerId: string;
  rancherId: string;
  tier: 'Pasture' | 'Ranch' | 'Operator';
  amountCents: number;
  platformFeeCents: number;
  stripePaymentIntentId: string;
}
// Then in recordDeposit, write 'Tier' + 'Platform Fee Cents' to Payments row.
```

- [ ] **Step 3: /api/checkout/deposit POST**

Auth: member-session (buyer). Body: `{ referralId, tier, cutSize }` — `tier` is the rancher's current tier (server reads from rancher row, doesn't trust client; if rancher is `Pricing Model = legacy`, server returns 409 "rancher uses legacy payment links" and the deposit page falls back to existing landing-page links).

Server flow:
1. Verify buyer owns the referral
2. Reads rancher row. If `Pricing Model = legacy` → 409 with redirect URL to rancher's legacy Payment Link
3. Reads rancher's `Stripe Connect Status` — must be `active` else 409
4. Reads rancher's `Tier` — must be Pasture/Ranch/Operator else 409
5. Computes `amountCents` from rancher's per-tier price (Quarter/Half/Whole field on Ranchers) + cutSize selector
6. Calls `createDepositCheckout`
7. Records pending payment via `recordDeposit` (Tier + Platform Fee Cents stamped)
8. Returns `{ url }`

- [ ] **Step 4: Buyer deposit page — fulfillment-aware layout**

`/checkout/[refId]/deposit` — shows ALL the info the buyer needs to make an informed payment decision BEFORE clicking pay:

```
┌──────────────────────────────────────────────────────────────┐
│ Reserve your beef                                            │
│ ─────────────────────────────────────────────────────────── │
│                                                              │
│ Rancher · <Ranch Name>                                       │
│ <City>, <State> · <Ships nationwide? Local pickup? Both?>    │
│                                                              │
│ Pick your cut:                                               │
│  ○ Quarter Cow — $X (≈ <lbs> lbs)                            │
│  ○ Half Cow — $Y    (≈ <lbs> lbs)                            │
│  ○ Whole Cow — $Z   (≈ <lbs> lbs)                            │
│                                                              │
│ ─── Before you pay ────────────────────────────────────────  │
│ HOW YOU GET IT:                                              │
│ <Fulfillment Types verbatim, comma-joined>                   │
│ <if Local Pickup: "Pickup at <Pickup City>, <State>">        │
│ <if Local Delivery: "Delivery within <Radius> mi">           │
│ <if Cold-Chain Shipping: "Ships in ~<Lead Time Days> days    │
│   after processing on <Next Processing Date>">               │
│                                                              │
│ <if Fulfillment Cost Notes: "Extras: <notes>">               │
│                                                              │
│ REFUND POLICY:                                               │
│ <Refund Policy verbatim>                                     │
│                                                              │
│ HOW THE PAYMENT WORKS:                                       │
│ Your deposit goes to <Ranch Name> through Stripe. We hold    │
│ no funds at BuyHalfCow. <Ranch Name> ships/delivers/has you  │
│ pick up. You + <Ranch Name> coordinate details by message    │
│ (we already have a thread open for you).                     │
│                                                              │
│   [   Continue to Secure Payment   →   ]                     │
│                                                              │
│ Powered by Stripe · BuyHalfCow doesn't store card data       │
└──────────────────────────────────────────────────────────────┘
```

Token discipline: bone bg / charcoal text / saddle accents / dust borders. Use the existing site shell + footer.

If `Pricing Model = legacy` on the rancher: don't render this page. Redirect to the rancher's legacy landing page deposit button (`/ranchers/<slug>`) with a one-line banner: "<Ranch Name> uses their own checkout — same beef, same rancher, just a different payment page."

- [ ] **Step 5: Success page**

`/checkout/[refId]/success?session_id=cs_xxx` — fetches the Checkout Session, shows:

```
🎉 Deposit confirmed — $<amount> to <Ranch Name>

What happens next:
1. <Ranch Name> got an email + text. They'll reply within 24h.
2. You + <Ranch Name> arrange <pickup/delivery/shipping> in the message thread.
3. Once you receive your beef, <Ranch Name> confirms fulfillment and gets paid.

[   Open thread with <Ranch Name>   ]   [   Your dashboard   ]
```

- [ ] **Step 6: Type-check + commit + smoke**

Smoke with Stripe test card 4242 4242 4242 4242 on preview alias once `STRIPE_CONNECT_ENABLED=true` set on preview env. Verify:
- Payment Intent succeeds in Stripe Dashboard
- Payment row appears in Airtable w/ correct Tier + Platform Fee Cents
- Funnel Event `deposit_paid` written
- Rancher receives Telegram + email confirming deposit
- Thread auto-opens between buyer + rancher

---

## Task 9: Fulfillment confirm + payout release

**Files:**
- Create: `app/api/rancher/fulfillment/confirm/route.ts`

- [ ] **Step 1: Confirm endpoint**

Auth: rancher-session JWT. Body: `{ paymentId }`. Validates rancher owns the payment + Payment Status=`succeeded` + no existing payout. Reads rancher's `Tier` to compute payout %:
- Pasture: 93% (100% - 7%)
- Ranch: 97% (100% - 3%)
- Operator: 100% (commission was 0 to begin with)

For Operator the deposit's `application_fee_amount` was 0; Stripe already transferred 100% to rancher's Connect balance — payout is just a Stripe `payouts.create` from their connected account to their bank.

For Pasture/Ranch the platform retained 7%/3% via `application_fee_amount`; rancher's Connect balance is already 93%/97%; the payout is the same Stripe `payouts.create` on their connected account.

Either way the platform doesn't transfer extra — Stripe already split. The "fulfillment confirm" just triggers a manual payout on the rancher's Connect account.

Use `stripe.payouts.create({ amount, currency: 'usd' }, { stripeAccount: connectAcct })`.

Records payout row. Fires Telegram alert.

- [ ] **Step 2: Type-check + commit + push**

---

## Task 10: Add-on à la carte purchase flow

**Files:**
- Create: `app/api/rancher/addons/purchase/route.ts`

- [ ] **Step 1: Purchase endpoint**

Auth: rancher-session JWT. Body: `{ slug }` (one of `video|photo|founder_letter`). Looks up rancher's Stripe Customer Id. Creates a Stripe Invoice with the corresponding one-off Price. Sends the invoice (`send_invoice` collection method, 14-day net). Persists row in `Add-On Purchases` with Status=`pending`. Returns `{ invoiceUrl }`.

`brand_intro` (15% of deal) + `ppc` (15% of ad spend + $500/mo min) — manual billing for now, not auto-purchasable through this endpoint. Return 400 with "contact support to set up brand intro / PPC management".

- [ ] **Step 2: Type-check + commit + push**

---

## Task 11: Setup wizard — tier-pick + fulfillment + dashboard banners

**Files:**
- Modify: `app/api/rancher/setup/route.ts` — sign new ranchers `Pricing Model='tier_v2'` at first POST
- Modify: `app/rancher/setup/page.tsx` — add tier-pick step + fulfillment step UI
- Modify: `app/rancher/page.tsx` — pending-action banners (one per gate)

- [ ] **Step 1: Sign new ranchers as `tier_v2` at signup**

In `app/api/rancher/setup/route.ts` initial-create handler, write `'Pricing Model': 'tier_v2'` alongside the existing Operator Name / Email / etc. Legacy ranchers backfilled in Task 1 Step 6 keep `'legacy'`; they never hit this code path (they were already created).

- [ ] **Step 2: Setup wizard — Pick Your Plan step**

Insert after Profile step + before Fulfillment step:

```
Step 4 of 6: Pick Your Plan

  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
  │  PASTURE    │  │   RANCH     │  │  OPERATOR   │
  │  $150/mo    │  │  $350/mo    │  │  $500/mo    │
  │  + 7%       │  │  + 3%       │  │  + 0%       │
  │             │  │             │  │             │
  │  We send    │  │  + priority │  │  + we run   │
  │  you buyers │  │  routing +  │  │  your       │
  │             │  │  social     │  │  marketing  │
  │             │  │             │  │             │
  │  [ Choose ] │  │  [ Choose ] │  │  [ Choose ] │
  └─────────────┘  └─────────────┘  └─────────────┘

  Cancel anytime · Upgrade or downgrade in 1 click later.
  See full perks at /partner
```

Pre-select Pasture by default (lowest-friction default-bias). Continue button fires POST `/api/rancher/tier/select` with chosen tier → Stripe Checkout → on return, wizard resumes at Step 5.

- [ ] **Step 3: Setup wizard — Fulfillment step**

New step after Pricing, before Connect bank. Captures how the rancher delivers to buyers — shown verbatim on the buyer's deposit page (Task 8 Step 4).

```
Step 5 of 6: How do you get the beef to buyers?

  [✓] Local pickup at my ranch
  [ ] Local delivery (within driving distance)
  [ ] Cold-chain shipping (FedEx/UPS)

  If LOCAL PICKUP / DELIVERY:
  Pickup city + state: [_______________________]
  Delivery radius (miles, optional): [_____]

  If COLD-CHAIN SHIPPING:
  Typical lead time after processing (days): [__]

  Extras (optional): [______________________________]
  e.g., "Cooler shipping $45" — shown to buyer before they pay.

  REFUND POLICY (required, ≤500 chars):
  [_____________________________________________]
  [_____________________________________________]
  Tip: "Full refund within 7 days if cattle isn't processed yet.
  After processing, store credit only."

  Why we ask: buyers see this verbatim on your deposit page so they
  can decide before paying. Less back-and-forth for you.

  [   Save + continue   ]
```

PATCH `/api/rancher/setup` with: `Fulfillment Types`, `Pickup City`, `Delivery Radius Miles`, `Shipping Lead Time Days`, `Fulfillment Cost Notes`, `Refund Policy`.

Validation: at least 1 Fulfillment Type required. Refund Policy required, min 20 chars (force the rancher to actually write something, not just "Standard"). If `Cold-Chain Shipping` selected, `Shipping Lead Time Days` required. If `Local Pickup` or `Local Delivery`, `Pickup City` required.

- [ ] **Step 4: Dashboard pending-action banners**

Banner cascade — show the most-blocking one first:

1. If `Pricing Model='legacy'` → optional opt-in banner (gold accent):
   > 🎁 Upgrade to a tier with marketing perks · See the new pricing →
   > [Dismiss for 30 days]

2. If `Pricing Model='tier_v2'` AND `Tier='None' OR Subscription Status != 'active'` → critical (red accent):
   > ⛔ Pick your plan to start receiving leads · /partner

3. If `Tier != 'None'` AND `Stripe Connect Status != 'active'` → critical:
   > 💳 Connect your bank — 5 minutes to start receiving payouts. POST → `/api/rancher/connect/start`

4. If `Stripe Connect Status='active'` AND `Fulfillment Types` empty → warn (yellow):
   > 📦 Tell us how you deliver — buyers see this before they pay.

5. If all above pass AND no `Active Status='Active'` → resolving (gray):
   > ⏳ You're 60s away from live · matching engine starting…

When all 5 gates pass: no banner — full dashboard renders.

- [ ] **Step 5: Type-check + commit + push**

---

## Task 11.5: Legacy rancher opt-in upgrade flow

**Files:**
- Create: `app/api/rancher/upgrade-to-tier/route.ts`
- Modify: `app/partner/page.tsx` — legacy-rancher path

Legacy ranchers see `/partner` and can click "Upgrade my account." This flow lets them migrate from `legacy` to `tier_v2` without losing their referral history.

- [ ] **Step 1: Upgrade endpoint**

POST `/api/rancher/upgrade-to-tier` — auth: rancher-session JWT. Body: `{ tier, fulfillment: {...} }`.

Flow:
1. Read rancher. If already `tier_v2` → 409 "already upgraded".
2. Validate fulfillment fields (mirror Task 11 Step 3 validation).
3. Stamp `Pricing Model = tier_v2` + fulfillment fields immediately.
4. Create V2 Connect account, persist `Stripe Connect Account Id`.
5. Create tier Checkout Session w/ `customer_account = acct_*`.
6. Return `{ checkoutUrl, onboardingUrl }`. Front-end redirects to checkout; on return, redirects to Connect onboarding.

- [ ] **Step 2: Legacy banner deep-link**

The "Upgrade" banner from Task 11 Step 4 Item 1 links to `/partner?from=upgrade`. The /partner page detects the param + the legacy session, surfaces a single CTA card:

```
You're already a BHC rancher. Upgrade to a tier to unlock marketing perks.
Your existing referrals + payment links stay — this just adds:
 • Per-tier commission (7% / 3% / 0% vs legacy 10%)
 • New marketing perks (priority routing, social posts, etc.)
 • On-platform deposits (we hold the buyer's payment in escrow-feel)

Pick a tier:    [ Pasture ]   [ Ranch ]   [ Operator ]
```

After tier pick: walks through fulfillment fields modal (same UI as Task 11 Step 3) → POST `/api/rancher/upgrade-to-tier` → Stripe Checkout → return → Connect onboarding.

- [ ] **Step 3: Auto-replace legacy landing-page Payment Links on upgrade**

When `Pricing Model` flips to `tier_v2`, the rancher's `/ranchers/<slug>` landing page logic switches from rendering the legacy Quarter/Half/Whole Payment Link URLs → rendering BHC Checkout buttons that route to `/checkout/<refId>/deposit`. This is a render-time check in `app/ranchers/[slug]/page.tsx`; no migration of historical referrals needed.

- [ ] **Step 4: Type-check + commit + push**

---

## Task 12: Admin payments dashboard

**Files:**
- Create: `app/admin/payments/page.tsx`
- Create: `app/api/admin/payments/route.ts`

- [ ] **Step 1: API**

Returns: per-tier MRR (count × monthly fee), active subscriptions per tier, pending payouts, paid payouts last 30d, total platform fee retained last 30d (sum of Payment.Platform Fee Cents), add-on purchases pending/paid last 30d.

- [ ] **Step 2: Page**

Same Tailwind tokens as `/admin/funnel`. Three rows: MRR overview / payouts / add-ons. Links to Stripe Dashboard per row.

- [ ] **Step 3: Add nav link in admin layout**

`{ group: 'OPS', icon: '💸', label: 'Payments', href: '/admin/payments' }`

- [ ] **Step 4: Type-check + commit + push**

---

## Task 13: Bulletproofing — payout reconcile cron + conversion guards extension

**Files:**
- Create: `app/api/cron/payout-reconcile/route.ts`
- Modify: `vercel.json` (new cron schedule)
- Modify: `app/api/cron/stuck-buyer-recovery/route.ts` — extend with stuck-deposit + stuck-payout escalation

- [ ] **Step 1: payout-reconcile cron**

Runs daily 11 UTC. Pulls `Payments` rows with `Status=succeeded` + no linked Payout row + Captured At > 14d. For each: fires LOUD Telegram operator signal "Stuck payment — rancher hasn't confirmed fulfillment, manual review required".

- [ ] **Step 2: stuck-buyer-recovery scan for stuck deposits**

For `Payments.Status=pending` + Created At > 48h: operator signal "Buyer started checkout but never completed — manual outreach or refund".

- [ ] **Step 3: Type-check + commit + push**

---

## Task 14: Pre-prod soak — 7-day branch monitor

**Files:** No code — observation task.

- [ ] **Step 1: Enable Stripe Connect on preview**

Vercel Project → Settings → Environment Variables → Preview branch `stage-3-verticals`:
- `STRIPE_CONNECT_ENABLED=true`
- `STRIPE_PASTURE_PRICE_ID` / `STRIPE_RANCH_PRICE_ID` / `STRIPE_OPERATOR_PRICE_ID`
- `STRIPE_ADDON_VIDEO_PRICE_ID` / `STRIPE_ADDON_PHOTO_PRICE_ID` / `STRIPE_ADDON_FOUNDER_LETTER_PRICE_ID`
- `STRIPE_CONNECT_WEBHOOK_SECRET`

Production keeps `STRIPE_CONNECT_ENABLED=false`.

- [ ] **Step 2: Pilot rancher onboard**

Recruit 1-2 trusted ranchers (Sackett, High Lonesome per VISION.md north-star). Walk through setup wizard → tier pick (Pasture for test) → Connect bank → confirm everything lands.

- [ ] **Step 3: 7-day synthetic + real traffic**

Daily:
- 1 test buyer goes through full /access → match → /checkout/<refId>/ask → /checkout/<refId>/deposit (test card)
- Rancher confirms fulfillment → payout lands in Stripe test mode
- Verify Funnel Events has full chain (signup → engaged → transition:MATCHED → deposit_paid → close:won)
- Check `/admin/payments` per-tier MRR ticks up correctly

Log results in `docs/SOAK-2026-05-25-stripe-connect.md`.

- [ ] **Step 4: Daily boundary + type checks**

```bash
VERTICAL_BOUNDARY_ENFORCE=warn npx tsx tools/check-vertical-boundaries.ts > /tmp/boundary-day-N.log
npx tsc --noEmit
```

---

## Task 15: 3-pass audit (functional / regression / customer-experience)

**Files:** Audit doc + any fix commits.

- [ ] **Step 1: Functional audit**

Walk Buyer + Rancher full journey on preview. Document in `docs/AUDIT-FUNCTIONAL-2026-05-25-stripe.md`:
1. Rancher onboards: signup → tier pick → Checkout subscription → Connect bank → live
2. Buyer journey: /access → match → /ask → /deposit → /success
3. Rancher confirms fulfillment → payout
4. Buyer asks question post-purchase → rancher replies via inbox
5. Rancher buys add-on → invoice paid via Stripe Customer Portal

- [ ] **Step 2: Regression audit**

Verify nothing broke from baseline shipping:
- All 22 crons fire correctly (esp. close-detector + awaiting-payment-nudge that talk to Status field)
- Telegram `closelost_` / `clcheck_won_` paths still work
- `/api/matching/suggest` still routes properly
- Old Stripe Payment Link rancher pages (`/ranchers/[slug]`) gracefully redirect to `/checkout/[refId]/deposit` for buyers with active referrals

Document in `docs/AUDIT-REGRESSION-2026-05-25-stripe.md`.

- [ ] **Step 3: CX audit**

- No double-emails on Stripe webhook retries (idempotency via PI Id)
- Tier change doesn't lose buyer state mid-flight
- Buyer never sees "0% commission" — it's a rancher-facing concept; buyer just sees price
- Email template merge fields render correctly per tier
- `/partner` page renders under 2s on cold cache

Document in `docs/AUDIT-CX-2026-05-25-stripe.md`.

- [ ] **Step 4: Commit audit docs**

---

## Task 16: Canary rollout

**Files:**
- Create: `docs/SHIP-2026-05-25-stripe.md`
- Modify: `vercel.json` (flip canary flag for prod after soak passes)

- [ ] **Step 1: Write ship plan**

Phase 1 — Architecture (Day 0): merge `stage-3-verticals` → `main` with `STRIPE_CONNECT_ENABLED=false` on prod. Architecture + tier source-of-truth + admin dashboards land. Schema additions visible in Airtable. **All existing ranchers backfilled `Pricing Model='legacy'` — no behavior change for them.** No buyer-facing change.

Phase 2 — /partner discovery (Day 1): announce `/partner` page publicly. Page renders the 3 tiers + add-on menu + live counters. Tier-pick CTAs are LIVE but the actual subscription Checkout returns 503 unless `STRIPE_CONNECT_ENABLED=true` + caller is whitelisted.

Phase 3 — Canary pilot (Days 2-9): flip `STRIPE_CONNECT_ENABLED=true` on prod for ONLY the 2 pilot ranchers via whitelist env `STRIPE_CONNECT_PILOT_RANCHER_IDS=rec123,rec456`. Pilot ranchers:
- Opt-in via the legacy banner (Task 11.5)
- Their `Pricing Model` flips `legacy → tier_v2`
- They pick a tier, get charged the first monthly, complete Connect onboarding
- We send 1 real test buyer through `/checkout/<refId>/deposit` w/ a $50 deposit (real money to test the full flow incl. Connect payout to bank)
- Confirm payout lands in pilot rancher's bank within 48h
- After verification, refund the $50 via Stripe Dashboard (manual; documents the refund flow for v2)

Phase 4 — Open to new ranchers (Days 10-13): remove whitelist gate. NEW rancher signups (Pricing Model=tier_v2 by default per Task 11 Step 1) flow through the full tier-pick + Connect path. Existing ranchers stay legacy — NO forced migration.

Phase 5 — Legacy upgrade campaign (Days 14-30, ongoing): send opt-in email to existing legacy ranchers: "Want to try the new pricing? Pasture's $150/mo + 7% beats your current 10% if you close more than 1 deal a month. Upgrade here." Voluntary. Track upgrade conversion in admin dashboard.

**Legacy ranchers can stay legacy forever.** Migration is opt-in only. Reverse migration (tier_v2 → legacy) is NOT supported — document this in the opt-in copy so ranchers understand the move is one-way.

- [ ] **Step 2: Cherry-pick architecture commits to main first**

```bash
git checkout main
git checkout stage-3-verticals -- lib/tiers.ts lib/contracts/payments.ts app/admin/payments app/api/admin/payments
# omit anything buyer-facing or rancher-tier-facing for Phase 1
```

Verify build clean. Push to main.

- [ ] **Step 3: Execute phase ladder over 14 days**

Document each phase's date + observations in `docs/SHIP-2026-05-25-stripe.md`.

---

## Self-review

**Spec coverage:**
- 3 tiers w/ exact prices + commission rates → Task 2 (TIERS const) + Task 6 (webhook writes Commission Rate to rancher) ✓
- Add-on menu w/ 5 items → Task 2 (ADD_ONS const) + Task 10 (purchase endpoint, 3 of 5 auto-purchasable) ✓
- `/partner` page w/ 3 cards + add-on menu + live counters + Operator SLA → Task 3 ✓
- Tier subscription billing → Tasks 4-6 ✓
- Stripe Connect Express onboarding → Task 7 ✓
- Buyer deposit checkout w/ per-tier platform fee → Task 8 ✓
- Fulfillment confirm + payout → Task 9 ✓
- Add-on purchase → Task 10 ✓
- Tier upgrade/downgrade → Task 4 Step 3 ✓
- Admin MRR dashboard → Task 12 ✓
- NOT shipped to prod until canary → Task 16 ✓
- Bulletproof before customers → Tasks 13-15 ✓

**Placeholder scan:** No "TBD" / "implement later". Every step has the code OR the schema definition. Add-On Purchases linkedTableId in Task 1 Step 3 has placeholder `<Payments table id>` — filled after Task 1 Step 2 creates Payments + the MCP call returns the id. Acceptable since it's a runtime-fillable spec, not buried code.

**Type consistency:**
- `TierSlug = 'pasture' | 'ranch' | 'operator'` used in Tasks 2, 4, 8 — same casing
- `tier` in Airtable is `'Pasture' | 'Ranch' | 'Operator' | 'None'` (capitalized) — code conversion in Task 6 webhook handler
- `Stripe Subscription Id` field name consistent across Tasks 1, 6, 11
- `commissionRate` always decimal (0.07 not 7) in lib/tiers.ts; written to Airtable `Commission Rate` field (percent type, accepts 0-1) — matches existing field

**Risks called out:**
- `STRIPE_PLATFORM_FEE_PRICE_ID` referenced in the OLD plan is REMOVED — superseded by per-tier price IDs.
- Operator tier has 0% commission so `application_fee_amount=0` on Stripe Checkout — Stripe accepts this; verified in Stripe docs.
- Tier change via subscription.update with proration_behavior=always_invoice will charge or credit the difference. Verify with Stripe test mode before pilot.
- Connect Express OAuth onboarding may fail mid-flow if rancher abandons. Subscription is still active — they pay $X/mo without ability to receive deposits. Task 11 dashboard banner surfaces this.
- Existing referrals predate Connect — old Stripe Payment Links still work. Deposit page in Task 8 only renders for referrals whose rancher has `Stripe Connect Status=active`. Gracefully degrade.
- Refund flow not specced in this plan. Defer to Phase 2 after pilot.

**Scope discipline:**
- This plan does NOT cover: refunds, dispute handling, partial payments, custom payment schedules, deferred billing, Operator marketing deliverable tracking (scope: separate Project Mgmt build), Brand Intro 15% revshare tracking, PPC management billing.
- Each deferred item gets its own future plan once volume justifies automation.

---

## Execution handoff

Plan complete. Path: `docs/superpowers/plans/2026-05-25-stripe-connect-tiered-pricing.md`

**Two execution options:**
1. **Subagent-Driven** (recommended for plan this size) — fresh implementer per task, two-stage review (spec compliance then code quality). Fast iteration, parallel-safe.
2. **Inline Execution** — execute tasks in this session w/ checkpoints. Serial but no context switches.

Operator pre-flight required regardless:
- Stripe Dashboard: create 6 Prices (3 monthly + 3 add-on one-offs)
- Stripe Dashboard: create Connect webhook endpoint, copy `STRIPE_CONNECT_WEBHOOK_SECRET`
- Vercel Preview env: set all 7 new env vars
- Resend Dashboard: confirm catch-all on `replies.<domain>` already routes `thread-<id>@...`

Say go when ready. Recommend Subagent-Driven for this plan's size (~16 tasks, several touching Stripe API which subagents handle well in isolation).

---

## Research-backed Infrastructure Additions (Tasks 17-24)

Bolt-on tasks that compound marketing leverage + de-risk operations. Each cites the research backing.

### Task 17: Onboarding stage-time analytics

**Research backing:** Drop-off curves (Nielsen Norman Group · Hick's Law). The longest step in a funnel is where you lose people. Without per-stage time-to-complete data, you optimize blind.

**Files:**
- Modify: `lib/funnelMetrics.ts` — emit stage-time alongside stage transitions
- Modify: `app/admin/funnel/page.tsx` — add per-stage avg/median time-to-complete column

- [ ] **Step 1: Extend funnelRecord to compute time-since-previous-stage**

```ts
// lib/funnelMetrics.ts
// Add an optional 'sinceStage' field that funnelRecord queries for the
// recipient's most-recent prior stage event, computes elapsed seconds,
// and stamps onto the new event's Metadata JSON.

export interface FunnelEvent {
  // ...existing fields...
  sinceStage?: string;  // e.g. 'signup' when emitting 'engaged'
}

// In funnelRecord:
let elapsedSeconds: number | undefined;
if (event.sinceStage && (event.buyerId || event.rancherId)) {
  try {
    const targetId = event.buyerId || event.rancherId;
    const linkField = event.buyerId ? 'Buyer' : 'Rancher';
    const safeId = (targetId || '').replace(/"/g, '\\"');
    const safeStage = event.sinceStage.replace(/"/g, '\\"');
    const priors: any[] = await getAllRecords(
      FUNNEL_TABLE,
      `AND(SEARCH("${safeId}", ARRAYJOIN({${linkField}})), {Stage} = "${safeStage}")`,
    );
    priors.sort((a: any, b: any) => new Date(b['Created At']).getTime() - new Date(a['Created At']).getTime());
    if (priors[0]) {
      elapsedSeconds = Math.floor((Date.now() - new Date(priors[0]['Created At']).getTime()) / 1000);
    }
  } catch (e: any) {
    console.warn('[funnelMetrics] stage-time computation failed:', e?.message);
  }
}
// Write elapsedSeconds into Metadata JSON.
```

- [ ] **Step 2: Update contracts to pass sinceStage**

In `lib/contracts/buyer.ts` transitionBuyerStage → pass `sinceStage: 'signup'` when transitioning OUT of NEW. Similar threading through other contracts.

- [ ] **Step 3: Dashboard renders P50 + P95 stage time**

Aggregate Metadata.elapsedSeconds per stage; render in /admin/funnel as a third column on the stage table.

- [ ] **Step 4: Type-check, commit, push**

### Task 18: Activation-moment automation (peak-end memory anchor)

**Research backing:** Peak-end rule (Kahneman). People remember an experience by its peak moment + its end. First successful payout IS the peak. Engineering an explicit celebration with verifiable proof (Stripe payout screenshot) makes it sticky.

**Files:**
- Modify: `app/api/webhooks/stripe-connect/route.ts` — on payout success, fire celebration
- Create: `lib/firstPayoutCelebration.ts` — generate shareable proof
- Modify: `lib/email.ts` — new sendFirstPayoutCelebration template

- [ ] **Step 1: Build celebration helper**

```ts
// lib/firstPayoutCelebration.ts
// Triggered ONCE per rancher on their FIRST successful payout.
// Emits:
//   - Email to rancher with payout details + suggested social share text
//   - Telegram celebration to operator with rancher + amount
//   - Funnel event 'first_payout_celebrated' for analytics
// Stripe payout URL goes in the email so rancher has verifiable proof
// they can screenshot + post.

export async function celebrateFirstPayout(input: {
  rancherId: string;
  payoutId: string;
  amountCents: number;
  stripePayoutUrl: string;  // https://dashboard.stripe.com/payouts/po_xxx
}) {
  // Read rancher row, check if Already-Celebrated field set; if so, skip.
  // If not: set field, fire email + Telegram + funnel.
}
```

New Ranchers field: `First Payout Celebrated At` (datetime) — idempotency guard.

- [ ] **Step 2: Wire into stripe-connect webhook on `payout.paid`**

Check if rancher has prior payouts. If this is the first paid one → call celebrateFirstPayout.

- [ ] **Step 3: Type-check, commit, push**

### Task 19: Stripe Tax + branded Customer Portal (operator config)

**Research backing:** Cognitive consistency (Cialdini) — when buyer is handed off to Stripe Checkout / Customer Portal, brand discontinuity erodes trust. Branding Stripe surfaces = "feels still on BHC."

**Files:** Operator-only — no code.

- [ ] **Step 1: Brand Customer Portal in Stripe Dashboard**

Settings → Branding → upload BHC logo, set primary color charcoal `#0E0E0E`, accent saddle `#6B4F3F`. Affects: hosted Checkout, Customer Portal, hosted Invoice, payout statements.

- [ ] **Step 2: Enable Stripe Tax for platform fees**

Settings → Tax → Activate. Stripe automatically calculates + collects state sales tax on platform commission revenue. Reduces 1099/sales-tax compliance burden — research-backed risk reducer for small platforms.

- [ ] **Step 3: Document in operator playbook**

Add note to `docs/SYSTEM-MAP.md` or ops doc: "Stripe Tax handles platform's state sales tax. Each rancher handles their own state sales tax on the meat itself (rancher's responsibility per Business Model section)."

### Task 20: Airtable daily backup to Vercel Blob

**Research backing:** Disaster recovery (Google SRE book). Airtable doesn't auto-backup. A single accidental table delete = recoverable from Stripe + Airtable Activity log but only if you know it happened within 7 days. Daily JSON snapshot pushed to Vercel Blob = 1 week of point-in-time restores.

**Files:**
- Create: `app/api/cron/airtable-backup/route.ts`
- Modify: `vercel.json` — new cron schedule

- [ ] **Step 1: Backup cron**

```ts
// Snapshot Ranchers + Consumers + Referrals + Payments + Payouts +
// Add-On Purchases + Threads + Thread Messages + Funnel Events tables
// as JSON. Upload to Vercel Blob with date-stamped key. Keep 14 days
// of snapshots (delete older).
```

- [ ] **Step 2: Schedule daily 03:00 UTC**

Add to vercel.json: `{ "path": "/api/cron/airtable-backup", "schedule": "0 3 * * *" }`

- [ ] **Step 3: Restore docs**

Write `docs/RESTORE-FROM-BACKUP.md`: how to pull a backup + restore via Airtable MCP.

- [ ] **Step 4: Type-check, commit, push**

### Task 21: Tier upgrade nudge cron (loss-aversion retention lever)

**Research backing:** Loss aversion (Kahneman). Showing a Pasture rancher who closed 3+ deals last month "If you'd been on Ranch you'd have saved $X in commission" is a heavier persuasion than "Upgrade for marketing perks." Loss framing > gain framing in retention contexts (research consensus: ~2x stronger).

**Files:**
- Create: `app/api/cron/tier-upgrade-nudge/route.ts`
- Create: `lib/email.ts` new helper `sendTierUpgradeNudge`

- [ ] **Step 1: Cron logic**

Weekly Monday 14 UTC. For each Pasture rancher:
- Sum Sale Amount of last-30d Closed Won referrals
- Compute commission paid at Pasture rate (7%)
- Compute commission they WOULD have paid at Ranch rate (3%)
- Delta = savings if they'd been on Ranch
- If delta > Ranch monthly fee ($350) - Pasture monthly fee ($150) = $200/mo:
  fire `sendTierUpgradeNudge` with: deltaSavings, dealCount, dealVolume

Throttle: max 1 nudge per rancher per 30 days (use new Ranchers field `Tier Upgrade Nudge Sent At`).

- [ ] **Step 2: Email template**

Loss-aversion copy:
> 💸 You paid $X in BHC commission last month.
> On Ranch tier, that would have been $Y.
> Net savings if you'd been on Ranch: $Z/mo.
>
> Upgrade is one click + proration handled by Stripe. Cancel anytime.
> [ Upgrade to Ranch → ]

- [ ] **Step 3: Type-check, commit, push**

### Task 22: Abandoned tier-select recovery cron

**Research backing:** Abandoned-cart recovery is the highest-ROI email type in e-commerce (Baymard Institute · ~30% recovery rate on simple reminders).

**Files:**
- Create: `app/api/cron/tier-abandoned-recovery/route.ts`

- [ ] **Step 1: Cron logic**

Daily 16 UTC. Find ranchers where:
- `Pricing Model = tier_v2`
- `Subscription Status` in (none, null, canceled)
- `Created` (signup) > 24h ago AND < 7 days ago
- Has at least 1 Stripe Checkout Session (we know they started)

For each: send recovery email with prefilled tier-pick link. Stamp `Tier Abandoned Recovery Sent At` to throttle.

- [ ] **Step 2: Email template**

> Saw you started picking a plan but didn't finish.
>
> Quick recap: the only thing standing between you and a buyer in <state> is picking your tier. Takes 90 seconds.
>
> [ Pick Pasture · $150 ]  [ Pick Ranch · $350 ]  [ Pick Operator · $500 ]
>
> Reply if you have questions — Ben.

- [ ] **Step 3: Type-check, commit, push**

### Task 23: UTM attribution through full funnel

**Research backing:** Channel ROAS measurement (HubSpot · Mixpanel). Without per-channel signup → close attribution, ad spend optimization is blind. BHC already captures UTM on signup; extend to persist through to first payout so marketing channel CAC + LTV are computable.

**Files:**
- Modify: `lib/contracts/buyer.ts` — pass UTM through createBuyer
- Modify: `lib/funnelMetrics.ts` — attach utm to all subsequent events for the same buyer
- Modify: `app/admin/funnel/page.tsx` — UTM breakdown view

- [ ] **Step 1: Read consumer.Campaign + UTM Parameters on every funnel event**

In `funnelRecord`, if `buyerId` set, look up the consumer's `Campaign` + `UTM Parameters` and include in Metadata JSON. So 'deposit_paid' event for buyer X carries the same UTM as their 'signup' event.

- [ ] **Step 2: Admin dashboard tab — per-UTM funnel**

New page `/admin/funnel/attribution`. Tabbed view: pivot by Campaign, by UTM Source, by UTM Medium. Computes signup → engaged → matched → deposit_paid → close:won per cell.

- [ ] **Step 3: Type-check, commit, push**

### Task 24: Stripe Events table — idempotency + audit trail

**Research backing:** Stripe webhook docs explicitly recommend storing event ids for idempotency. Without it, retries (Stripe retries up to 3 days) can re-process the same event → double-charge / double-payout / corrupt state.

**Files:**
- Create: Airtable `Stripe Events` table (via MCP)
- Modify: `app/api/webhooks/stripe/route.ts` — dedup on `event.id` before processing
- Modify: `app/api/webhooks/stripe-connect/route.ts` — dedup on `thinEvent.id`

**Schema:**
- Stripe Events: Event Id (primary, text), Event Type (text), Account Id (text, nullable for platform events), Received At (datetime), Processed At (datetime), Status (singleSelect: received / processed / failed), Error (long text)

- [ ] **Step 1: Create table via MCP**

- [ ] **Step 2: Wrap webhook handlers**

At start of every webhook POST: check Stripe Events table for existing row with same Event Id. If found AND status='processed' → return 200 immediately. Else: create row with status='received', process, then update status='processed' (or 'failed' + Error on throw).

- [ ] **Step 3: Type-check, commit, push**

---

## Final ladder (24 tasks)

| # | Task | Where |
|---|------|-------|
| 0 | Stripe MCP product setup + Vercel env | This session |
| 1 | Airtable schema (incl. legacy backfill) | This session |
| 2 | lib/tiers.ts | This session |
| 3 | /partner public page | Subagent or this session |
| 4 | Tier subscription endpoints | Subagent |
| 5 | Tier checkout landing + /rancher/billing | Subagent |
| 6 | Stripe webhooks (V2 thin events) | Subagent |
| 7 | Connect Express onboarding (V2 API) | Subagent |
| 8 | Buyer deposit flow + fulfillment-aware page | Subagent |
| 9 | Fulfillment confirm + payout release | Subagent |
| 10 | Add-on à la carte purchase | Subagent |
| 11 | Setup wizard tier + fulfillment + dashboard banners | Subagent |
| 11.5 | Legacy rancher opt-in upgrade | Subagent |
| 12 | Admin payments dashboard | Subagent |
| 13 | Payout reconcile + stuck-deposit guards | Subagent |
| 14 | 7-day soak | Operator + me observing |
| 15 | 3-pass audit | Subagent |
| 16 | Canary ship (5-phase ladder) | Operator + me |
| 17 | Onboarding stage-time analytics | Subagent |
| 18 | Activation moment automation | Subagent |
| 19 | Stripe Tax + branded portal (config) | Operator |
| 20 | Airtable backup cron | Subagent |
| 21 | Tier upgrade nudge cron | Subagent |
| 22 | Abandoned tier-select recovery cron | Subagent |
| 23 | UTM attribution through funnel | Subagent |
| 24 | Stripe Events table + webhook idempotency | Subagent |
