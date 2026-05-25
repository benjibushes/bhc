# Revenue Function Audit — 2026-05-25

Every code path that touches revenue + how it's performing + the next lever.

## Baseline (live as of 2026-05-25)

| Metric | Value |
|---|---|
| Lifetime GMV | **$20,165** across 11 Closed Won |
| BHC commission earned | **$1,916.50** (avg ~10%) |
| Average sale | $1,833 |
| Pipeline buyers | 1,477 |
| Conversion (signup → close) | **0.74%** |
| Active ranchers | 15 (13 states) |
| Contributing ranchers | 5 of 15 (10 dormant) |
| Founders backed | 0 of 100 |
| Brand partners | 0 of unlimited |
| Wholesale signups | 0 (just launched) |
| Affiliate-attributed closes | 0 lifetime |

---

## REVENUE PATH 1: Buyer → Closed Won → 10% commission

**Status:** 🟢 OPERATIONAL · primary driver of all current revenue

**Flow (verified):**
```
/access POST → /api/consumers
  → Consumer row created (Buyer Stage=NEW now stamped, post-fix 6258f85)
  → sendWelcomeAndReadyToBuy (welcome + YES button)
  → if qualified: matching/suggest fires → intro emails → MATCHED
  → if not: WAITING/READY → email-sequences cron nurtures → eventual YES click
  → rancher contacts buyer direct
  → rancher dashboard /rancher PATCH Status=Closed Won + Sale Amount
  → atomic capacity DECR + Stripe commission invoice fires
  → Telegram /morning + daily-digest celebrates
```

**Volume processed:**
- 1,477 signups → 11 closes lifetime
- 16 emails sent today

**Top performers driving the 11:**
- Ashcraft Beef (TX): 4 closes, $6,640 GMV
- Hewitson (CO/UT): 4 closes, $5,700 GMV
- Russell Gift: $6,800 single Half (biggest ticket)

**Top bottleneck:**
- 0.74% conversion rate. Industry baseline for beef-direct = 2-5%. We're at 1/4 the typical floor.
- Auto-route gate at `/api/consumers:318` requires `Beef Buyer` segment, which requires Order Type + Budget — but /access form only requires email + state + timing. Result: most signups stuck in Community segment → never auto-routed.

**Single biggest lever:**
- **Default Order Type='Half' + Budget='$1500-$2500' when not collected** — would make every signup eligible for auto-route, lift segment classification from Community → Beef Buyer, and 3-5x conversion.
- Alternative: add Order Type back to /access form (more friction, lower top-of-funnel volume but higher qualified rate).

**Ship time:** 30 min code change.

---

## REVENUE PATH 2: Founders Herd backers (cash injection)

**Status:** 🔴 DEAD · 0 of 100 spots claimed lifetime

**Flow (verified working code):**
```
/founders → click tier → Stripe Payment Link → checkout
  → Stripe webhook /api/webhooks/stripe → idempotent (Stripe Session ID)
  → assignFounderNumber (Redis INCR atomic — round 3 fix)
  → Consumer.Founder Tier + Founder Number + Tier Amount Paid set
  → sendFoundingHerdWelcome
  → Telegram celebration
```

**Volume processed:** 0 lifetime · 0 today

**Bottleneck:**
- Zero traffic. Page works perfectly — no one's been pushed to it.
- All 8 Stripe Payment Links live in env. Webhook + idempotency + atomic counter all verified.

**Single biggest lever:**
- **Send the founder-list email blast** (`marketing/drafts-2026-05-24/founder-list-email-blast.md`). Has a CTA to /founders. Even 5% conversion on a 500-person warm list = 25 backers × avg $300 = **$7,500 in 24 hours**.

**Ship time:** 0 code · operator copy-paste from draft, send via Resend dashboard.

---

## REVENUE PATH 3: Brand partners (recurring MRR)

**Status:** 🟢 LIVE BUT UNTAPPED · 0 partners, infrastructure shipped today (round 7)

**Flow (verified):**
```
/brand-partners → click tier → /api/checkout/brand?tier=spotlight|featured|founding
  → 302 to real Stripe Payment Link (verified live, all 3 tiers)
  → buyer pays $99/$499/$1500 (monthly recurring or one-time founding)
  → Stripe webhook fires → Consumer row + Brand Tier + Subscription
```

**Volume processed:** 0 lifetime · 0 today

**Bottleneck:**
- No outbound to brands. Marketing draft exists (`marketing/drafts-2026-05-24/partner-dm-templates.md` template (c)) but unsent.

**Single biggest lever:**
- **Send 3 cold emails per week to D2C-aligned brands**: Yeti, Stadri (patches), Stonewall Kitchen, Maker's Mark, Vermont Country Store. $99-$1500/mo MRR each. Recurring revenue compounds.

**Ship time:** 0 code · operator outreach.

---

## REVENUE PATH 4: Affiliate-driven referrals (compounding signups)

**Status:** 🟡 INFRASTRUCTURE READY, ATTRIBUTION ZERO · 0 lifetime affiliate closes

**Flow (verified after R2 case-mismatch fix):**
```
/access?ref=CODE → /api/affiliates/track-click → Click Count ++
  → Consumer signup → validateAffiliateRefForSignup → Consumer.Referred By stamped
  → buyer closes → commission split (5% affiliate / 5% BHC)
  → sendAffiliateCommissionInvoice (monthly)
```

**Volume processed:** Click counts exist but 0 closes attributed yet

**Bottleneck:**
- Share-and-earn CTA on /access thank-you was just added (round 7 — commit 63b8317). Real visitors haven't fully cycled through yet.
- No affiliate dashboard polish — affiliates can't see their earnings live.

**Single biggest lever:**
- **Activate first 5 affiliates manually** — pick warm friends with audiences, give them a code, push them to share. Even 5 affiliates × 3 referred closes each = 15 closes × $200 commission share = **$3,000/quarter passive**.

**Ship time:** 0 code · operator picks 5, drops manual codes in Affiliates table.

---

## REVENUE PATH 5: Wholesale (restaurants/butchers — $5-15k tickets)

**Status:** 🟢 JUST SHIPPED (commit 353218e today) · 0 signups yet

**Flow:**
```
/wholesale → form (10 fields) → /api/wholesale/signup
  → Inquiry row (Interest Type='Wholesale')
  → sendAdminAlert + Telegram → operator personally contacts within 24-48h
  → routes to verified ranchers w/ wholesale capacity
```

**Volume processed:** 0 yet (live <1 day)

**Bottleneck:**
- Page exists. NO TRAFFIC.
- No restaurants/butchers know /wholesale exists.

**Single biggest lever:**
- **Cold-outreach 25 high-end restaurants** within 50mi of every active rancher. Even 2 wholesale closes × $10k each = $20k GMV / $2k commission. ~equal to 11 retail closes lifetime.

**Ship time:** 0 code · operator outreach.

---

## REVENUE PATH 6: Repeat buyers (90-day reactivation)

**Status:** 🟡 CRON LIVE, RUNNING DRY · 0 buyers in 90-day window yet

**Flow (verified):**
```
Closed Won + 90 days → close-detector cron picks up → sendRepeatPurchaseAsk
  → buyer responds → matching/suggest fires NEW referral → repeat close
```

**Volume processed:**
- Earliest close = Benjamin Kish (OR) 2026-04-27 (~28 days ago)
- 90-day eligibility hits 2026-07-26 — first repeat ask 60 days out

**Bottleneck:**
- Cohort too young yet.

**Single biggest lever:**
- **Wait** — natural compounding. Each Closed Won grows the 90-day eligible pool.
- Tier 2: shorten interval to 60 days (some buyers eat a Quarter in 6 weeks, not 12).

**Ship time:** 0 now · revisit late July.

---

## REVENUE PATH 7: Rancher onboarding (supply growth = $ enabler)

**Status:** 🟡 OPERATIONAL · 15 active / 5 productive

**Flow (verified):**
```
/map/add-a-rancher → wizard → setup → agreement signature → go-live → first lead
  → matching/suggest routes buyers to new rancher
  → first close → commission flows
```

**Volume processed:**
- 17 ranchers in Airtable, 15 verified active
- Only 5 have produced revenue. 10 dormant.

**Bottleneck:**
- **10 active ranchers w/ $0 GMV.** Either no buyers in their state OR they're not actively responding to intros.
- Need to know WHY each non-producing rancher is dormant.

**Single biggest lever:**
- **Call the 10 dormant ranchers personally this week.** "Did you receive intros? Are buyers contacting you? What's blocking your first close?" If product issue → fix. If buyer-side issue → push more in that state. Each dormant rancher unlocked = potential 2-5 closes × $1,800 avg = **$3,600-9,000 per converted rancher**.

**Ship time:** 0 code · 30 min/rancher call.

---

## REVENUE PATH 8: Stripe Connect Phase 1 (UNLOCKS Shopify-for-beef pitch)

**Status:** 🔴 BLOCKED on operator (Stripe Connect platform application)

**Why this matters:**
- Current: manual Stripe Payment Links per rancher. Each onboarding takes 20 min of operator time. Commission invoiced separately, 30-day cycle, manual chase.
- Post-Connect: rancher connects bank in 90 seconds. Buyer pays through BHC. Auto-split 90% rancher / 10% BHC. Rancher gets money in 48h. Zero operator hours per close.
- Sales pitch becomes: *"Sign up. Connect your bank. Buyers pay through us. We deposit in 48h. We handle taxes, returns, shipping. You raise cattle."*

**Bottleneck:**
- **Operator needs to apply at stripe.com/connect** (10 min) → 24-48h Stripe review → I dispatch subagents to build T1-T8 (1-2 weeks Claude time).
- Scope doc shipped (`docs/PHASE-1-STRIPE-CONNECT-SCOPE.md`).

**Single biggest lever:** **Submit the application today.**

**Expected impact:**
- 3-5× rancher acquisition rate (because onboarding goes from 20 min to 5 min)
- 50% reduction in operator commission-chase hours
- Foundation for Phase 2 (inventory/cut-sheets) + Phase 3 (POS/shipping)

---

## SUPPORTING INFRA (rev-enabling — no direct $ but gates above)

### 8.1 Email pipeline
**Status:** 🟢 16 sends today, all logged in Email Sends table, no XSS, freq-capped 10/7d.
**Lever:** Tighten freq cap to 3/7d after 24h spam-audit data (Telegram `/freqcap`).

### 8.2 Cron engine
**Status:** 🟢 25/25 recent runs success.
**Lever:** Already running optimally.

### 8.3 Webhooks (Stripe + Resend Inbound + Telegram)
**Status:** 🟢 All signature-verified, idempotent.
**Lever:** Add svix-id dedup on Resend Inbound (Tier 2 hardening).

### 8.4 Telegram cockpit
**Status:** 🟢 13 commands (/morning, /forcematch, /bulkfire, /match, /casestudy, etc.)
**Lever:** Build a `/revenue` command that shows today's commission earnings.

### 8.5 Atomic counters (Founder #N, Rancher capacity)
**Status:** 🟢 Both shipped (rounds 3 + 7), Redis INCR-backed.
**Lever:** None — race-safe under burst.

### 8.6 Public stats endpoint
**Status:** 🟢 Fixed today — pipeline depth + activity counter + homepage aliases.
**Lever:** Add foundersBacked + brandPartners counts (currently always 0 because table-based not subscription-based).

---

## SCORECARD — what's working vs what's not

| Path | Status | Bottleneck | Lever | ETA |
|---|---|---|---|---|
| 1. Buyer commission | 🟢 | 0.74% conversion | Default Order Type + Budget on signup | 30 min |
| 2. Founders Herd | 🔴 | 0 traffic | Send founder list email blast | 0 code |
| 3. Brand partners | 🟢 | 0 outbound | 3 cold emails/week | 0 code |
| 4. Affiliates | 🟡 | 0 active | Manually onboard 5 friends | 0 code |
| 5. Wholesale | 🟢 | 0 traffic | 25 restaurant cold emails | 0 code |
| 6. Repeat | 🟡 | Cohort too young | Wait until July | n/a |
| 7. Rancher onboard | 🟡 | 10 dormant | Call all 10 this week | 30 min/each |
| 8. Stripe Connect | 🔴 | Operator hasn't applied | Apply today | 10 min |

---

## TOP 5 REV-PUSH ACTIONS — sequenced by ROI

1. **Default Order Type/Budget on /access signups** (30 min, my code) → 3-5× conversion lift → unlocks ALL downstream flows
2. **Send founder list email blast** (15 min, operator copy-paste) → $5-15k Founding Herd capital within 24h
3. **Apply Stripe Connect platform** (10 min, operator) → 48h Stripe review → 1-2 week build → 3-5× rancher acquisition rate
4. **Call 10 dormant ranchers this week** (5 hours, operator) → unlock $3-9k per converted rancher
5. **Cold-outreach 25 restaurants for wholesale** (3 hours, operator) → 2 wholesale closes × $10k = $20k GMV / $2k commission

If user does items 2-5 (no code) + I ship item 1 (code) → 60-day target ≥ $30k GMV / $3k commission. 3× current.

---

## NEXT-AUDIT TRIGGER

Run this audit again when:
- 50+ closes total
- 5+ founders backed
- 1+ brand partner live
- 1+ wholesale close
- Stripe Connect Phase 1 shipped

Save next audit as `docs/REVENUE-AUDIT-YYYY-MM-DD.md` — same structure.
