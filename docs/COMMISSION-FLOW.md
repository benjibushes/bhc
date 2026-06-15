# BHC Commission Flow

Canonical state machine for buyer-rancher referrals + commission capture. Born from the 2026-05-20 Ashcraft / Eric Turner incident — codify the model so it doesn't drift.

> **⚠️ 2026-06-15 scope note.** This doc describes the **legacy post-close commission model** (rancher runs the sale, BHC invoices a % afterward via `createCommissionInvoice`). That model is still live **for legacy ranchers**, but it is no longer the primary money path. **tier_v2 is now LIVE** (launched 2026-06-15): commission is collected **upfront** as a Stripe Connect `application_fee_amount` on the buyer's **deposit**, and the final invoice is fee-free. For the tier_v2 deposit mechanics and the full revenue map, see [`MONEY-FUNNELS.md`](MONEY-FUNNELS.md) and [`BHC-PLATFORM-MAP.md`](BHC-PLATFORM-MAP.md). The `commission-invoices` cron (this doc's flow) now **skips tier_v2 ranchers** so commission is never taken twice.

## State machine

```
[Pending Approval] → [Intro Sent] → [Rancher Contacted] → [Negotiation]
                                                              ↓
                          ┌───────────────────────────────────┤
                          ↓                                   ↓
                  [Awaiting Payment]                    [Closed Lost]
                          ↓
                  rancher confirms via dashboard
                  "Confirm Payment Received" button
                  (or operator Telegram reply)
                          ↓
                    [Closed Won]
                          ↓
                  Stripe invoice fires
                  (per-rancher rate × sale)
                          ↓
                  Stripe webhook → invoice.paid
                          ↓
                  Commission Paid = true
```

## Rules

1. **Commission Rate locked at sign-agreement.** Every Active rancher MUST have a numeric `Commission Rate` on their record. Set by `app/api/ranchers/sign-agreement/route.ts` at agreement-signing time. Falls back to env `NEXT_PUBLIC_COMMISSION_RATE` only when admin hasn't pre-set a per-rancher rate.

2. **Closed Won fires invoice immediately.** Sale Amount + per-rancher commission rate → Stripe invoice → `Stripe Invoice URL` persisted on the Referral. Stripe sends the hosted invoice email; the webhook flips `Commission Paid=true` on `invoice.paid`.

3. **Awaiting Payment defers invoice.** When a rancher closes off-platform (buyer pays on delivery, Venmo, cash, etc.), Status moves to `Awaiting Payment`. NO invoice. The rancher confirms via:
   - Dashboard "Confirm Payment Received" button → `POST /api/rancher/referrals/[id]/confirm-payment` with `{ saleAmount, method }`
   - OR Telegram operator reply with the dollar amount
   When confirmed, Status flips → `Closed Won` and the Stripe invoice fires.

4. **Hard gates on every close path.** None of these proceed unless inputs pass:

   | Gate | Where | Effect on fail |
   |---|---|---|
   | `saleAmount > 0` | dashboard PATCH, quick-action `won`, Telegram reply | 400 + re-prompt |
   | `hasLockedCommissionRate(rancher)` | dashboard PATCH, quick-action `won`, Telegram reply, confirm-payment | 400 + "no rate locked, contact support" |
   | `saleAmount >= $50` | `createCommissionInvoice` (`lib/stripe-commission.ts`) | throw + loud operator signal |
   | Commission/sale ratio in `[3%, 20%]` | `createCommissionInvoice` | throw + loud operator signal |
   | Telegram `clcheck_won` requires text-reply | `app/api/webhooks/telegram/route.ts` | Status NOT flipped until reply parses |

5. **Audit nightly.** `nightly-rancher-audit` checks every Closed Won + Awaiting Payment row:
   - Check 11: Closed Won missing Stripe Invoice URL → critical
   - Check 12: Closed Won Sale Amount < $50 → critical (placeholder)
   - Check 13: Closed Won ratio outside [3%, 20%] → critical (drift)
   - Check 14: Awaiting Payment aging >14d → warn (needs rancher follow-up)

6. **Awaiting Payment nudge cron** (`awaiting-payment-nudge`, daily 17 UTC) pings the operator for any Awaiting Payment ref older than 14d. Throttle 7d/ref via `Rancher Reminded At`.

## Close paths — full inventory

There are exactly three ways a referral moves into Closed Won:

| Path | File | Auth | Gate set |
|---|---|---|---|
| Dashboard PATCH | `app/api/rancher/referrals/[id]/route.ts` | Rancher session cookie | saleAmount > 0, locked rate |
| Email button (quick-action) | `app/api/rancher/quick-action/route.ts` | JWT-signed link in rancher email | saleAmount > 0, locked rate |
| Telegram reply (operator) | `app/api/webhooks/telegram/route.ts` (close-marker reply intercept) | Telegram chat ID | saleAmount > 0, locked rate, ratio + floor in stripe-commission.ts |

There is ONE way a referral moves into Awaiting Payment:

| Path | File | Trigger |
|---|---|---|
| Dashboard PATCH with status='Awaiting Payment' OR Telegram reply 'awaiting' | dashboard / telegram | rancher reports close, buyer hasn't paid yet |

There is ONE way Awaiting Payment moves into Closed Won:

| Path | File | Trigger |
|---|---|---|
| `POST /api/rancher/referrals/[id]/confirm-payment` | rancher dashboard "Confirm Payment Received" button | rancher received money |

There is **no** `/confirmpaid` Telegram command (it was never built, and the dead advertisement of it was removed 2026-06-15). The dashboard "Confirm Payment Received" button is the real path; an operator can also reply to the Telegram close-marker card with the dollar amount.

## Per-rancher Commission Rate field

- Type: `percent`, precision 4 (supports e.g. 0.0525 = 5.25%)
- Set at: `app/api/ranchers/sign-agreement/route.ts` POST (locks env default OR pre-set admin value)
- Stamp: `Commission Rate Locked At` (audit trail)
- Override: admin via Airtable UI any time
- Read by: `lib/commission.ts::getRancherCommissionRate(rancher)` → falls back to env when null/zero

## Stripe invoice path

1. Close path computes `Commission Due = saleAmount * rancher.Commission Rate`
2. Close path calls `createCommissionInvoice` (`lib/stripe-commission.ts`)
3. `ensureStripeCustomer` creates or reuses the rancher's Stripe Customer ID (cached on `Ranchers.Stripe Customer ID`)
4. Create draft invoice with `collection_method='send_invoice'`, `days_until_due=30`, `auto_advance=false`
5. Attach line item with the commission amount
6. Finalize → moves draft → open, generates hosted invoice URL + PDF
7. `sendInvoice` emails the rancher
8. Webhook flips `Commission Paid=true` on `invoice.paid` event

## Failure modes blocked as of 2026-05-20

- ❌ Tap "Won" in Telegram → Status flipped without sale (**BLOCKED**: text-reply intercept)
- ❌ Sale $1 placeholder + manual $95 commission (**BLOCKED**: floor + ratio guards)
- ❌ Invoice fires before rancher collected (**BLOCKED**: Awaiting Payment state)
- ❌ Ad-hoc commission rate per deal (**BLOCKED**: per-rancher locked rate)
- ❌ Closed Won missing Stripe Invoice URL (**DETECTED**: nightly audit Check 11)

## Failure modes NOT yet blocked (known)

- Rancher manually edits Sale Amount in Airtable after Stripe invoice fires → no invoice update path. Operator must cancel + re-fire manually. Could automate via a "rebill" admin endpoint later.
- `Commission Paid=true` set manually via Telegram `markpaid` button doesn't email a receipt to the rancher (until PR #34 lands).
- This legacy invoice path fires from BHC's own Stripe account (not split-paid). **Note (2026-06-15):** Stripe Connect is now live for tier_v2 — those ranchers collect via on-platform deposits with the commission taken upfront as an `application_fee`, so this post-close invoice path applies to **legacy ranchers only**. (Originally tracked as "Phase 1 of VISION.md"; that phase has shipped.)

## When something looks wrong

Use the cron-debug skill (`.claude/skills/bhc-cron-debug`) or run the Telegram `/cronstatus` command to see the nightly audit output. Anomaly Checks 11-14 are designed to be loud enough that bad rows surface within 24h.

For a specific deal, run `bhc-flow-debug`:
- Pull the Referral record's full field set (especially Sale Amount, Commission Due, Stripe Invoice URL, Status, Closed At)
- Pull the Rancher record's Commission Rate + Commission Rate Locked At
- Check Vercel logs for `createCommissionInvoice` + the referral ID

## History

- **2026-05-20**: Ashcraft / Eric Turner incident — `clcheck_won` Telegram path bypassed every saleAmount gate. Triggered this bulletproofing. See `docs/superpowers/plans/2026-05-20-bulletproof-invoice-capture.md`.
- **PR #30**: dashboard PATCH gained the saleAmount > 0 hard gate (predecessor of T3).
