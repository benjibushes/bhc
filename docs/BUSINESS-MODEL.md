# BuyHalfCow — Business Model

**Status:** v1, post-launch ready
**Last revised:** 2026-05-02
**Audience:** founder reference / backer transparency / investor briefing

---

## TL;DR

BuyHalfCow is the private network connecting American families to verified
direct-to-consumer ranchers, becoming the underlying platform every D2C
beef operation runs on (payments, marketing, logistics, financing). Three
revenue engines today, fourth and fifth coming as platform layer ships.

**Today:** marketplace + Founding Herd + marketing services
**12 months out:** + payments platform + inventory mgmt
**24 months out:** + logistics + POS + financing
**36 months out:** + ranching cooperative

**Defensibility:** the rancher relationships + the Founders Wall (publicly
committed backers) + the integrated payments+logistics stack. Each rancher
who joins makes the network more useful for the next one.

---

## Three Revenue Engines (today)

### Engine 1 — Marketplace Commission
- **What:** match buyer to verified rancher, take 10% of closed deal
- **Who pays:** rancher (deducted from sale price post-close)
- **Volume:** ramps with rancher count + marketing spend
- **Margin:** ~95% gross (Stripe fees ~2.9% on commission charge)
- **Unit economics:** ~$1,200 avg order × 10% = $120 commission per close
- **CAC:** ~$15-25 per qualified buyer signup (Meta + organic)
- **LTV:** repeat-purchase rate ~30% over 12 months → ~$280 per buyer

### Engine 2 — Founding Herd (capital + community)
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

### Engine 3 — Marketing Services (the close)
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

### Engine 4 — Payments Platform (Stripe Connect)
- **What:** every D2C beef purchase routes through BHC's Stripe → auto-split → rancher gets 90%, BHC keeps 10%
- **Replaces:** Engine 1 monthly invoice cycle. Same 10% rate, automated.
- **Plus:** Stripe interchange revenue share on processing fees (~0.5% additional)
- **Plus:** payout speed monetization — rancher can pay $X for instant payout vs 2-day standard
- **Margin:** ~90% net on platform fee, ~95% on payout-acceleration tips
- **Locks in:** every rancher who connects Stripe is now operationally
  dependent on BHC. Stickiness goes from "marketing channel" to "treasury."

---

## Phase 2-5 Engines (6-36 months)

### Engine 5 — Inventory + Processing SaaS ($25-$100/mo per rancher)
Rancher subscription for inventory engine, cut-sheet builder, processor coordination tools.

### Engine 6 — Logistics Markup
Cold-chain shipping at cost +15-20% margin. Stripe Terminal hardware sold at retail with monthly POS subscription.

### Engine 7 — Financing Origination Fee
Receivables advances + working capital loans, BHC takes 1-3% origination fee + spread on partner-funded credit.

### Engine 8 — Buying Cooperative
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
