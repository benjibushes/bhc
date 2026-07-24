# BuyHalfCow — Business Model

**Status:** v2 — money model LOCKED
**Last revised:** 2026-07-24
**Audience:** founder reference / backer transparency / investor briefing

---

## ⭐ GROUND TRUTH — the money model (decided 2026-07-24, LOCKED)

*This section is canonical and supersedes everything below it. Where older
sections describe the commission as "deducted from the rancher," billed
monthly, or a "90/10 split," THIS section wins — those are the pre-2026-07
legacy framing. Code, copy, and every new feature conform to this. If a
surface disagrees with this section, the surface is the bug.*

### One line
**A marketplace service fee.** The rancher sets their price and keeps **100%**
of it. BHC's commission is added **on top**, paid by the **buyer** — like a
delivery/marketplace service fee. That fee is BHC's core revenue, collected
automatically at deposit time via Stripe Connect.

### The core mechanic (beef deals — the primary rail)
- Rancher lists a price. **That is what they net, in full.** Nothing deducted.
- BHC fee = **10%** of the full sale price (default; lower on paid tiers).
- At **deposit**, the buyer's card is charged **deposit + BHC fee**. Stripe
  Connect **direct charge on the rancher's connected account** with
  `application_fee_amount` = the fee → the fee routes to BHC atomically, the
  deposit routes to the rancher, in one charge. (`lib/stripeConnect.ts`,
  `createDepositCheckout`.)
- Fee is computed on the **FULL sale**, not the deposit, and captured
  **entirely at deposit** — the **final invoice takes 0 fee**
  (`send-final-invoice`, application_fee=0). BHC never has to chase a cut.
- **Net-your-number:** BHC absorbs the Stripe processing fee out of its own
  side (`absorbStripeFee`) so the rancher's payout lands on the **exact**
  deposit amount. The rancher never eats the Stripe fee either.
- Rancher collects the **balance** (full − deposit) directly at
  pickup/delivery, their own way (cash/check/Venmo/Zelle). BHC doesn't touch it.

**Worked example — $2,999 half, $300 deposit, 10%:**

| | Buyer pays | Rancher nets | BHC keeps |
|---|---|---|---|
| Deposit | $300 + $299.90 = **$599.90** | **$300** | **$299.90** |
| Balance (final invoice) | $2,699 | $2,699 | $0 |
| **Total** | **$3,298.90** | **$2,999** (full price) | **$299.90** (the 10%) |

Rancher keeps every dollar of their $2,999. Buyer paid a $299.90 service fee.

### The five revenue rails
1. **Commission — THE core.** 10% buyer-paid service fee on closed beef deals,
   Connect `application_fee` at deposit. Rancher's **locked** rate honored
   (`Commission Rate` field; `normalizeCommissionRate`: "4"→0.04, 0→0 valid).
2. **Tier subscriptions — trade commission for MRR** as ranchers scale:
   Legacy Connect $0/10% · Pasture $150/mo/7% · Ranch $350/mo/3% · Operator
   $500/mo/0%. Lower buyer fee = more competitive for the rancher; BHC income
   shifts from per-deal fee → predictable MRR. (Detailed in Engine 2 below.)
3. **Product / low-ticket rail** — Shopify-synced boxes + à-la-carte sold at a
   **markup** (`Display Price = ceil(base × (1+markup%)) − .01`,
   `lib/shopifyCatalogSync.ts`); BHC margin = the markup, taken at charge.
4. **Merch** — BHC-owned branded goods (hats, `merch.buyhalfcow.com`) — direct
   product margin.
5. **Gear** — Amazon affiliate (`/gear`) — passive affiliate commission.

*(Founding Herd + marketing-services, described below, are additional
capital/revenue engines but are not the per-transaction money model.)*

### Product / Shopify rail — sync + fulfillment (rail #3, end-to-end)
*Same buyer-pays-on-top model as deposits, applied to physical products. Built
2026-07-21, per-rancher opt-in, code-complete on the token-paste path.*

- **Connect.** Rancher connects Shopify once — pastes an Admin API token today
  (one-click OAuth built but DARK behind `SHOPIFY_PUBLIC_APP_LIVE`). Token +
  secret AES-256-GCM encrypted (`INTEGRATION_TOKEN_KEY`), stored as JSON in
  `Ranchers.'Fulfillment Integration'`. Scopes `write_orders,read_orders,read_products`.
- **Sync (Shopify → BHC).** Every variant WITH a SKU → a `Rancher Products`
  row: `Rancher Base` = their Shopify price (what they net),
  `Display Price = ceil(base × (1+markup%)) − .01`. Re-syncs every 6h + on
  `products/update` webhooks. Imports hidden; operator checks `Marketplace
  Approved` to list on `/shop`. **markupPercent lives only in the connection
  JSON — null markup = display defaults to base = ZERO BHC margin.**
- **Money (per sale).** Identical rail to hand-entered products. Buyer pays
  `display × qty + shipping`; **direct charge on the rancher's connected Stripe
  account**; BHC margin `(display − base) × qty` taken as Stripe
  `application_fee`, split ATOMICALLY at charge time (net-your-number shrinks
  the fee by the est. Stripe cost so the rancher nets exactly base + shipping).
  **BHC never holds the money — there is no payout step.** Shipping is 100%
  passthrough, never in BHC's margin.
- **Fulfillment handoff (BHC → their Shopify).** On payment success,
  settlement writes a `Rancher Orders` row and **auto-pushes the paid order
  into the rancher's Shopify** (`orderCreate` financialStatus PAID, tags
  `['BHC']`, inventory `DECREMENT_OBEYING_POLICY`). Their normal Shopify
  fulfillment ships it; **Shopify emails the buyer the tracking** (BHC
  suppresses its own to avoid double-send). When they mark fulfilled, Shopify's
  `fulfillments/create` webhook stamps `Tracking Number` + `Status='Shipped'`
  back. Ranchers with NO Shopify use the manual "mark shipped" path (BHC sends
  the tracking email). Deposit/pickup orders are never pushed.
- **Order state:** `New` → `External Push Status='pushed'` (+ `External Order
  Id`) → Shopify fulfills → `Shipped` + tracking. Permanent push fail →
  `failed:<err>` + operator alert; transient → blank, retried by
  `fulfillment-push-net` (2h). Refund → `orderCancel` restock → `cancelled`.
- **"I collect" is not literal.** The money splits on the rancher's account at
  charge; BHC's cut lands instantly, no hold, no payout. Say: "sale made, money
  splits automatically, my cut hits my account the moment they pay, then it's
  fulfilled through their own Shopify."
- **Operator must, per rancher:** (1) confirm `INTEGRATION_TOKEN_KEY` set in
  prod, (2) set a markup %, (3) approve products.
- **Hardened 2026-07-24** (#468 + audit batches A–H, 9 PRs): an 8-lens
  adversarial audit found 25 verified defects — all 3 goods-loss blockers
  (duplicate Shopify order on push retry; refunded order still ships;
  whole-beef shares leaking into the one-click rail) plus the silent-failure /
  oversell / supply-stall gaps are fixed. The loop cannot strand a paid order
  or ship twice without an operator alert. Full map: the audit in this session;
  every fix is TDD'd (1701 tests).

### The rules that follow (enforce these in code + copy)
- **Rancher-facing copy:** "You keep 100% of your price. The buyer covers our
  10% on top." NEVER "we deduct 10%" / "minus commission" / "you keep more of
  your check." Those imply the deducted model — WRONG.
- **Buyer-facing copy:** the BHC service fee is shown as part of what the card
  is charged (deposit + fee), like any marketplace fee. The checkout page
  already does this (`app/checkout/[refId]/deposit/page.tsx`).
- **Fee is on the FULL sale, collected at deposit, 0 at final invoice.**
- **Net-your-number is sacred** — rancher payout = listed price, exactly. BHC
  eats the Stripe fee, never the rancher.
- **Connect is mandatory for automatic commission.** Legacy/own-link deposits
  do NOT auto-collect the fee (BHC would have to invoice + chase) — avoid for
  new/untrusted partners. This is why the deposit rail is Connect-first.

---

## TL;DR

BuyHalfCow is the private network connecting American families to verified
direct-to-consumer ranchers, becoming the underlying platform every D2C
beef operation runs on (payments, marketing, logistics, financing). Four
revenue engines ship with Stage 3, fifth and beyond coming as platform layer ships.

**Today (Stage 3):** marketplace commission (legacy) + subscription tiers (tier_v2) + Founding Herd + marketing services
**Imminent (Phase 1):** + payments platform (Stripe Connect automation)
**12 months out:** + inventory mgmt SaaS + logistics markup
**24 months out:** + financing partnerships
**36 months out:** + ranching cooperative

**Defensibility:** the rancher relationships + the Founders Wall (publicly
committed backers) + the integrated payments+logistics stack. Each rancher
who joins makes the network more useful for the next one.

---

## Revenue Engines (today + Stage 3)

### Engine 1 — Marketplace Commission (legacy ranchers, pre-Stage 3)
- **What:** match buyer to verified rancher, take 10% of closed deal
- **Who pays:** the **buyer**, on top of the rancher's price (see ⭐ GROUND TRUTH). *(Historical note: the pre-2026-07 legacy path billed the rancher monthly by invoice — DEPRECATED. The live model collects the buyer-paid fee automatically at deposit via Connect.)*
- **Status:** legacy manual-invoice logic in `lib/stripe-commission.ts` is superseded by the Connect `application_fee` rail in `lib/stripeConnect.ts`. New ranchers operate on the Connect rail.
- **Volume:** ramps with rancher count + marketing spend
- **Margin:** ~95% gross (Stripe fees ~2.9% on commission charge)
- **Unit economics:** ~$1,200 avg order × 10% = $120 commission per close
- **CAC:** ~$15-25 per qualified buyer signup (Meta + organic)
- **LTV:** repeat-purchase rate ~30% over 12 months → ~$280 per buyer

### Engine 2 — Subscription Tiers (rancher support, Stage 3+)
- **What:** rancher chooses monthly subscription tier (Pasture/Ranch/Operator), commits to monthly fee + per-deal commission per `lib/tiers.ts`
- **Who pays:** rancher (monthly subscription via Stripe + post-close commission)
- **Pricing model:** high-monthly / low-commission structure incentivizes rancher commitment + lowers BHC volatility on per-deal basis
- **Tiers:**
  - **Pasture:** $150/mo + 7% commission per closed deal — verified green-pin, custom landing page, automatic matching, reply tracking, capacity controls
  - **Ranch:** $350/mo + 3% commission per closed deal — everything in Pasture + priority routing, listing optimization, case study social posts, featured rancher quarterly, monthly performance review
  - **Operator:** $500/mo + 0% commission per closed deal (flat subscription, zero post-close commission) — everything in Ranch + 2 custom video reels/mo, founder-voice email/mo, fully managed listing, quarterly YouTube feature, brand partner intros, strategy calls
- **Who buys:** ranchers committed to growing on platform long-term; high-volume ranchers prefer Operator to eliminate per-deal drag
- **Volume:** projected ~20-30 ranchers on tier_v2 by end of Stage 3, mix of Pasture (40%), Ranch (35%), Operator (25%)
- **Margin:** ~70% net (payment processing, video production for Operator, and ops labor)
- **Defensibility:** ranchers who commit to monthly + full Stripe integration (payout automation) have real switching cost
- **Reference:** source of truth is `lib/tiers.ts` (Stripe Price IDs, perks, commission rates)

### Engine 3 — Founding Herd (capital + community)
- **What:** 5-tier subscription/lifetime backer program
- **Who pays:** consumers, backers, fans (NOT ranchers)
- **Tiers:**
  - Herd $9/mo or $90/yr — monthly letter + patch + state heads-up
  - Outlaw $25/mo or $250/yr — Herd + public Wall + quarterly drops
  - Steward $75/mo or $750/yr — Outlaw + group call + direct email
  - Founding 100 $1,000 lifetime (cap 100) — numbered Wall + lifetime priority
  - Title Founder $15,000 lifetime (cap 10) — top of Wall + co-build access
- **Cap:** 100 × $1k + 10 × $15k = **$250k pre-launch capital ceiling**
- **Volume:** front-loaded (first 90 days) then long tail of subscriptions
- **Recurring revenue base:** ~$2k MRR by month 12 if 50% Herd + 30%
  Outlaw + 20% Steward at modest scale
- **Margin:** ~70% net (patches + processing costs eat the rest)

### Engine 4 — Marketing Services (the close)
- **What:** rancher onboarding call → optional retainer for marketing services
  (story-driven email, listing optimization, content production, PPC mgmt)
- **Who pays:** rancher who wants growth above what marketplace lead-flow
  delivers
- **Pricing:** $500-$2,500/mo retainer or $5k-$15k content sprints
- **Volume:** ~10-20% of onboarded ranchers convert to retainer
- **Margin:** ~50% net (some labor + tooling)
- **Why it exists:** rancher who closes 1-2 deals from marketplace will
  ALWAYS pay for more deal flow. Marketing services is the upsell that
  scales without scaling the matching engine.

---

## Phase 1 Engine (next 60 days)

### Engine 5 — Payments Platform (Stripe Connect)
- **What:** every D2C beef purchase routes through Stripe Connect → the buyer is charged the rancher's price **plus** BHC's 10% (`application_fee`) → rancher receives 100% of their price, BHC keeps the added 10%. (See ⭐ GROUND TRUTH for exact math — NOT a 90/10 split of the rancher's price.)
- **Replaces:** Engine 1 monthly invoice cycle. Buyer-paid fee, automated, collected at deposit. **This is LIVE, not a future phase.**
- **Plus:** Stripe interchange revenue share on processing fees (~0.5% additional)
- **Plus:** payout speed monetization — rancher can pay $X for instant payout vs 2-day standard
- **Margin:** ~90% net on platform fee, ~95% on payout-acceleration tips
- **Locks in:** every rancher who connects Stripe is now operationally
  dependent on BHC. Stickiness goes from "marketing channel" to "treasury."

---

## Phase 2-5 Engines (6-36 months)

### Engine 6 — Inventory + Processing SaaS ($25-$100/mo per rancher)
Rancher subscription for inventory engine, cut-sheet builder, processor coordination tools.

### Engine 7 — Logistics Markup
Cold-chain shipping at cost +15-20% margin. Stripe Terminal hardware sold at retail with monthly POS subscription.

### Engine 8 — Financing Origination Fee
Receivables advances + working capital loans, BHC takes 1-3% origination fee + spread on partner-funded credit.

### Engine 9 — Buying Cooperative
Bulk purchasing power (genetics, hay, fencing) shared with platform ranchers, BHC takes 1-2% spread.

---

## Cost Structure (today)

### Fixed monthly
- Vercel hosting: ~$50
- Airtable: ~$45
- Resend: ~$50 (will scale)
- Anthropic API (AI ops): ~$200
- Tavily (rancher discovery): ~$50 (one-time scrapes)
- Stripe processing fees: pass-through to revenue
- Telegram bot: free
- Domain + DNS: ~$15

**Total fixed:** ~$400/mo

### Variable
- Resend at scale (~$0.40 per 1k emails sent above 3k/mo)
- Founder patches: ~$8 each (100 × $8 = $800 one-time for Founding 100)
- Calendly Premium: ~$15/mo
- Founder time (currently uncompensated until profitability per Vision doc)

### Capitalized engineering (not monthly)
- Phase 1 build: ~$15k contractor or 4 weeks founder time
- Phase 2 build: ~$30k contractor or 8 weeks founder time

---

## Customer Segments

### Buyers (consumers)
- **Primary:** families wanting real beef, willing to commit $1k-$3k once or twice a year
- **Median order:** Half cow, ~$1,200, ~150 lbs of cuts
- **Geography:** every US state — ranchers are state-local but buyer demand is national
- **Acquisition:** Meta ads, organic SEO, founder narrative, Instagram, word of mouth
- **Persona:** "I'm done with grocery beef but I don't want to drive 90 minutes to a farmers market every weekend"

### Ranchers (sellers / partners)
- **Primary:** small + mid D2C cattle operations (10-500 head), already
  selling some product direct, want more leads + less middleman friction
- **Onboarding source:** self-submit (form), community-flag (fan submits),
  cold scrape (Tavily-driven discovery)
- **Stages:**
  - Yellow pin → submitted, awaiting onboarding
  - Green pin → verified partner, agreement signed, capacity tracked
  - Trust Mode → 5+ closes or 30+ days, no manual approval gate
- **Capacity ceiling:** ~5 active referrals at a time per rancher (configurable)

### Backers (Founding Herd)
- **Primary:** existing buyers + community fans + small investors who
  want skin in the game without equity dilution
- **Acquisition:** founder narrative, social proof Wall, quarterly drops
- **Why they pay:** belief + small perks, NOT financial return
- **Conversion lever:** Founding 100 numbered scarcity (100 spots, ever)

---

## Sales / Funnel Logic

### Buyer Funnel
```
Marketing → /access (quiz) → Score qualifies → Auto-routed to in-state rancher
   ↓ if not qualified                                 ↓
   "Welcome + Ready to Buy" email      Intro email to rancher + buyer
   ↓ (drip until ready)                ↓
   Click YES                            Negotiate → Close
   ↓                                    ↓
   Match fires                          10% commission accrues
```

### Rancher Funnel
```
Submission (self / community / scrape)
   ↓
Welcome email + 3-email drip (Day 2, 5, 14)
   ↓
Optional 15-min onboarding call → docs → agreement
   ↓ (or self-serve wizard skips the call)
Verification → Live (green pin)
   ↓
First-week throttle (5 leads/week, Telegram approve gate)
   ↓ (after 5 closes OR 30 days)
Trust Mode (unthrottled, autonomous)
   ↓
Operational forever (or until paused / non-compliant)
```

### Founder Funnel
```
/founders → Tier select → Stripe Checkout (or capped checkout for Founding 100)
   ↓
Webhook fires (idempotent on Session ID)
   ↓
Airtable row + welcome email + Wall placement + Telegram alert (with
  📧 Email backer + 📅 Calendar invite buttons)
```

---

## State Machines

### Buyer States
```
NEW → WAITING → READY → MATCHED → CLOSED
```
Each transition logged with `Buyer Stage Updated At` for cron timing.

### Rancher States
```
Prospect → Onboarding → Operational → Trusted Partner
```

### Referral States
```
Pending Approval → Intro Sent → Rancher Contacted → Negotiation → Closed Won
                                                                ↓
                                                            Closed Lost
```

---

## Defensibility / Moat

1. **The rancher relationships** — every onboarded rancher's pricing,
   processing dates, capacity, customer references, photos, video, story
   live in BHC's system. Switching cost = "rebuild this from scratch
   somewhere else." Real.
2. **The Founders Wall** — public commitment from named backers to BHC's
   give-back commitments locks the brand into rancher-aligned behavior.
   Hard for a corporate competitor to replicate.
3. **The matching algorithm** — buyer state + capacity + tier specialty +
   price fit + (buyer, rancher) terminal dedup is non-trivial. Years of
   edge-case learnings accumulate.
4. **Data flywheel** — every closed deal teaches the system what kinds of
   buyers convert with what kinds of ranchers. Recommendations get
   better over time. Competitor without 2 years of close data can't match.
5. **Stripe Connect lock-in** (Phase 1) — once a rancher's payments run
   through us, they're not leaving without a structural treasury migration.

---

## Risk Register

### Existential risks
- **USDA processor capacity collapse** — small processors closing forces
  ranchers off platform. Mitigation: Phase 5 Soil Health + Processor
  Preservation fund (5% of profit).
- **Regulatory shift** — interstate D2C beef rules change at the state
  level. Mitigation: state-by-state legal review, partnership with USDA
  Rural Development.
- **Marketplace concentration** — top 3 ranchers carry 50% of GMV. Death
  if any leave. Mitigation: aggressive rancher acquisition + onboarding
  wizard low-friction.

### Operational risks
- **Email deliverability** — Resend reputation tank if bounce rate spikes.
  Mitigation: suppression check on every send, multi-domain rotation
  already wired.
- **Founder dependency** — too much runs through Ben's Telegram. Mitigation:
  hire ops in month 6, document handoffs.
- **Cap-race oversells** — Founding 100 / Title Founder Stripe Payment Link
  race. Documented as 1-oversell-max risk. Mitigation: Phase 1 moves
  Title Founder to capped /api/founders/checkout.

### Strategic risks
- **VC pressure to raise** — accepting outside venture money would force
  10× returns logic that breaks the give-back commitments. Mitigation:
  Founding Herd + revenue self-funds growth. Phase 4 financing partnership
  ≠ equity round.
- **Walmart / Tyson "D2C" entry** — corporates enter the niche with
  feedlot beef pretending to be ranch beef. Mitigation: verification
  rigor, Founders Wall public proof, regenerative grazing grants in
  Phase 5 differentiate "real" from "dressed-up commodity."

---

## Key Metrics to Track

### Product
- New rancher signups per week (self / community / cold)
- Rancher onboarding completion rate (form → live)
- Buyer conversion rate (signup → match → close)
- Avg time-to-match (signup → intro fired)
- Avg time-to-close (intro fired → Closed Won)
- Repeat purchase rate (Closed Won → second order)

### Revenue
- GMV (total $ flowing through marketplace per month)
- Net commission revenue
- Founders Herd MRR
- Marketing services MRR
- Marketing services LTV per rancher

### Ops
- Rancher capacity utilization (active refs / max refs)
- Email bounce rate
- Telegram alert response time (Ben → tap)
- Cron health (errors per cron per day)
- Stuck-buyer count (READY without active referral)

### Network
- Total verified ranchers
- States covered
- Founders Wall count (Founding 100 + Title Founder)
- Public map page views per week

---

## Operating Cadence

### Daily
- 8am: `/morning` Telegram digest
- React to all firstweek-approval / close-detector / self-submit cards within 2h
- Reply personally to all Title Founder emails same-day

### Weekly
- Monday: stalled-rancher follow-up cron + manual touch on stuck deals
- Wednesday: rancher onboarding call block (Calendly slots)
- Friday: founder cohort batch — first dibs emails to Outlaw+

### Monthly
- 1st: commission invoice cron fires (until Phase 1)
- 1st: monthly founder letter to all backers
- 1st: stuck-buyer recovery review
- Mid-month: Steward quarterly office-hours call (rotates)

### Quarterly
- Office-hours call for Stewards
- Quarterly drop email for Outlaws+
- Public expense ledger published
- Title Founder co-build email loop

### Annually
- Audit of give-back commitments compliance
- Vision doc revision (this file)
- Operating agreement review

---

## Capital Plan

### Pre-launch (now)
- $250k ceiling from Founding Herd
- $0 from VC

### Phase 1 (60 days)
- $15k engineering from Founding Herd capital
- Revenue ramps: marketplace commissions begin compounding

### Phase 2-3 (6-12 months)
- $80k engineering from operating cash flow + remaining Founding Herd
- Possibly $250k-$500k from a values-aligned strategic angel (Polyface,
  Joel Salatin's network, Allen Savory institute, Niman Ranch ecosystem)

### Phase 4-5 (12-24 months)
- $500k-$1M financing partnership (Pipe.com or similar) — non-dilutive,
  revenue-share or receivables-backed
- NO traditional Series A unless terms allow give-back commitments

---

## Competitor Landscape

### Direct competitors (D2C beef marketplaces)
- **Crowd Cow** — VC-backed, marketplace + DTC brand. Larger. Doesn't
  publish give-back. Mostly aggregator buying from ranchers wholesale,
  not connecting buyers to ranchers directly. Margin compression.
- **ButcherBox** — subscription monthly box. Not direct rancher
  connection. Sourcing aggregated. Different model.
- **GrassRoots Coop** — values-aligned, ranchers' co-op selling
  collectively. Smaller scale. Different governance (not platform).

### Adjacent
- **Local Harvest, Eat Wild** — directories. No matching, no commerce,
  no platform. Static lists.
- **Farmers market apps** — local in scope, no ranching focus.

### Indirect
- **Walmart, Costco, Whole Foods grass-fed sections** — commodity beef
  with grass-fed labels. Not ranchers. Not direct.

### BHC Differentiation
1. **Private + approval-only** (vs Crowd Cow's open marketplace)
2. **State-local matching** (vs aggregator wholesale)
3. **Founders Wall + give-back commitments** (vs no public covenant)
4. **Movement framing** (food revolution + map + community submission)
5. **Platform ambition** (Phase 1+ — vs lead-gen-only competitors)

---

## Exit Considerations

Per Vision doc — sale or IPO requires the buyer to honor give-back
commitments for minimum 10 years post-acquisition. Founder veto written
into operating agreement.

Realistic exits:
- Strategic to USDA-aligned cooperative (e.g., Cooperative Development
  Foundation) — preserves rancher equity
- Acquisition by aligned VC with clean give-back maintenance covenant
  (rare but possible)
- Founder buyback / employee ownership transition (preferred)

NOT considering:
- Big tech acquisition
- Private equity rollup
- Any buyer unwilling to write the rancher dividend pool into purchase
  agreement

---

## What This Document Is

The reference. Update as plans evolve. Source of truth for:
- Investor briefings (send the relevant sections)
- Backer transparency (full ledger + this doc, public)
- Onboarding new ops hires (read this first)
- Strategic decision-making ("does this fit the model?")

If a decision contradicts this doc, the decision needs justification or
the doc needs updating. No silent drift.

— Ben
