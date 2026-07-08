# Payment Plans — Backup Build (parked 2026-07-08)

Ben's ask: buyers get payment plans, ranchers still collect the full order
amount. Researched (4-agent sweep + reconciliation, all claims sourced) and
parked as the next build when the time comes. Nothing here is built.

## The three rails, ranked

### Rail 1 — Stripe BNPL (Affirm / Klarna) · BUILD FIRST, ~1 day
The provider IS the payment plan. Buyer pays Affirm/Klarna in installments;
the **rancher (connected account) is paid the FULL amount up front on standard
payout timing**; the provider eats installment + default risk. Zero lending
exposure for BHC.

Verified mechanics:
- Works on Connect **direct charges** with `application_fee_amount` — our
  exact architecture. Capabilities per connected account:
  `affirm_payments`, `klarna_payments` (request like `card_payments`, or flip
  "On by default" in Dashboard → Connect → Manage payment methods).
- Works in our **deferred-intent Payment Element** (#318-#320). Requirement:
  `return_url` on confirm (BNPL always redirects) + fulfill on
  `payment_intent.succeeded` webhook (already our pattern).
- Fees: Affirm 6% + 30¢, Klarna 5.99% + 30¢ — **deducted from the rancher's
  balance** (direct-charge rule), our application fee unaffected.
  **Surcharging the fee to the buyer is contractually banned by all
  providers** — it goes in the sticker price or the rancher margin, never as
  a line item.
- Ticket fit: Affirm $35–$30k (best fit — covers every share), Klarna Pay-in-4
  to ~$1k + monthly financing to $10k. **Skip Afterpay** (perishable food =
  "Restricted Good" needing written permission, ~$2k practical cap, 14-day
  delivery default).
- Category: Affirm + Klarna are clean for perishable beef (Klarna runs
  DoorDash/Instacart groceries). Precedent: **McBee Meat Co finances half/whole
  beef deposits with Affirm**; TruBeef runs Shop Pay Installments (Affirm) on
  $50–$17.5k beef orders.
- Framing fences: sell "processed beef share" (Stripe's Affirm terms prohibit
  **live animals** — never frame as live-animal ownership) and state a firm
  delivery window (Affirm prohibits speculative fulfillment).

**ONE OPEN ITEM before enabling on the deposit rail:** Stripe's Affirm doc
page lists "pre-orders" as prohibited while Affirm's own policy PDF does not
(only crowdfunding-style speculative fulfillment) and Affirm's docs support
extended auth windows for pre-order merchants. Ask Stripe support whether a
deposit-reserved share with a stated 4–8 week delivery window qualifies.
Product-rail purchases (jerky/boxes, ship-now) have no such question — enable
there first.

Build list (when triggered):
1. Dashboard: set Affirm + Klarna "On by default" for connected accounts.
2. `createProductPaymentIntent`: add `payment_method_types` /
   automatic_payment_methods already covers it once capabilities active.
3. Payment Element already renders new methods automatically; verify
   `return_url` path + webhook fulfillment on a $13 test buy.
4. PDP/checkout copy: "or 4 payments with Klarna · monthly with Affirm".
5. Per-rancher pricing note: BNPL fee comes from their balance — disclose in
   rancher dashboard the same way Shipping Cost passthrough is disclosed.

### Rail 2 — BHC layaway ("reserve now, pay while it processes") · BUILD SECOND
Native installments on the deposit rail: deposit locks the share → remaining
balance auto-charged in ≤3 more scheduled off-session charges while the
animal is processed → **beef ships only when paid in full** → rancher settled
in full at fulfillment (same settlement moment as today).

Why this is legally clean (verified, sourced in research):
- **Layaway is expressly NOT credit** under Reg Z (CFPB commentary to 12 CFR
  1026.2(a)(14)) **as long as the buyer is never contractually obligated to
  keep paying**. Missed payment = reservation lapses + refund per policy —
  never an "amount due". Write the buyer agreement exactly that way.
- Second safe harbor: keep it to **4 or fewer total installments, zero
  fees/interest** → never a TILA "creditor" (1026.2(a)(17)) even if
  challenged.
- Card networks explicitly sanction it: Visa's stored-credential framework
  defines "Installment Payments" MIT as a first-class category. Requirements:
  disclosed schedule (dates + amounts + total), cancellation/refund policy,
  retained consent, receipts per charge, 3-day written cancellation
  confirmation.
- State overlays for the checkout disclosure: CA Civ. Code 1749 (written
  terms + refund if goods unavailable), NY GBL 396-t (triggers at 4+
  installments — our ≤4 design sits at/below the line; disclose anyway),
  MD (written + signed, treble damages). One disclosure block covers all.
- FTC expectation: written payment schedule, cancellation/refund policy, any
  charges, merchandise identification. We already do most of this on the
  deposit page.

Build shape (all infra exists): SetupIntent(usage=off_session) at deposit →
saved card on connected account → `installment-charge` cron (off_session
PaymentIntents, MIT flags, claim-before-send, Telegram) → dunning via
existing patterns (retry 3× over 7d, then reservation-lapse email + slot
release via the stale-hold machinery) → settlement unchanged. Estimate: 2–3
days incl. tests + disclosure copy.

### Rail 3 — Factoring (pay rancher at close, collect after delivery) · NOT NOW
The moment BHC advances the rancher and owns a buyer receivable, it is a
consumer lender under state law even at 0% (CA DFPI forced
Afterpay/Klarna/Sezzle/Quadpay to license + refund; NY BNPL Act 2025 requires
DFS license). That is a licensing project + capital float, not a feature.
Revisit at real scale or rent a licensed partner rail.

## Trigger
Say "build payment plans" → Rail 1 ships behind a flag same day (products
first, shares after the Stripe pre-order answer), Rail 2 follows as its own
PR chain.
