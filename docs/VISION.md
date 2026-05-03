# BuyHalfCow — Locked Vision

**Owner:** Ben Beauchman
**Status:** locked-in plan, do-not-pivot, version 1
**Last revised:** 2026-05-02

---

## The Mission

> Take back American ranching. Get families off mystery grocery beef.
> Get ranchers off feedlot commodity pricing.
> One family, one rancher, one freezer at a time.

---

## The Promise

We are building **Shopify for direct-to-consumer beef** — the platform every D2C
rancher in America runs their business on. When we get there, the rancher's
job is "raise good cattle." Everything else — payments, marketing, logistics,
inventory, taxes, financing — runs through us. **We win when ranchers win.**

Not a marketplace skim. Not a lead-gen shop. A platform.

---

## The Give-Back Commitment

This is the part that's locked. Not negotiable. Not contingent on traction.

When the company crosses the threshold of profitability + sustainable cash
flow (defined as: 12 consecutive months of positive operating cash flow on
the marketplace + platform fees alone, audited):

1. **Rancher dividend pool.** A minimum of **15% of net annual profit** is
   distributed quarterly to the verified rancher partners on the platform,
   weighted by GMV they ran through BuyHalfCow that quarter. Ranchers who
   build the network get paid back from the network.

2. **Free platform access for verified small operations.** Any ranch under
   $250k annual revenue waives the 10% commission. We charge for marketing
   services, payments-platform fees, hardware, financing — but the basic
   marketplace stays free for the small operators who keep American ranching
   alive.

3. **Soil health + processor preservation fund.** **5% of net annual profit**
   funds two things:
   - Grants to small USDA-inspected processors at risk of closure (the
     processing-capacity bottleneck is the single biggest threat to D2C beef
     in America)
   - Regenerative grazing practice grants for ranchers transitioning from
     conventional

4. **Equity stays small.** No outside investor takes more than 30% combined.
   Founders + ranchers + employees keep majority forever. The Founding Herd
   ($100k–$1.5M raised pre-launch from believers, not VCs) buys nothing but
   perks + names on the wall — no equity, no SAFE, no securities promise.
   Anyone who tries to convert it later gets refunded.

5. **Open expense ledger.** Every dollar in / dollar out is published quarterly
   to all backers + ranchers. No "private fund operations" line items. If we
   spend it, we say what we spent it on.

This commitment is published on the public Founders Wall and any backer can
hold us to it. If the company is sold or IPO'd, the buyer must agree in
writing to honor these commitments for a minimum of 10 years post-acquisition,
or the sale is blocked by founder veto written into the operating agreement.

**This isn't charity. It isn't tax theater. The ranchers ARE the platform.
Without them there's no business. They get paid back.**

---

## Phased Build — Locked Sequence

### Phase 0 (now → ~30 days) — Marketplace
- /map (verified + self-submitted + prospects)
- /access buyer quiz → /matching/suggest → rancher routing
- /rancher dashboard (close sale, pass lead, view earnings)
- 10% commission via monthly invoice cron
- Founding Herd capital raise: $100k from Founding 100 + $150k from Title Founders

**Status:** SHIPPED (Stage 1 + 1.5 + 2)

### Phase 1 (~30-60 days) — Stripe Connect Foundation
**Goal:** BHC processes every D2C beef payment. Auto-split. Auto-payout.
- Apply for Stripe Connect platform (24h approval)
- Rancher onboarding adds "Connect Stripe" step
- Stripe Connect Express creates rancher's Stripe account inside BHC's flow
- 10% platform fee taken automatically on every charge
- New `Stripe Account ID` field on Ranchers
- `/api/rancher/connect` route handles OAuth flow
- Replace per-rancher `Quarter Payment Link` / `Half Payment Link` /
  `Whole Payment Link` with auto-generated Stripe Checkout sessions
- Webhook listens for `payment_intent.succeeded` → flip Referral to Closed Won
- Decommission monthly commission-invoice cron (replaced by automatic split)
- Pilot with Sackett Ranch + High Lonesome (existing trusted partners)

**Capital required:** ~$15k engineering. Funded by Founding 100.

**What this kills:** manual commission invoicing, payment fragmentation across
3 providers, "send me your bank info" friction.

### Phase 2 (~60-120 days) — Inventory + Processing
**Goal:** rancher logs cattle, buyers reserve specific processing dates,
cut sheets share with USDA processors directly.
- Inventory engine (cattle count + processing date capacity)
- Buyer reservations attach to specific processing date
- Auto-cap on reservations per date → "sold out" gates
- Cut sheet builder for post-purchase customization
- Butcher coordination — share cut sheets directly with processors
- "Reserve your share" UX gets real instead of placeholder

**Capital required:** ~$30k engineering. Funded by mid-tier subscriptions
+ Phase 1 platform fees ramping.

**What this kills:** phone tag between rancher / buyer / butcher on cut
preferences. Reservation chaos.

### Phase 3 (~120-180 days) — Logistics + POS
**Goal:** cold-chain shipping nationally + farmers market POS for ranchers.
- ShipBob (or Veho / similar) integration for cold-chain delivery
- Pre-paid shipping labels auto-generated when buyer chooses delivery
- Stripe Terminal hardware + iPad app for ranchers selling at farmers markets
- Farmers market sales decrement online inventory in real time
- "BuyHalfCow Direct" branded shipping coolers (premium SKU)

**Capital required:** ~$50k engineering + hardware. Partially funded by
Phase 1+2 revenue.

**What this kills:** state-line shipping limitation. Farmers-market /
online inventory split.

### Phase 4 (~180-300 days) — Financing
**Goal:** ranchers get cash advances against future orders.
- Pipe.com or Stripe Capital integration for receivables financing
- Rancher with 50 confirmed reservations gets advance, BHC pulls from
  sales as they close
- Working capital loans for processing fees, freezer trucks, herd
  expansion
- Co-marketed with USDA Rural Development credit programs

**Capital required:** partnership-driven, low engineering cost.

**What this kills:** the working-capital crunch that kills small D2C
operations between processing seasons.

### Phase 5 (post-300 days) — Co-op + Land Bank
**Goal:** the platform becomes the cooperative.
- Verified rancher partners can collectively co-finance shared assets
  (mobile butcher trailer, refrigerated truck, seed equipment)
- Land bank: BHC negotiates discounted land deals for first-generation
  ranchers entering the network
- Mentorship matching: established partners pair with first-generation
  operators
- Optional buying-cooperative for inputs (genetics, hay, fencing)

**Capital required:** capital partner + legal restructure (LLC → benefit
corp / cooperative hybrid).

**What this kills:** the lonely-rancher problem. The "I can't compete
with Tyson" problem.

---

## North Star Metric

The day we can honestly tell a rancher:

> *"Sign up. Connect your bank in 90 seconds. Buyers pay through us. We
> deposit your money in 48 hours. We handle taxes, returns, and shipping.
> You raise the cattle."*

That's Shopify-for-beef.

**Today: ~20% there.**
**Phase 1 ships: ~50% there.**
**Phase 3 ships: ~85% there.**
**Phase 5 ships: 100% there.**

---

## Founder Stake

Personal commitment in writing:
- I take **no salary** above $5k/mo until profitability
- All Founding Herd capital goes to engineering + ranchers + processors —
  zero is paid out as founder distributions until Phase 2 ships
- Quarterly expense ledger published to all backers
- Right to terminate the give-back commitments resides ONLY with a
  supermajority (75%) vote of verified rancher partners — not founders,
  not investors, not employees

This commitment is enforceable. If I violate it, any rancher partner can
trigger the founder-replacement clause in the operating agreement.

**Signed (in the operating agreement, not just in this doc):**
Ben Beauchman, Founder
2026-05-02

---

## What This Document Is

A locked plan. Not a pitch deck. Not a marketing page.

This is the contract with myself, the ranchers, and the backers. The
operating agreement has the legal teeth. This doc has the why.

When investors ask "what are you building," send them this file.
When backers ask "what's the give-back," point them here.
When ranchers ask "are you going to screw us when you scale," show them
this and the operating agreement.

If the docs ever conflict with what we're actually doing, the docs win
and we course-correct the operations. Not the other way around.

---

*The food revolution doesn't happen unless ranchers win.
The ranchers win when we win.
We win when families eat real food.
That's the chain. We don't break it.*

— Ben
