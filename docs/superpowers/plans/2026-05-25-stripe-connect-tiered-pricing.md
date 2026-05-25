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

## Operator setup (Task 0 — one-time, ~30 min)

**Stripe Dashboard (test-mode first, then live):**

1. Create 3 Products:
   - Pasture Membership — recurring price $150/mo
   - Ranch Membership — recurring price $350/mo
   - Operator Membership — recurring price $500/mo

2. Create 3 Add-On Products (one-off prices, charged via Invoice):
   - Custom Video Shoot — $2,500
   - Brand Photo Refresh — $1,500
   - Founder-Letter Campaign — $750
   - (Brand partner intro + PPC management are deal-percentage; tracked manually until volume justifies automation)

3. Activate Stripe Connect Express on the platform account. User confirmed already done.

4. Create webhook endpoints on Stripe Dashboard:
   - Platform endpoint: `https://buyhalfcow.com/api/webhooks/stripe` (existing — extend for subscription + invoice events)
   - Connect endpoint: `https://buyhalfcow.com/api/webhooks/stripe-connect` (new — handles `account.updated` for onboarding state)

5. Copy webhook signing secrets to Vercel Project Settings → Environment Variables (Preview only first):
   - `STRIPE_CONNECT_WEBHOOK_SECRET` (Connect endpoint secret)
   - `STRIPE_PASTURE_PRICE_ID` (Pasture monthly recurring price)
   - `STRIPE_RANCH_PRICE_ID`
   - `STRIPE_OPERATOR_PRICE_ID`
   - `STRIPE_ADDON_VIDEO_PRICE_ID`
   - `STRIPE_ADDON_PHOTO_PRICE_ID`
   - `STRIPE_ADDON_FOUNDER_LETTER_PRICE_ID`

6. Resend Inbound dashboard — confirm catch-all on `replies.buyhalfcow.com` forwards `thread-<id>@…` to `/api/webhooks/resend-inbound`. Re-test if any routing rules were tier-specific.

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
  - `Tier` (singleSelect: Pasture / Ranch / Operator / None)
  - `Stripe Subscription Id` (text)
  - `Subscription Status` (singleSelect: trialing / active / past_due / canceled / unpaid / none)
  - `Subscription Started At` (datetime)
  - `Subscription Next Invoice At` (datetime)
  - `Stripe Connect Account Id` (text)
  - `Stripe Connect Status` (singleSelect: not_connected / onboarding / active / restricted)
  - `Stripe Connect Connected At` (datetime)
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

- [ ] **Step 1: Add tier-related fields to Ranchers**

Using Airtable MCP create_field on `tbl08y9Be45zNG0OG`:

```
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

field: { name: "Stripe Connect Account Id", type: "singleLineText" }

field: { name: "Stripe Connect Status", type: "singleSelect", options: { choices: [
  { name: "not_connected" }, { name: "onboarding" },
  { name: "active" }, { name: "restricted" }
]}}

field: { name: "Stripe Connect Connected At", type: "dateTime", options: {
  dateFormat: { name: "iso" }, timeFormat: { name: "24hour" }, timeZone: "utc"
}}
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

- [ ] **Step 1: stripeSubscription helpers**

```ts
// lib/stripeSubscription.ts — Stripe Subscription helpers for the 3-tier model.
// Each rancher gets ONE subscription. Tier changes proration via subscription.update.

import Stripe from 'stripe';
import { TIERS, TierSlug } from '@/lib/tiers';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-06-20' as any,
});

export async function getOrCreateCustomer(rancherId: string, email: string, name: string): Promise<string> {
  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data[0]) return existing.data[0].id;
  const cust = await stripe.customers.create({
    email,
    name,
    metadata: { rancherId },
  });
  return cust.id;
}

export async function createTierCheckoutSession(input: {
  rancherId: string;
  customerId: string;
  tier: TierSlug;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string }> {
  const priceId = process.env[TIERS[input.tier].stripePriceIdEnv];
  if (!priceId) throw new Error(`Missing ${TIERS[input.tier].stripePriceIdEnv}`);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: input.customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: { rancherId: input.rancherId, tier: input.tier },
    subscription_data: { metadata: { rancherId: input.rancherId, tier: input.tier }},
  });
  return { url: session.url || '' };
}

export async function changeSubscriptionTier(subscriptionId: string, newTier: TierSlug): Promise<void> {
  const newPriceId = process.env[TIERS[newTier].stripePriceIdEnv];
  if (!newPriceId) throw new Error(`Missing ${TIERS[newTier].stripePriceIdEnv}`);
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const itemId = sub.items.data[0].id;
  await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: itemId, price: newPriceId }],
    proration_behavior: 'always_invoice',
    metadata: { ...sub.metadata, tier: newTier },
  });
}

export async function createCustomerPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }> {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return { url: session.url };
}
```

- [ ] **Step 2: /api/rancher/tier/select POST**

Auth: rancher-session JWT. Body: `{ tier: TierSlug }`. Flow:
1. Read rancher row, check no existing active subscription
2. getOrCreateCustomer
3. createTierCheckoutSession
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

- [ ] **Step 2: Build Connect webhook**

```ts
// app/api/webhooks/stripe-connect/route.ts
import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' as any });
const WEBHOOK_SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  const rawBody = await req.text();
  const sig = req.headers.get('stripe-signature') || '';
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET);
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }
  if (event.type === 'account.updated') {
    const account = event.data.object as Stripe.Account;
    const safeId = account.id.replace(/"/g, '\\"');
    const matches: any[] = await getAllRecords(TABLES.RANCHERS, `{Stripe Connect Account Id} = "${safeId}"`);
    if (matches[0]) {
      const status: 'active' | 'restricted' | 'onboarding' =
        account.charges_enabled && account.payouts_enabled ? 'active' :
        account.requirements?.disabled_reason ? 'restricted' :
        'onboarding';
      await updateRecord(TABLES.RANCHERS, matches[0].id, {
        'Stripe Connect Status': status,
        ...(status === 'active' && !matches[0]['Stripe Connect Connected At'] ? { 'Stripe Connect Connected At': new Date().toISOString() } : {}),
      });
    }
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Type-check + commit + push**

---

## Task 7: Connect Express onboarding

**Files:**
- Create: `lib/stripeConnect.ts`
- Create: `app/api/rancher/connect/start/route.ts`

- [ ] **Step 1: stripeConnect helpers**

```ts
// lib/stripeConnect.ts
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' as any });

export async function createConnectAccount(input: { email: string; businessName: string }): Promise<{ accountId: string }> {
  const account = await stripe.accounts.create({
    type: 'express',
    email: input.email,
    business_type: 'individual',
    business_profile: {
      name: input.businessName,
      product_description: 'Direct-from-rancher beef sales via BuyHalfCow',
      mcc: '0763',
    },
    capabilities: {
      transfers: { requested: true },
      card_payments: { requested: true },
    },
    settings: {
      payouts: { schedule: { interval: 'manual' }},
    },
  });
  return { accountId: account.id };
}

export async function createOnboardingLink(accountId: string, returnUrl: string, refreshUrl: string): Promise<{ url: string }> {
  const link = await stripe.accountLinks.create({
    account: accountId,
    return_url: returnUrl,
    refresh_url: refreshUrl,
    type: 'account_onboarding',
  });
  return { url: link.url };
}
```

- [ ] **Step 2: /api/rancher/connect/start POST**

Auth: rancher-session JWT. Refuses if subscription is not active (rancher must pick a tier first). Refuses if `STRIPE_CONNECT_ENABLED !== 'true'`.

Flow:
1. Read rancher row. If no `Stripe Connect Account Id`, call createConnectAccount; persist.
2. Call createOnboardingLink with returnUrl=`/rancher/billing?connect=done`, refreshUrl=`/api/rancher/connect/start`.
3. Return `{ url }`.

- [ ] **Step 3: Type-check + commit + push**

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

Auth: member-session (buyer). Body: `{ referralId, tier }` — `tier` is the rancher's current tier (server reads from rancher row, doesn't trust client). Validates buyer owns the referral. Reads rancher's `Stripe Connect Status` (must be `active`) and `Tier`. Computes `amountCents` from rancher's tier price + buyer's selected cut size. Calls `createDepositCheckout`. Records pending payment via `recordDeposit`. Returns `{ url }`.

- [ ] **Step 4: Buyer deposit page**

`/checkout/[refId]/deposit` — minimal: shows rancher name + ranch name + cut size selector + "Continue to Payment" button. On click, POST `/api/checkout/deposit` → redirect to Stripe Checkout. Test card 4242 in test mode.

- [ ] **Step 5: Success page**

`/checkout/[refId]/success` — shows "Deposit received" + next steps + "Ask another question" link to `/checkout/[refId]/ask`.

- [ ] **Step 6: Type-check + commit + smoke**

Smoke with Stripe test card 4242 4242 4242 4242 on preview alias once `STRIPE_CONNECT_ENABLED=true` set on preview env.

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

## Task 11: Setup wizard tier-select step + dashboard banner

**Files:**
- Modify: `app/api/rancher/setup/route.ts` — add Tier-select step between profile and Connect bank
- Modify: `app/rancher/setup/page.tsx` — add wizard step UI
- Modify: `app/rancher/page.tsx` — pending-action banner

- [ ] **Step 1: Setup wizard adds tier step**

New step labeled "Pick your plan". Three cards. On select, fire POST `/api/rancher/tier/select` → redirect to Checkout → on return, resume wizard at the Connect bank step.

- [ ] **Step 2: Dashboard banner**

If `Tier=None` OR `Subscription Status != active`: show top banner "Pick your plan to unlock buyer matching →" linking to `/partner`.

If `Stripe Connect Status != active` (but subscription active): banner "Connect your bank to start receiving deposits →" linking to `/api/rancher/connect/start` (will redirect to Stripe onboarding).

- [ ] **Step 3: Type-check + commit + push**

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

Phase 1: merge `stage-3-verticals` → `main` with `STRIPE_CONNECT_ENABLED=false` on prod. Architecture + tier source-of-truth + admin dashboards land but no buyer-facing change.

Phase 2: announce `/partner` page publicly. Flip `STRIPE_CONNECT_ENABLED=true` on prod ONLY for the 2 pilot ranchers via a whitelist env (`STRIPE_CONNECT_PILOT_RANCHER_IDS=rec123,rec456`). Endpoints check whitelist before allowing tier-select OR deposit. (Add this gate in Task 4 + Task 8.)

Phase 3: 7-day pilot in prod with real $50 deposits to pilot ranchers. Verify payouts hit bank. Refund test purchases after verification.

Phase 4: remove whitelist gate; open to all. Email existing ranchers with "your platform now handles deposits" announcement + Customer Portal link.

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
