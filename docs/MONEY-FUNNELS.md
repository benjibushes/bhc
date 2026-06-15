# 💰 BHC Money Funnels — the complete map

_Last updated: 2026-06-15. Canonical, version-controlled reference for: every marketing funnel (how a stranger becomes a paying relationship) and every path to money (how BHC actually collects). Current as of the 2026-06-15 tier_v2 launch + product-hardening pass. Pairs with [`docs/BHC-PLATFORM-MAP.md`](BHC-PLATFORM-MAP.md) (code-level source of truth) and [`docs/COMMISSION-FLOW.md`](COMMISSION-FLOW.md) (commission state machine)._

## The machine in one line
Route qualified, in-state **buyers** to verified **ranchers**; BHC takes a **commission collected upfront on the buyer's deposit** (tier_v2) or post-close (legacy). Ranchers also pay **monthly subscriptions** for lower commission + marketing. Two side engines: **Founders** (capital/community) + **Brand partners** (sponsorship).

**The core insight:** legacy closes put **$0 upfront** in BHC's pocket (the rancher runs their own sale, invoiced later). **tier_v2 is the only model that collects at the moment of sale.** The whole migration push exists to move every rancher onto it. Ads only pay off once the rancher receiving the buyer is **deposit-ready** (Stripe Connect `active`).

---

## PART 1 — EVERY PATH TO MONEY (revenue mechanics)

Ranked by leverage for the ad-scale phase.

### 1. tier_v2 deposit commission — THE ENGINE 🟢
- **What:** buyer reserves a share with a **deposit** → Stripe **direct charge on the rancher's connected account** → `application_fee_amount` = BHC commission, taken **at that moment**.
- **Rate (per rancher tier, `lib/tiers.ts`):** Legacy Connect **10%** · Pasture **7%** · Ranch **3%** · Operator **0%**. Commission = `round(fullSaleCents × tier.commissionRate)`.
- **Flow:** deposit paid (`/api/checkout/deposit` → Stripe → webhook `Awaiting Payment` + Deposit Paid At) → rancher **Accept Slot** (`Slot Locked`) → **final balance invoice** (fee-free, `application_fee=0`) → `Closed Won` → payout to rancher.
- **Taken exactly once** (verified): every legacy post-close invoice path is `tier_v2 → skip`. No double-charge.
- **Money math example (Half @ $2,900, Ranch tier 3%):** buyer pays a deposit + processing; BHC nets `$2,900 × 3% = $87` upfront; rancher nets the rest same-day; balance invoiced fee-free later.
- **Gate:** rancher must be Connect `active` (the routing gate now enforces this so buyers aren't sent to a 409).

### 2. Subscription MRR (rancher tiers) 🟢
- **What:** recurring monthly Stripe subscription. Pasture **$150/mo** · Ranch **$350/mo** · Operator **$500/mo**. Legacy Connect = **$0/mo**.
- **The trade:** higher monthly fee → lower commission (Operator = 0% commission, pure $500/mo). The more a rancher sells, the more a paid tier beats the 10% Legacy Connect.
- **Stripe price IDs (LIVE):** Pasture `price_1Tb3IW…`, Ranch `price_1Tb3Iy…`, Operator `price_1Tb3JL…`.
- **Collected:** at tier select in the wizard (Stripe Checkout subscription) or via the upgrade invite.

### 3. Legacy 10% commission (sunsetting) 🟡
- **What:** the old model — rancher runs their own sale, BHC invoices 10% post-close (`createCommissionInvoice`, 30-day terms, Stripe invoice).
- **Why it's being retired:** $0 upfront, depends on the rancher self-reporting + paying an invoice. The migration moves these to tier_v2.
- **Still live for:** legacy ranchers not yet migrated. `commission-invoices` cron bills monthly; skips tier_v2.

### 4. Founders / Founding Herd (capital + community) 🔵
- **What:** no-equity backing. Herd **$9/mo** → Outlaw/Steward tiers → Founding 100 ($1,000) → Title Founder (up to $15k). Perks + name on the wall, not securities.
- **Flow:** `/founders` → Stripe Checkout/Payment Link → webhook → `sendFoundingHerdWelcome` + Wall placement.
- **Caps:** Founding 100 = 100 spots (honest scarcity).

### 5. Brand partners (sponsorship) 🔵
- **What:** D2C-aligned brands pay for distribution to the rancher network + buyer list. **$99/mo Spotlight · $499/mo Featured · $2,500/quarter Co-marketed.**
- **Flow:** `/brand-partners` → Stripe Payment Link → manual fulfillment (logo, posts, drops). Gated for fit.

### 6. Add-ons (à la carte, any tier) ⚪
From `lib/tiers.ts` ADD_ONS: **Video shoot $2,500** (+travel) · **Photo refresh $1,500** · **Founder-letter campaign $750** · **Brand-partner intro 15% of deal** · **PPC management 15% of spend ($500/mo min)**.

---

## PART 2 — EVERY MARKETING FUNNEL (stranger → money)

### A. BUYER FUNNEL (the ad target)
**Goal:** family books a quarter/half/whole → deposit → BHC commission.

```
TOFU  IG/TikTok/Twitter content, /wins proof wall, state SEO pages /access/[state]
  ↓   "Get access" / "Find a rancher near you"
MOFU  /map discover · /ranchers/[slug] landing pages · "why direct beef" email
  ↓
BOFU  /access quiz (90 sec) → POST /api/consumers (intent score, Consumer row)
  ↓   score ≥75 + qualified → auto-route; else Ready-to-Buy email → YES button
  ↓
MATCH /api/matching/suggest → in-state, deposit-ready rancher → intro emails (buyer + rancher)
  ↓
CLOSE  ├─ tier_v2 rancher → buyer books Ben (Sales Calls Cal) OR pays deposit inline → COMMISSION
       └─ legacy rancher → buyer books the rancher's own Cal / rancher reaches out → rancher closes → 10% invoice
```
- **Conversion events:** quiz submit → match → deposit paid → Closed Won.
- **Ad entry:** `/access` (+ `/access/[state]` SEO landers). Primary CTA "Take the 90-second quiz."
- **Money lands at:** deposit (tier_v2, upfront) or post-close invoice (legacy).
- **Hardened 2026-06-15:** routing now requires the rancher be Connect-`active` (no 409 dead-ends); hot-path buyers get a session so the deposit button works; quiz resend-link carries a token; Cal links resolve live (no dead slugs).

### B. RANCHER FUNNEL (supply — enables all buyer money)
**Goal:** rancher → tier_v2 + Connect active → can take deposits → BHC earns on every buyer.

```
TOFU  cold scrape → yellow pin on /map · community "fan flagged you" · "what is BHC" content
  ↓   "Add me to the map"
MOFU  /map/add-a-rancher (self-submit) · /apply · /partner → rancher row (dup-guarded)
  ↓   welcome email + magic link
BOFU  /rancher/setup WIZARD (self-serve, ~5 min):
      tier pick (Legacy Connect / Pasture / Ranch / Operator) → Stripe Connect (bank) →
      products + per-cut Price/Deposit/Fee → landing page → sign → GO LIVE
  ↓   (or "Book a call" → Ben runs the Rancher Onboarding call, 45 min)
LIVE  /ranchers/[slug] public page · /rancher dashboard (Accept Slot, Final Invoice, Close Won)
  ↓
MONEY  every in-state buyer routed to them → deposit → commission + their monthly MRR
```
- **Conversion events:** signup → wizard complete → Connect active → first deposit.
- **Two doors (current migration):** self-serve the wizard, OR book the onboarding call. Both end at Connect-active + deposit-ready.
- **Hardened 2026-06-15:** deposit input added (deposit model actually works), in-wizard checkout, go-live without legacy Payment Link, Step 4 no longer a dead-end, booking ties back so no re-nudge.

### C. FOUNDER FUNNEL
```
Follower (IG/Twitter/founder letters) → /founders → tier card → Stripe → welcome + Wall → Ben personal follow-up
```
Money: one-time ($1k–$15k) or $9/mo Herd MRR.

### D. BRAND PARTNER FUNNEL
```
Founder DM / cold outreach → 20-min call → /brand-partners → Stripe Payment Link → manual fulfillment
```
Money: $99/$499/mo or $2,500/quarter.

---

## PART 3 — THE TWO OPERATING FUNNELS (how a matched buyer closes)
1. **Legacy routing** — buyer matched to a rancher who runs their own sale; BHC invoices 10% after close. Passive for Ben.
2. **tier_v2 operator-led** — the moment a rancher is tier_v2, **Ben runs the sales call → deposit → upfront commission**. This is the funnel ads should feed.

---

## PART 4 — LEVERAGE MAP (where to push for $)
1. **Get ranchers Connect-active** (tier_v2). Every active rancher unlocks buyer commission in their state. The legacy→tier_v2 migration launched 2026-06-15 (14 active legacy ranchers invited via Bulk Invite, 41 dormant reactivated) — getting those ranchers Connect-active is the immediate lever.
2. **Feed in-state buyers** to those active ranchers (ads → /access). Buyers only convert to $ where a deposit-ready rancher exists.
3. **Upsell tiers** — push high-volume ranchers from Legacy Connect (10%) to a paid tier (MRR + lower commission = better for both).
4. **Side engines** (founders, brand partners) — capital + offset, not the core loop.

**Bottleneck today:** supply (deposit-ready ranchers) gates buyer-ad ROI. Route buyers only where a rancher is `active`; otherwise the ad click hits a wall. The whole 2026-06-15 hardening pass existed to make both sides of this loop flawless before ad spend.
