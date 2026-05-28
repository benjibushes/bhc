# BHC Promise — platform-level trust floor

> Buyers trust the marketplace floor; ranchers compete above it.

The single biggest trust unlock for cold-acquisition Meta ads. Crowd Cow and
ButcherBox both run platform-level 7-day satisfaction guarantees — without one,
a rancher who writes "NO REFUNDS EVER" in their self-written Refund Policy
tanks buyer trust right before the Continue-to-Stripe button.

This doc is the source of truth for the policy, when it triggers, who pays,
and how ops handles claims.

---

## The promise (verbatim)

This copy MUST stay in sync with the block rendered on
`app/checkout/[refId]/deposit/page.tsx`.

> **🛡️ BHC PROMISE**
>
> Beef arrives frozen and on time, or BHC refunds your deposit within 7 days —
> no questions asked, paid by BuyHalfCow.
>
> - **Cold-chain guarantee:** if your beef arrives thawed, it's free.
> - **7-day satisfaction:** not what you expected? Full deposit refund.
> - **We mediate:** any dispute, reply to your match thread and we step in.

---

## Trigger conditions

The BHC Promise fires in two scenarios. Anything else falls under the
rancher's own refund policy (which applies above and beyond this floor).

### 1. Cold-chain failure

- **Trigger:** Buyer reports beef arrived thawed.
- **Window:** Must be reported within **24 hours of receipt**.
- **Evidence required:** Photo of the package state on arrival (thawed
  vacuum-seal bags, warm cooler, melted dry ice, etc.).
- **Outcome:** Full deposit refund. The rancher is not held financially liable
  for cold-chain failures caused by the shipper — BHC absorbs the cost via the
  application_fee reserve.

### 2. 7-day satisfaction window

- **Trigger:** Buyer requests a refund within **7 days of receipt** for any
  reason. "No questions asked" is the promise — ops does not interrogate.
- **Window:** 7 calendar days from confirmed delivery / pickup.
- **Outcome:** Full deposit refund. The deposit is the only amount covered —
  remaining balance (paid at processing) is governed by the rancher's own
  policy.

Anything outside these two windows (e.g. taste preference complaint on day
12, partial refund requests, custom-cut disputes) routes to the **above-and-
beyond resolution path** below.

---

## Funding source

The BHC Promise is paid from the **application_fee reserve** — BHC's commission
pool from Stripe Connect destination charges. The mechanics:

- Every deposit charges through Stripe with `application_fee_amount` set to
  BHC's commission.
- That commission accumulates in BHC's Stripe balance as the reserve.
- When a Promise claim fires, the refund issues with
  `refund_application_fee: true` so both BHC and the rancher contribute
  proportionally back to the buyer. Net effect: BHC eats its commission, the
  rancher returns the deposit portion they received.

This keeps the program self-funded — no separate insurance product, no balance
sheet exposure beyond what's already been earned.

### Reserve sizing target

- **Target reserve floor:** ~**1.5% of trailing GMV**.
- Above ~2% sustained claim rate over a quarter, escalate — that's not a
  refund cost issue, that's an upstream quality control signal (bad rancher,
  bad shipper, bad cut representation).

---

## Above-and-beyond resolution path

Issues outside the two trigger windows fall to the rancher's self-written
refund policy. The path:

1. Buyer replies to their match thread describing the issue.
2. The thread routes to the rancher's inbox (and CCs BHC ops).
3. Rancher and buyer attempt to resolve directly per the rancher's policy.
4. If the two cannot agree, BHC mediates from the same thread. We do not have
   binding arbitration authority — we facilitate. In practice, repeated
   complaints against one rancher feed back into capacity/visibility
   decisions on the rancher side.

The softener line rendered below the rancher's verbatim policy on the deposit
page captures this:

> Above and beyond BHC's Promise, [Rancher Name]'s own policy applies. For
> disputes, reply to your match thread — BuyHalfCow can mediate.

---

## Ops process — handling a Promise claim

1. **Intake.** Buyer replies to match thread. Inbound email routing tags the
   thread; ops sees it in the support queue.
2. **Triage.** Confirm the claim fits a trigger (cold-chain within 24h with
   photo, or 7-day no-questions). If yes, this is a Promise claim. If no, it
   routes to above-and-beyond.
3. **Refund.** Open `/admin/payments` (Task 12 console). Find the deposit
   charge by referral ID. Hit the Refund button.
4. **Stripe fires** with `refund_application_fee: true` — both BHC and the
   rancher contribute proportionally back to the buyer.
5. **Audit.** `logAuditEntry` stamps the reason as one of:
   - `bhc-promise-cold-chain` — failed cold-chain claim
   - `bhc-promise-claim` — generic 7-day satisfaction claim
6. **Buyer reply.** Send a brief confirmation through the match thread. No
   apology theatre — the promise is the promise.
7. **Rancher notification.** The webhook fires the rancher's
   `payment_intent.refunded` notification. Their dashboard reflects the
   reduced payout.

---

## Annual review

Track these metrics quarterly:

- **Claim count.** Total Promise claims fired this quarter.
- **Claim rate.** Claims / total deposits.
- **Reserve burn.** Total refunded application_fee / total application_fee
  earned. Target <1.5%; escalate at >2%.
- **Per-rancher claim rate.** Any rancher >5% claim rate gets a quality
  conversation. Repeated patterns trigger pause-routing (see
  `bhc-ops:pause` flow).
- **Trigger mix.** Cold-chain vs 7-day satisfaction. A spike in cold-chain
  claims = shipping partner problem, not rancher problem.

Annual review (every Dec): publish the claim rate publicly as a trust
signal. ButcherBox & Crowd Cow do not do this — it's a wedge.

---

## See also

- `docs/AUDIT-2026-05-25-research-d2c-best-practices.md` — research that
  motivated this floor.
- `docs/COMMISSION-FLOW.md` — application_fee mechanics.
- `app/checkout/[refId]/deposit/page.tsx` — rendered promise block.
- `app/admin/payments/page.tsx` — refund console (Task 12).
