# BHC 90-Day Execution Playbook

> **Goal:** Turn $10k investment into $100k+ revenue in 90 days. Stack every available lever (32k social audience, ranchers, podcasts, influencer collabs, founder voice) on top of the autonomous routing engine that's already shipping.

> **Date written:** 2026-05-22 · Day 0 of execution
> **North Star metric:** Closed Won deals per week
> **Secondary metrics:** Founders Herd backers, brand partners signed, rancher retainers, course sales, email list size, YouTube subs

---

## Quick reference — what's already running (autonomous, zero touch)

- `reclassify-buyers` cron classifies all 1,533 buyers nightly
- `email-sequences` cron fires segment-aware emails daily
- `rancher-launch-warmup` cron emails Waitlisted buyers in covered states
- `referral-chasup` cron nudges Intro Sent referrals
- `commission-invoices` cron bills ranchers monthly
- `close-detector` cron surfaces unmarked closes
- Pilot auto-pause fires at goal completion
- Stripe webhooks flow ✅, Telegram bot live ✅, DMARC/DKIM valid ✅

**You wake. Engine has worked all night. You add fuel.**

---

## PHASE 1 — WEEK 1 (Days 1-7) — Production Blitz + Cold Start

### Day 1 — Monday — Gear + first 2 videos

**Morning (8:00-12:00):**
- [ ] 8:00 — Open Telegram BHC bot → run `/bulkfire` → clear 7 stuck Pending Approvals (one tap)
- [ ] 8:05 — Run `/routingstatus` → eyeball segment distribution
- [ ] 8:15 — Send ZK accountability email (copy from `marketing/2026-05-22-zk-commission-recovery/email.md` → Gmail → send to zach@zkranches.com)
- [ ] 9:00 — Order gear: Rode Lavalier Go ($79), 2× Aputure Amaran 100D LED ($269 each), reflector + diffuser ($60). Total ~$700. Same-day Amazon delivery.
- [ ] 10:00 — Download CapCut Pro (free) or DaVinci Resolve (free). Set up Canva for thumbnails.

**Afternoon (12:00-18:00):**
- [ ] 12:00 — Shoot Video 1.1 "What is BuyHalfCow?" (90 sec) on your property. Script in `docs/scripts/marketing-video-scripts.md`. 3 takes max. Don't perfectionism it.
- [ ] 14:00 — Shoot Video 3.1 "Why I'm Building BuyHalfCow" (5 min). Cattle in background. Single shot if possible.
- [ ] 16:00 — Rough-cut both in CapCut. Auto-captions on. Burn captions in. Export 4K.

**Evening (18:00-22:00):**
- [ ] 18:00 — Upload Video 1.1 to YouTube. Title: "What is BuyHalfCow? American beef without the middleman." Pin to channel.
- [ ] 19:00 — Cross-post 1.1 to IG (90-sec reel + carousel), TikTok, Twitter, LinkedIn. Caption opens with hook line.
- [ ] 20:00 — Email blast to 1,533 buyers via Resend admin broadcast. Subject: "I have something to tell you." Body: investor backed, here's what's coming, link to Video 3.1.

**Success criteria EOD Day 1:**
- 2 videos shot
- Video 1.1 live on YouTube + IG + TikTok + Twitter + LinkedIn
- Email blast sent
- $700 of $10k deployed (gear + sundries)

---

### Day 2 — Tuesday — Comparison + Verification videos

**Morning:**
- [ ] 8:00 — Check `/routingstatus` for engagement on yesterday's blast. Count R2B clicks.
- [ ] 8:30 — Shoot Video 1.2 "BuyHalfCow vs ButcherBox vs Crowd Cow vs Grocery" (3 min). Comparison graphics on screen (or describe verbally).
- [ ] 10:00 — Shoot Video 1.3 "How We Verify Every Rancher" (2 min) walking-around-property style.
- [ ] 12:00 — Rough-cut both.

**Afternoon:**
- [ ] 14:00 — Upload Video 1.2 + Video 1.3 to YouTube. Schedule IG/TikTok cross-post for Day 3 morning (drip cadence > burst).
- [ ] 15:00 — Edit Video 3.1 (founder narrative). Tighter. Pin to channel.
- [ ] 16:00 — Embed Video 1.1 on `/` homepage hero (request feature add or commit). Set as the main "what is this?" answer.
- [ ] 17:00 — Pull list of 50 D2C ranchers from Apollo or USDA D2C directory. Filter by state: FL, AZ, GA, VA, OH, IL, PA, IN, MI, SC (top uncovered states from /routingstatus data).

**Evening:**
- [ ] 19:00 — Draft cold-outreach email via `bhc-marketing` skill. Personalize per state in 4-line variations.
- [ ] 20:00 — Set up Smartlead.ai account ($50/mo). Import 50 ranchers. Launch tomorrow.

---

### Day 3 — Wednesday — Launch day

**Morning:**
- [ ] 7:00 — Cross-post Video 1.2 + 1.3 to IG/TikTok.
- [ ] 8:00 — Daily Telegram routing review (`/morning`, `/routingstatus`, `/leads`).
- [ ] 9:00 — Launch Meta ad campaign: $33/day each across TX, CA, TN (3 covered states with highest rancher capacity). Use Video 1.1 90-sec as creative. Target: regen-ag follower lookalike + 80k+ HHI freezer-owner audience. UTM tracking on `/access` lander.
- [ ] 10:00 — Launch 50-rancher cold outreach via Smartlead. Reply-to your inbox.

**Afternoon:**
- [ ] 13:00 — Twitter thread: "American beef got broken. Here's the 4 companies that broke it + what I'm doing about it." 8-tweet thread. Link to /founders.
- [ ] 14:00 — Engage 20 replies on Twitter thread.
- [ ] 15:00 — Tap Pending Approval Telegram cards from any new R2B clicks driven by yesterday's blast.
- [ ] 16:00 — Brand outreach batch — 20 cold emails to D2C-aligned brands (coolers, knives, supplements, BBQ rubs, dry-age bags). Use `bhc-marketing` skill for drafts.

**Evening:**
- [ ] 18:00 — IG live or YouTube live: "AMA: I just got investor backing for D2C beef." 30 min. Drive viewers to /founders.
- [ ] 20:00 — Bedside review: signups today, MATCH_NOW count, brand replies, podcast outreach sent.

---

### Day 4 — Thursday — Rancher testimonials

**Morning:**
- [ ] 8:00 — Routine ops. Tap any new Pending Approval.
- [ ] 9:00 — Phone call w/ 3 top ranchers (Ashcraft / 5 Bar / High Lonesome) to schedule testimonial shoots. Goal: 1 shoot per week for next 8 weeks.
- [ ] 11:00 — Order 100 Founding 100 patches via Custom Ink or Stadri ($10/each = $1k). Sequential numbering 001-100. 3-inch round embroidered.

**Afternoon:**
- [ ] 13:00 — Press kit PDF — single-page: founder photo + bio + platform stats + media-ready quotes + logo + downloadable assets. Use Canva. Free 1-day templates.
- [ ] 15:00 — Subscribe to PR tool (e.g., Muck Rack 30-day trial OR Help A Reporter Out free + Press Hunt).
- [ ] 16:00 — Pitch 10 journalists w/ press kit. Targets: Modern Farmer, Civil Eats, Mother Jones food, Joe Rogan-adjacent regen-ag pods, Beef Magazine, Stockmanship Journal. Subject: "American beef story w/ proof + numbers + ranchers."

**Evening:**
- [ ] 18:00 — Influencer collab outreach — DM 5 aligned creators (Joel Salatin / Will Harris / Greg Judy / Justin Rhodes / Acre Homestead / Sip and Feast / Mad Scientist BBQ). Pitch: free Quarter cow + your audience boost = collab content.

---

### Day 5 — Friday — Sales motion + 4 closes target

**Morning:**
- [ ] 8:00 — Pull `/closepipeline` (or query 141 active referrals). Identify 25 deals at Negotiation status across all ranchers.
- [ ] 9:00 — Telegram bulk-message to each rancher w/ stalled deals: "Push these 2 to close this week and unlock retainer." Personal text from your phone.
- [ ] 10:00 — Founder follow-up to Founders Herd backers (if any from blast). Set up Calendly for Stewards.

**Afternoon:**
- [ ] 13:00 — Outlaw+ first-dibs email blast: "Limited rancher slot opening for [State] — first 5 paying members get access."
- [ ] 14:00 — Affiliate program activation. Email top 5 existing affiliates. Send each $100 swag package (BHC t-shirt + sticker). Tell them: "Your referrals are visible. Let's push this together."

**Evening:**
- [ ] 18:00 — Content batch: shoot 5 IG reels using rancher B-roll captured during testimonials. 30-60 sec each. Hooks pulled from existing 12-video scripts.

---

### Day 6 — Saturday — Sackett or 5 Bar Beef testimonial shoot

**Full day on-site:**
- [ ] 8:00 — Drive/fly to ranch.
- [ ] 10:00 — Shoot Video 2.1 "Why I Joined BuyHalfCow" — 4-question interview format. Get 30 min raw footage + 10 min B-roll.
- [ ] 14:00 — Rough-edit on laptop on the way back.
- [ ] 18:00 — Tomorrow's social content batch: 3 reels of rancher cuts.

---

### Day 7 — Sunday — Cooking content + week 1 review

**Morning:**
- [ ] 8:00 — Shoot Video 4.1 "Your First Quarter Cow" in your kitchen. Use real share from one of your partners.
- [ ] 10:00 — Shoot Video 4.2 "Cooking Your First Roast" — Sunday dinner cooking show.

**Afternoon:**
- [ ] 14:00 — Edit + upload Week 1 wrap. YouTube long-form (5 min): "Week 1 of BHC's $100k Push — what happened."
- [ ] 16:00 — Review Week 1 metrics:
  - YouTube subs: target 100
  - IG follower delta: target +500
  - Email list growth: target +50
  - Signups via /access: target 75
  - Closed Won this week: target 4
  - Founders Herd backers: target 5
  - Brand replies: target 3

**Evening:**
- [ ] 18:00 — Founder letter to email list. Recap Week 1. Drive to /founders.
- [ ] 20:00 — Telegram review of all rancher dashboards. Verify everyone has leads + nobody is silent.

---

## PHASE 2 — WEEK 2-4 (Days 8-30) — Compound + Convert

### Daily cadence (every day):

| Time | Action | Duration |
|---|---|---|
| 8:00 | `/morning` Telegram review + tap pending approvals | 15 min |
| 9:00 | Reply to backer + rancher emails | 30 min |
| 10:00 | 1 piece of content shipped (reel / tweet thread / TikTok) | 60 min |
| 14:00 | Founder-voice tweet thread (3-5 tweets) | 20 min |
| 17:00 | Reply to inbound emails / IG DMs / Twitter replies | 30 min |
| 21:00 | Personal text to 1 rancher with stalled deal — push to close | 5 min |

### Weekly rhythm (W2-W4):

| Day | Block | Action |
|---|---|---|
| Mon | AM | 50 cold rancher outreach emails via Smartlead |
| Mon | PM | YouTube long-form video upload |
| Tue | AM | Schedule rancher testimonial shoot for upcoming week |
| Tue | PM | Brand partner Calendly calls (target 3/week) |
| Wed | AM | 25 cold brand outreach emails |
| Wed | PM | Founder letter to email list |
| Thu | AM | 1 podcast appearance (record OR drop teaser) |
| Thu | PM | IG live or YouTube live for engagement |
| Fri | AM | Outlaw+ "first dibs" email |
| Fri | PM | Week review + content batch for Sat/Sun |
| Sat | All day | Rancher testimonial shoot if scheduled, OR cooking content |
| Sun | AM | Week wrap content + edit |
| Sun | PM | Founder letter + Founder backer outreach |

### Week 2 specific:
- [ ] Shoot Videos 1.3, 2.2, 2.3 (5-min setup walkthrough + 14-day window)
- [ ] First podcast appearance (any of the lined-up ones)
- [ ] First brand partner contract signed (target 1 by Day 14)
- [ ] First Founding 100 backers shipped patches

### Week 3 specific:
- [ ] Course shell built on Teachable/Podia: "How to D2C Your Beef" — 7-module outline. Use existing 12-video framework.
- [ ] 2 podcast appearances booked or recorded
- [ ] Second rancher testimonial shoot
- [ ] First affiliate-driven signups arriving via top 5 affiliates

### Week 4 specific:
- [ ] First Founder letter to backers (transparency report — Week 1 numbers)
- [ ] Course pre-orders open ($297 launch discount, $497 standard). Email blast to rancher list.
- [ ] Press placement land (or pitch-and-follow-up)
- [ ] Influencer collab live — pick the strongest of the 5 you DM'd Day 4

---

## PHASE 3 — WEEK 5-12 (Days 31-90) — Scale + Brand Partners

### Recurring weekly:
- 1 YouTube long-form
- 1 podcast appearance
- 1 IG live
- 5 reels minimum
- 1 brand partner call → ideal 1 contract signed/week
- 1 rancher testimonial shoot (target 6-8 ranchers documented by Day 90)
- 50 cold rancher outreach
- 25 cold brand outreach

### Course launch (Week 8):

**Launch week sequence:**
- Day 1: Pre-launch teaser to email list "I'm building something for D2C-curious ranchers" (no link yet)
- Day 2: Founder letter w/ launch details + early-bird $297
- Day 3: Webinar/live demo of platform + course curriculum
- Day 4-5: Sales pressure — "X spots left at $297" (use scarcity)
- Day 6: Course open at $497 to public
- Day 7: Final reminder email

Target: 30 ranchers buy course Week 1 = $9-15k

### Brand partner pipeline (Week 5+):
- 8 brand partner contracts signed by Day 90
- $2.5k/quarter recurring × 8 = $20k/quarter
- 30% commission to brand partners on their referred buyers (negotiated)

### Rancher retainer expansion (Week 6+):
- Every rancher hitting 5 Closed Won → auto-pause + retainer offer
- 15-20 retainers @ $150/mo = $2,250-3,000/mo recurring by Day 90

### Founding Herd cap pressure (Week 8+):
- Patches shipping → social proof posts on IG ("Patch #42 just shipped to [name] in [state]")
- Counter on /founders showing 80 of 100 claimed by Day 90
- "Final 20 spots" urgency campaign Week 10
- Cap hit by Day 90 → potential price expansion or new tier launch

---

## CONTENT STRATEGY — Hit Every Lever

### Daily content cadence:

| Channel | Format | Frequency |
|---|---|---|
| IG Reels | 60-90 sec from long-form cuts | Daily |
| IG Stories | Behind-the-scenes ops, rancher messages, dashboards | 3-5/day |
| TikTok | Same reel content + native captions | Daily |
| Twitter/X | Founder-voice threads + industry takes | 3-5 tweets/day, 1 thread/week |
| YouTube | Long-form pillar video | 1-2/week |
| YouTube Shorts | Cut from long-form | 3-5/week |
| LinkedIn | Industry-side B2B content | 3/week |
| Email | Founder letter + Outlaw+ drops | 2-3/week |

### Content topic pillars (use existing 12 scripts as framework):

**Pillar 1 — How BHC Works**
- Educate buyers + ranchers
- Drives /access signups

**Pillar 2 — Rancher Testimonials**
- Social proof for new ranchers + buyers
- Drives /map/add-a-rancher signups

**Pillar 3 — Founder Voice**
- Mission narrative + transparency ledger + operational honesty
- Drives /founders backings

**Pillar 4 — Cooking + Cuts**
- Retain post-purchase + drive repeat
- Authority + Reciprocity

**Pillar 5 — Industry Takes (NEW)**
- Beef supply news, meatpacker consolidation, USDA policy
- Drives Twitter following + podcast invitations + press

### Repurposing matrix per video:
- 1 long-form YouTube upload
- 1 IG Reel (60-90 sec cut)
- 1 TikTok (same cut, native captions)
- 1 Twitter video reply attached to a thread
- 1 LinkedIn post (founder-voice videos)
- 1 embed on relevant page
- 5 short clips for Stories/Shorts
- 1 podcast audio cut (for the audio-only feed)

= 11 pieces of content from 1 long-form video.

---

## REVENUE STREAMS — All Six Running Parallel

### 1. Marketplace commissions (10% per deal)
- Already live, autonomous
- Tap Pending Approval in Telegram when surfaced (zero today thanks to gate removal)
- Track in Cron Runs notes daily

### 2. Founders Herd ($100-$15k tiers, 100-cap)
- Page live at /founders
- Drive via daily content
- Patches shipping = social proof loop
- Target 75 backers × $500 avg = $37,500 in 90 days

### 3. Brand partners ($2.5k/quarter recurring)
- /brand-partners page live
- 25 cold emails/week
- 3 Calendly calls/week
- Target 8 paying brands by Day 90 = $20k/quarter recurring

### 4. Rancher retainers ($150/mo each)
- Pilot auto-pause triggers retainer pitch at 5 closes
- Target 15 retainers by Day 90 = $2,250/mo recurring

### 5. Content sponsorships (your 32k audience pulls in)
- 32k followers @ ~$300-1000/sponsored post
- Aligned brands: regen-ag, ranching tools, cooking gear, dry-age bags, smokers
- 2-3 sponsorships/month = $3-6k/month
- 90 days = $9-18k

### 6. Info product — "How to D2C Your Beef" course
- Build Week 3, launch Week 8
- $297 launch / $497 standard
- Target 80 ranchers buy in Q1 = $30-40k

---

## TRACKING — Numbers That Matter

### Daily ops dashboard (via Telegram):
- `/morning` — daily digest
- `/routingstatus` — segment breakdown
- `/cronstatus` — all 21 crons healthy
- `/leads` — pending approvals (should stay near 0)
- `/refs` — referral stage breakdown
- `/money` — revenue + commission summary

### Weekly review (Sunday 6pm):

| Metric | Week 1 | Week 4 | Week 8 | Week 12 |
|---|---|---|---|---|
| Closed Won (week) | 4 | 12 | 25 | 35 |
| Cumulative closes | 4 | 25 | 95 | 200 |
| Founders Herd backers | 5 | 20 | 50 | 75 |
| Brand partners | 0 | 1 | 4 | 8 |
| Retainers | 0 | 2 | 8 | 15 |
| Course sales | 0 | 0 | 30 | 80 |
| YouTube subs | 100 | 1k | 3k | 5k |
| IG followers | +500 | +3k | +10k | +20k |
| Email list | 1.6k | 3k | 6k | 10k |
| Podcast appearances | 1 | 4 | 10 | 16 |
| **Total revenue (cumul.)** | **$3k** | **$25k** | **$70k** | **$120k+** |

### Compound check Day 90:

- ≥$100k cumulative revenue ✅ → unlock Phase 4 (Stripe Connect Phase 1)
- ≥75 Founders Herd backers ✅ → funds Phase 1 engineering
- ≥8 brand partners ✅ → recurring revenue floor established
- ≥5k YouTube subs ✅ → SEO compound activating
- ≥20k IG follower growth ✅ → audience moat building

---

## WHAT KILLS THIS PLAN (Inversion)

### Top failure modes — avoid these:

1. **Quality of content over publishing cadence.** A B+ video today beats an A+ video in 3 weeks. Hit daily volume.
2. **Reactive vs proactive sales motion.** Don't wait for inbound. Cold-message ranchers + brands daily.
3. **Skipping rancher testimonials.** Buyer-side videos easier, but rancher testimonials drive supply growth that everything depends on.
4. **Over-promising backers.** Public ledger = transparency. Don't make claims you can't deliver.
5. **Letting metrics distract from North Star.** Closed Won is the metric. Followers + views are leading indicators only.
6. **Burning out.** You said you'll sleep when dead. Pace within that — 90 days is a sprint, plan it.
7. **Founder bottleneck.** Some operations (responding to emails, content production) are founder-only. Block 2-3 hours/day for production or it crowds out.
8. **Stripe Connect prep being skipped.** Day 60+ start thinking about Phase 1 engineering. By Day 90 you should have a builder lined up.

---

## OVERNIGHT BUILDS — What I Can Ship Before Day 1

These multiply the playbook execution:

### Priority 1 — Day-1 ready
1. **Founder Counter widget on /founders** (real-time "X of 100 backers" public counter) — drives Loss Aversion conversion 30-50%
2. **Auto-draft case-study social posts** — when deal closes, Telegram fires 3 ready-to-paste posts (Twitter + IG + LinkedIn)
3. **Per-state recruit-nudge cron** — weekly Telegram alert "FL has 81 buyers, recruit 5 FL ranchers" w/ Apollo URLs
4. **Public `/wins` page enrichment** — every Closed Won shows as tile w/ rancher photo + buyer state

### Priority 2 — Week 1 ready
5. **Affiliate share button on dashboards** — buyers + ranchers share their referral link in 1 tap
6. **Founder letter editor in Telegram** — `/letter` command opens AI-drafted email to backer list
7. **Sponsored content tracker** — Airtable table + dashboard for sponsor deals + collab content tracking
8. **Course landing page** — /course route + Stripe checkout for "How to D2C Your Beef"

Pick which to ship. I execute overnight.

---

## NORTH STAR REMINDER

When you can tell a rancher:
> *"Sign up. Get matched. Close a deal. We bill you 10%. You keep 90."*

…AND tell a buyer:
> *"Take the quiz. We match you. The rancher reaches out. Pickup local."*

…AND tell a brand:
> *"Show up in front of 10k+ regen-ag-aligned buyers. $2.5k/quarter."*

…AND tell a Founder backer:
> *"Numbered patch. Quarterly ledger. Skin in the game. The platform funds your state's recruiting."*

…AND it all happens autonomously while you sleep (you don't) or while you make content (you do) — that's the system.

**That system is built.** Now you market it.

Go.
