# Marketing Delivery Game Plan — Stage-3 Onboarding
**Saved:** 2026-05-25 · For execution on or after Tier subscription launch

---

## The problem

Tiered pricing only works if marketing actually fires. Promise vs delivery gap = churn + brand damage = competitor advantage.

3 tiers × per-rancher recurring deliverables = real operational load. This doc locks the trigger systems, queue mechanics, capacity math, and automation candidates so every dollar a rancher pays maps to a verifiable deliverable.

---

## Deliverables matrix (verbatim from /partner perks)

### Pasture · $150/mo + 7% — "We send you buyers"

| Deliverable | Cadence | Auto/Manual | Trigger |
|-------------|---------|-------------|---------|
| Verified green-pin listing on /map | One-time | Auto | Connect activate webhook → Active Status=Active |
| Custom landing page at /ranchers/[slug] | One-time | Auto | Existing setup wizard generates |
| Auto buyer matching | Ongoing | Auto | matching/suggest cron |
| Intro emails to buyer with rancher profile | Per match | Auto | matching/suggest sends |
| Reply tracking in dashboard | Ongoing | Auto | Threads + inbound webhook |
| Capacity controls | Ongoing | Auto | rancherCapacity lib |
| Newsletter mention on close | Per close | Manual | Operator copies blurb from sale celebration into monthly newsletter draft |
| Self-serve onboarding wizard | One-time | Auto | Existing /rancher/setup |

**Pasture rancher's monthly Ben-time:** ~30 min/mo (newsletter mentions). 100% of Pasture deliverables are automated except 1.

### Ranch · $350/mo + 3% — "+ make sure they see you first"

| Deliverable | Cadence | Auto/Manual | Trigger |
|-------------|---------|-------------|---------|
| Everything in Pasture | — | — | — |
| Priority routing in state | Ongoing | Auto | matching/suggest weights tier=Ranch above Pasture |
| Listing optimization | Quarterly | Manual | Ben rewrites landing-page copy quarter 1 of each Q |
| Social case study post | Per close | Manual | Ben drafts IG + Twitter on each Closed Won, posts within 48h |
| Featured in 1 founder letter | Quarterly | Manual | Ben rotates 1 Ranch tier rancher per quarterly founder letter |
| Inclusion on /wins page | One-time + per close | Auto | Closed Won + Wall Opt-In auto-renders |
| Monthly performance review | Monthly | Manual | Ben sends written breakdown OR books 30-min call |
| Brand partner first-dibs | Per opportunity | Manual | Ben routes inbound brand inquiries to Ranch tier first |

**Ranch rancher's monthly Ben-time:** ~4 hr/mo (assume 1 close/mo + monthly review).

### Operator · $500/mo + 0% — "+ we run your marketing"

| Deliverable | Cadence | Auto/Manual | Trigger |
|-------------|---------|-------------|---------|
| Everything in Ranch | — | — | — |
| 2 custom reels per month | Monthly | Manual (Ben + edit team) | Ben directs, rancher team shoots on phone, edit team posts |
| 1 founder-voice email per month | Monthly | Manual | Ben writes, sends to rancher's direct customer list |
| Listing fully managed | Ongoing | Manual | Ben updates pricing/photos/copy as needed |
| Quarterly YouTube long-form feature | Quarterly | Manual | Ben + crew produces; 1 Operator per quarter rotates |
| Brand partner warm-handoff | Per opportunity | Manual | Ben emails introductions when brand partners request rancher leads |
| Quarterly 1:1 with Ben | Quarterly | Manual | 30-60 min call, written summary |
| 0% commission on deals | Ongoing | Auto | application_fee_amount = 0 |
| First call on podcast/media | Per opportunity | Manual | Ben surfaces opportunities |

**Operator rancher's monthly Ben-time:** ~15 hr/mo.

---

## Capacity math (locked)

Ben's effective marketing time = ~60 hr/mo (assuming 40% of 40 hr/week, rest goes to ops/coding/admin).

| Tier | Hours/rancher/mo | Max ranchers/tier alone |
|------|------------------|-------------------------|
| Pasture | 0.5 | 120 |
| Ranch | 4 | 15 |
| Operator | 15 | 4 |

**Realistic mixed-load:**
- 4 Operators (60h) → 0 other tiers possible
- 3 Operators (45h) + 4 Ranches (16h) = 61h
- 2 Operators (30h) + 7 Ranches (28h) = 58h
- 1 Operator (15h) + 10 Ranches (40h) = 55h
- 0 Operators + 15 Ranches (60h) = 60h

**Without Operator tier:**
- 15 Ranches max OR 120 Pastures max OR mix

**Scaling triggers (when to hire):**
- **At 3 Operators or 12 Ranches:** Hire part-time video editor ($1,500/mo) → cuts Operator load by 5h each = double Operator capacity
- **At 5 Operators or 20 Ranches:** Hire VA for newsletter + social drafts ($500/mo) → cuts all-tier load by 30%
- **At 30+ Ranches:** Hire writer for listing rewrites + founder letters ($2k/mo)

---

## Trigger architecture (what actually fires the work)

Marketing deliverables need to surface in Ben's Telegram cockpit OR Airtable queue. Without surfacing, nothing fires.

### Auto-generated Telegram digests (built on funnel + close events)

**On every Closed Won (existing close-handler extends):**

Pasture rancher:
```
💰 Closed Won · [Rancher] · $[Amount]
✨ Newsletter mention queued: [link to draft]
```

Ranch rancher:
```
💰 Closed Won · [Rancher] · $[Amount]
🎬 Social case study DUE within 48h: [draft button]
📰 Add to newsletter queue: [confirm button]
```

Operator rancher:
```
💰 Closed Won · [Rancher] · $[Amount]
🎬 Reel #1 idea queued: [draft button]
📰 Newsletter mention queued
💌 Add to monthly founder-voice email line-up
```

### Weekly Monday 9 UTC Telegram digest (NEW cron `marketing-deliverables-digest`)

```
📋 MARKETING THIS WEEK

OPERATOR (X ranchers):
- [Ashcraft] · 1 reel due May 28 · founder email due May 30 · listing OK
- [High Lonesome] · 2 reels due · YouTube feature THIS Q · 1:1 booked May 27

RANCH (X ranchers):
- [Sackett] · monthly review due May 26 · listing rewrite due Q3
- [Ranch B] · 1 social case study overdue (from May 19 close)

PASTURE (X ranchers):
- 3 newsletter mentions queued for June 1 newsletter

OVERDUE: 1 social case study (Ranch B) → write today
```

### New Airtable table: `Marketing Deliverables`

Schema (operator creates via MCP when implementing):
- Id (auto)
- Rancher (link → Ranchers)
- Type (singleSelect: Newsletter Mention / Listing Rewrite / Case Study Social / Founder Letter Feature / Monthly Review / Reel / Founder-Voice Email / YouTube Feature / Brand Partner Intro / Quarterly Call / Podcast Pitch)
- Tier (snapshot of rancher's tier at time of obligation)
- Due Date
- Status (singleSelect: pending / drafted / scheduled / shipped / skipped)
- Linked Referral (optional link)
- Drafted At / Shipped At
- Notes
- Drafted By (Ben / VA / editor)

This is the QUEUE that drives the digest. Every Closed Won + tier subscription + quarterly tick auto-inserts rows.

---

## Per-tier ritual locked

### Pasture — autopilot + 1 manual touch per close

**On Closed Won:**
1. Auto-celebrate email + Telegram (existing)
2. Auto-insert Marketing Deliverable row: type=Newsletter Mention, due = next 1st of month
3. On 25th of each month: digest reminds Ben to compile newsletter w/ all queued mentions

**Monthly newsletter cadence (existing):**
- 1st of month: send newsletter with all queued Pasture mentions

### Ranch — active engagement, social-first

**On Closed Won:**
1. Auto-insert: Case Study Social (due 48h) + Newsletter Mention (due next 1st)
2. Telegram fires "social case study DUE within 48h" with [draft] button
3. [draft] button uses `bhc-marketing` skill to generate IG + Twitter post → Ben edits → schedules

**On 1st of every quarter (Jan/Apr/Jul/Oct):**
1. Auto-insert: Listing Rewrite (due within 30d), Monthly Performance Review (first one)
2. Auto-insert: Founder Letter Feature for 1 Ranch rancher (rotate, oldest-unfeatured first)

**Monthly (15th of month):**
- Performance Review reminder for every Ranch rancher
- Ben either writes summary OR books 30-min call
- Sends via email + logs in Marketing Deliverables row

**On brand partner inquiry:**
- Ben filters by Ranch tier first when routing
- Telegram alert when brand asks for partners → /admin filters Ranch tier candidates

### Operator — managed marketing partnership

**On Closed Won:**
- Auto-insert: Reel #1 Idea (next available slot), Founder-Voice Email (next available slot)

**Monthly cadence:**
- **1st of month:** Digest shows: "Operator [X] · 2 reels needed · 1 email needed"
- **5th:** Ben drafts reel concepts in Marketing Deliverables row
- **10th:** Rancher team shoots footage on phone (Ben sends shot list)
- **15th-25th:** Edit team turns around 2 reels per Operator
- **20th:** Founder-voice email draft → Ben reviews → sends to rancher's customer list
- **25th:** Reels scheduled to post

**Quarterly:**
- Pick 1 Operator for YouTube long-form (rotate)
- 1:1 call booked for each Operator (Calendly auto-book link in Marketing Deliverables row)

**Brand partner inquiries:**
- Operators get warm-handoff (Ben emails introduction with rancher's contact directly)
- Tracked in Add-On Purchases table → if deal closes via warm-handoff → Brand Intro 15% fee applies

---

## Marketing automation candidates (build later, defer)

These compound Ben's leverage but aren't required for Stage-3 ship:

1. **AI-drafted social case study from close data**
   - Trigger: Closed Won on Ranch+ rancher
   - Input: buyer name + cut type + sale amount + rancher quote (pulled from Threads)
   - Output: 2 IG captions + 1 Twitter thread draft
   - Tech: existing `bhc-marketing` skill + Claude API call

2. **Auto-listing-rewrite suggestions**
   - Trigger: 1st of quarter for each Ranch+ rancher
   - Input: existing landing-page copy + last 90d performance data + competitor listings
   - Output: 3 hook variants + 1 tightened About paragraph + 1 stronger CTA suggestion
   - Tech: Claude API + Tavily scrape (already wired in `/api/rancher/setup/auto-about`)

3. **Reel concept auto-generator from close stories**
   - Trigger: Operator Closed Won
   - Input: buyer's order details + rancher's location + close amount
   - Output: 2 reel concept briefs (hook, b-roll, voiceover)
   - Tech: Claude API

4. **Founder-voice email auto-draft**
   - Trigger: Monthly for Operator ranchers
   - Input: rancher's brand voice (from About page + past emails) + 30d performance data + current season
   - Output: 1 founder-voice email draft (subject + body)
   - Tech: Claude API w/ few-shot examples from existing BHC founder letters

5. **Performance review auto-draft for Ranch tier**
   - Trigger: 15th of each month
   - Input: last 30d Closed Won + Closed Lost + conversion rate + capacity utilization
   - Output: 1-page written breakdown w/ recommendations
   - Tech: Claude API + Airtable funnel queries

**Defer all 5 to a Stage-4 plan.** Stage-3 ships with manual deliverables tracked via the Marketing Deliverables Airtable table + Telegram digest. Automation when capacity demands it.

---

## Quality gates

Every shipped deliverable goes through Ben's review before going out:

| Deliverable | Quality gate |
|-------------|-------------|
| Social case study | Ben reviews draft + tweaks voice → schedules via Buffer/Later |
| Founder letter feature | Ben writes 1-paragraph feature + photo + sends in next monthly founder letter |
| Performance review | Ben writes summary email OR books call; never auto-send |
| Reel | Edit team delivers cut → Ben reviews → approves before posting |
| Founder-voice email for Operator | Ben writes/rewrites in rancher's voice; never AI-auto-send |
| YouTube feature | Full production cycle, Ben + crew, no shortcuts |
| Brand partner intro | Ben writes the connector email personally (high-touch) |

**Quality gate enforcement:** every Marketing Deliverables row requires `Drafted At` AND `Shipped At` stamps + reviewer initials (`Drafted By` field). Skipped deliverables get `skipped` status w/ Notes explaining why (rancher unresponsive, etc.).

---

## Onboarding-specific marketing motions

Beyond ongoing deliverables, NEW rancher onboarding triggers a one-time "welcome launch" sequence:

### Day 0 (Connect activate webhook fires)

- Telegram celebration to Ben: "🐂 NEW RANCHER LIVE · [name] · tier [X]"
- Email rancher: tier welcome + activation timeline (mockup emails/04)
- Launch warmup cron fires intro emails to waitlisted buyers in their state

### Day 1

- Ben sends personal welcome message via Threads (high-touch, builds relationship)
- Ben writes 1 tweet welcoming the new rancher (auto-tagged w/ their handle if provided)
- Pin rancher on the /map (existing)

### Day 3-7

- If still no buyer match: Ben manually reviews their listing, offers tweaks
- If first lead matched but rancher hasn't replied: Telegram nudge for Ben to call them

### Day 14

- If 0 closes yet: Ben writes a "welcome to the active list" social post (Ranch+ only) to drive buyer attention
- If 1+ closes: fire the First Payout Celebration email (Task 18) when payout lands

### Day 30

- First-month performance summary email (manual for Ranch+, automated copy for Pasture)
- For Operator: schedule the first quarterly 1:1 call

### Day 90 (quarter end)

- Listing rewrite for Ranch+ ranchers (if their close rate < state avg)
- Founder letter feature rotation
- YouTube feature rotation (1 Operator per quarter)

---

## Anti-patterns blocked

Things that kill marketing-as-service businesses, locked OUT of v1:

- ❌ Promising X reels/mo but delivering less → kill churn. Use Marketing Deliverables table to enforce.
- ❌ AI-generated content sent without human review → loses rancher voice. Quality gate forces human signature.
- ❌ Skipping months on Operator tier "because rancher was unresponsive" → still owe them the deliverable. If they're unresponsive, refund pro-rated + downgrade them.
- ❌ Over-promising in /partner copy that you can't sustain at scale → Operator SLA is explicit, anything extra is add-on quote.
- ❌ Pasture rancher expects Ranch-tier marketing → tier perks visible on `/rancher/billing` page so rancher always sees what they actually paid for.
- ❌ Hiring contractors before revenue justifies → trigger thresholds locked at 3 Operators / 12 Ranches before first hire.

---

## What this game plan UNLOCKS

Once Marketing Deliverables table + digest + per-tier rituals are in place, BHC graduates from "marketing experiment" to "platform with predictable deliverable economics."

This means:
- Rancher knows exactly what they get for their $X/mo
- Ben has a queue that surfaces work (no hunting in Airtable for what's due)
- Capacity math is real — can plan hiring against actual demand
- Quality gates prevent the "we promised but didn't ship" churn
- Add-on revenue (video shoots, brand intros) compounds without dilution to base tier perks
- Public proof wall on /wins becomes self-generating from Closed Won + Marketing Deliverables shipped

---

## Next session execution slot

**Task 17 (existing infra task) extends naturally to include this game plan.** When dispatching Task 17 subagent, include:

> Add a `Marketing Deliverables` table to Airtable schema (Task 1.5 backfill if not already done). Wire close-handler in `lib/contracts/rancher.recordClose` to auto-insert Marketing Deliverable rows per the tier matrix in `docs/MARKETING-DELIVERY-GAMEPLAN.md`. Add new cron `app/api/cron/marketing-deliverables-digest/route.ts` running weekly Monday 9 UTC that posts the digest to Telegram. Surface overdue deliverables (Status=pending + Due Date < today - 1 day) in red. Schedule via `vercel.json`. Test by inserting 5 mock deliverables across the 3 tiers and verifying digest renders.

**Operator pre-flight (parallel to dev):**
1. Set up Buffer or Later account for social scheduling
2. Source video editor (Upwork / Fiverr / referral) — start interviews around 3 Operators signing up
3. Source Calendly for quarterly 1:1 booking links
4. Draft 5 sample social case study templates Ben can adapt per close (1 reel-style, 1 quote graphic, 1 carousel, 1 plain text post, 1 thread)
5. Build founder-letter feature template (1 paragraph + 1 photo placement) — Ben writes 1 example feature for an existing Ranch-tier rancher BEFORE first paying Ranch signup to prove the deliverable is ready

---

## TL;DR

- 3 tiers = 3 different ongoing rituals
- Pasture autopilot + 1 newsletter touch/close
- Ranch = social per close + monthly review + quarterly listing rewrite + 1 founder-letter feature/q
- Operator = 2 reels + 1 email + listing managed + quarterly YouTube + quarterly call
- Ben's capacity: ~60 hr/mo → max ~4 Operators OR 15 Ranches OR 120 Pastures OR mix
- Marketing Deliverables Airtable table = source of truth; weekly digest surfaces work
- Quality gates: human-in-the-loop on every shipped deliverable
- Onboarding launch sequence: Day 0/1/3-7/14/30/90 motions per new rancher
- Hiring triggers at 3 Operators (video editor) / 5 Operators (VA) / 30 Ranches (writer)
- 5 AI-automation candidates deferred to Stage-4 — Stage-3 ships manual + tracked

Committed to plan. Marketing motion is now systematized, not vibes-based.
