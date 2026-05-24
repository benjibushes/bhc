# Phase 1: Stripe Connect Express — Engineering Scope

**Why this matters:** Today, ranchers receive payment via manual Stripe
Payment Links pasted on their dashboard. We invoice them for commission
via the monthly `commission-invoices` cron. This works at 7 ranchers
but breaks at 100. Phase 1 replaces this with Stripe Connect Express:
buyers pay through BHC, BHC takes commission automatically via Stripe
Application Fee, rancher's 90% deposits to their bank in 48h. Zero
operator action. Zero manual invoices.

**Funded by:** Founding Herd capital (~$15k cap × 100 backers, target
$50k first quarter).

**Engineering estimate:** 3-4 weeks one engineer (or 1-2 weeks if Claude
ships every task in Subagent-Driven mode).

---

## Goal

When a buyer clicks "Reserve a Half" on `/ranchers/[slug]`:

1. Stripe Checkout session opens (BHC platform)
2. Buyer pays $1,600 (example)
3. Stripe webhook fires: `payment_intent.succeeded`
4. Application Fee splits $160 to BHC + $1,440 to rancher's connected account
5. Rancher gets bank deposit in 24-48h via Stripe Express
6. Referral.Status flips to `Closed Won`, Sale Amount = $1,600,
   Commission Due = $160 (already collected)
7. Commission-invoices cron decommissioned

---

## Architecture

```
┌─────────┐    Pay $1,600    ┌─────────────────┐
│ Buyer   │ ───────────────▶ │ Stripe Checkout │
└─────────┘                  │   (BHC platform)│
                             └─────────────────┘
                                      │
                                      ▼
                             ┌──────────────────┐
                             │ payment_intent   │
                             │ .succeeded       │
                             │ Application Fee  │
                             │ = $160 (10%)     │
                             └──────────────────┘
                                  │         │
                                  ▼         ▼
                             ┌──────┐  ┌──────────┐
                             │ BHC  │  │ Rancher  │
                             │ +$160│  │ +$1,440  │
                             └──────┘  └──────────┘
                                          │
                                          ▼ 24-48h
                                  ┌──────────────┐
                                  │ Rancher bank │
                                  └──────────────┘
```

---

## Tasks (chronological)

### T1: Stripe Connect platform application

**Files:** None (Stripe Dashboard only)

**Steps:**
- Apply for Connect platform at stripe.com/connect
- Express accounts (not Standard — simpler onboarding)
- 24-48h Stripe review
- Set platform name = "BuyHalfCow", branding = bone/charcoal palette

**Verification:** Stripe Dashboard → Connect → "Test mode" button visible

---

### T2: Airtable schema additions

**Files:**
- `/lib/airtable.ts` (TABLES const unchanged — no new table; new fields on Ranchers)

**Add fields to Ranchers:**
- `Stripe Account ID` (singleLineText) — `acct_xxx`
- `Stripe Connect Status` (singleSelect: `pending`, `active`, `restricted`)
- `Stripe Connected At` (dateTime)

**Add fields to Referrals:**
- `Stripe Payment Intent ID` (singleLineText) — `pi_xxx`
- `Stripe Application Fee Amount` (currency)
- `Stripe Transfer ID` (singleLineText)
- `Buyer Paid At` (dateTime)

**Verification:** MCP `list_tables_for_base` shows new field IDs

---

### T3: Rancher Connect OAuth flow

**Files:**
- Create `/app/api/rancher/connect/route.ts` — handles Stripe OAuth callback
- Create `/app/api/rancher/connect/onboard/route.ts` — initiates Express onboarding
- Modify `/app/rancher/setup/page.tsx` — add "Connect Bank" step

**Logic:**
1. Rancher hits setup wizard step "Connect Bank" → "Connect with Stripe" button
2. Click → POST `/api/rancher/connect/onboard` → server creates Stripe Account Link → returns URL
3. Rancher redirected to Stripe Express onboarding (bank, ID, tax)
4. Stripe redirects back to `/api/rancher/connect?account_id=acct_xxx&rancher_id=rec_xxx`
5. Server updates Rancher.Stripe Account ID + status, returns to dashboard

**Verification:** End-to-end in Stripe test mode → see acct_xxx in Airtable

---

### T4: Buyer Checkout session creation

**Files:**
- Modify `/app/api/matching/suggest/route.ts` — instead of returning rancher's pasted Payment Link, generate Stripe Checkout session via Connect with `application_fee_amount = saleAmount * 0.10`
- Modify intro email templates in `/lib/email.ts` to point at new dynamic checkout URLs

**Logic:**
```
stripe.checkout.sessions.create({
  mode: 'payment',
  payment_method_types: ['card'],
  line_items: [{
    price_data: {
      currency: 'usd',
      product_data: { name: `${orderType} Beef from ${ranchName}` },
      unit_amount: saleAmount * 100,
    },
    quantity: 1,
  }],
  payment_intent_data: {
    application_fee_amount: Math.round(saleAmount * 100 * 0.10),
    transfer_data: { destination: rancher.stripeAccountId },
  },
  success_url: `${SITE_URL}/order/success?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${SITE_URL}/ranchers/${ranchSlug}`,
  metadata: { referralId: referral.id },
})
```

**Verification:** Test mode → buyer pays → see app fee in Stripe Dashboard

---

### T5: Webhook handler

**Files:**
- Create `/app/api/webhooks/stripe-connect/route.ts`
- Add `STRIPE_CONNECT_WEBHOOK_SECRET` to Vercel env

**Events handled:**
- `payment_intent.succeeded` → flip Referral → Closed Won, stamp Sale Amount + Stripe Payment Intent ID + Buyer Paid At
- `payment_intent.payment_failed` → flip Referral → Payment Failed, fire ops alert
- `account.updated` → sync Rancher.Stripe Connect Status (active when payouts_enabled=true)
- `transfer.created` → log Stripe Transfer ID on Referral

**Verification:** Stripe CLI replay → all 4 events → Airtable updates

---

### T6: Decommission monthly commission-invoices cron

**Files:**
- Modify `vercel.json` — remove `/api/cron/commission-invoices` schedule
- Modify `/app/api/cron/commission-invoices/route.ts` — return early with deprecation log
- Modify `/app/api/rancher/won/route.ts` (and any Closed Won handlers) — remove `createCommissionInvoice` call when rancher has Stripe Connect (legacy path stays for non-Connect ranchers during migration)

**Verification:** Cron run logs show deprecation; no new invoice rows created for Connect-enabled ranchers

---

### T7: Pilot rollout

**Steps:**
1. Connect Sackett Family Cattle Co + High Lonesome (2 trusted partners)
2. Run 5 buyer-side test purchases in Stripe live mode (refund after)
3. Verify rancher bank deposit lands in 24-48h
4. Telegram alert on first real Connect payment

**Verification:** Telegram message "first Connect payment ✓ $1,600 → Sackett"

---

### T8: Broad rollout

**Steps:**
1. Send rancher email blast — "your dashboard now has bank connect. 90-second
   onboarding. We deposit your money in 48h instead of you chasing invoices."
2. Add Connect prompt to rancher dashboard for any not-yet-connected
3. After 30 days, force migration: legacy commission-invoice path removed entirely

---

## What it unlocks

- Ranchers can pitch "BHC handles taxes, returns, shipping. You raise cattle."
- 80% reduction in operator hours per deal (no manual invoice chase)
- Stripe Dashboard becomes single source of revenue truth
- Foundation for Phase 2 (Inventory + Processing dates)
- Foundation for Phase 3 (Stripe Terminal POS for farmers markets)

---

## Risks + mitigations

| Risk | Mitigation |
|------|-----------|
| Stripe Connect approval rejected | Apply early; have backup plan with manual Stripe Payment Links for 30 more days |
| Rancher doesn't complete bank onboarding | Reminder Telegram + email cadence; dashboard banner persists |
| Webhook missed = order in limbo | Idempotent handler + 6-hour reconciliation cron checks Stripe vs Airtable |
| Refund handling | Hook `charge.refunded` → flip Referral → Refunded, mark commission reversal |
| Disputes | Stripe handles chargebacks; we log to Conversations table for ops review |

---

## Not in scope (Phase 2+)

- Inventory tracking + cut sheets
- USDA processor integration
- Cold-chain shipping (ShipBob)
- Stripe Terminal hardware
- Subscription / repeat-purchase flow
- International expansion (Stripe Connect US-only at first)
