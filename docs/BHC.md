# BHC — Marketing Throttle Reference

Single source of truth for all BuyHalfCow marketing material. Top-of-funnel
to bottom-of-funnel conversion paths, voice, audience, channel-specific
copy, CTAs. Used by the marketing skill. Update when business model evolves.

**Status:** v1, post-launch ready
**Companion docs:** `VISION.md` (locked plan + give-back) · `BUSINESS-MODEL.md` (engines, costs, metrics) · `MONEY-FUNNELS.md` (paths to money + funnels) · `BHC-PLATFORM-MAP.md` (code-level truth)
**Last revised:** 2026-05-03 · **tier_v2 note added 2026-06-15**

> **⚠️ 2026-06-15 — money model changed (tier_v2 is LIVE).** The "10% commission only on closed deals / you close the deal, we take 10%" lines below describe the **legacy** model. For ranchers migrated to **tier_v2**, BHC collects its commission **upfront** on the buyer's deposit via Stripe Connect, and the rate is tier-based (Legacy Connect 10% · Pasture 7% · Ranch 3% · Operator 0%, `lib/tiers.ts`). On tier_v2, **Ben runs the sales call** and the deposit closes the buyer — it is no longer "the rancher closes, we invoice 10% after." Onboarding is the self-serve `/rancher/setup` wizard (tier pick → Connect bank → prices → sign → go live) **or** a booked "Rancher Onboarding" call. Treat the verbatim "10%" pitch lines as **legacy-only**; for current rancher/buyer money copy, anchor to `MONEY-FUNNELS.md`.

---

## ONE-LINE PITCHES (use verbatim)

- **Generic / press:** "BuyHalfCow is the private network connecting families directly to verified ranchers. Real beef, no middleman, no markup on your meat." _(2026-06-15: dropped the "10% commission only on closed deals" tag — commission is now tier-based and, for tier_v2 ranchers, collected upfront on the deposit. Don't state a flat 10% in press.)_
- **Buyer-facing:** "Source beef directly from a real ranch in your state. Quarter, half, or whole. The way local families have been doing it for generations."
- **Rancher-facing (tier_v2):** "We bring qualified, in-state buyers to your door and run the sales call. You raise and fulfill the beef. Pick your plan — pay as little as 0% commission." _(Legacy line, now tier-dependent: ~~"You close the deal. We take 10%."~~ — only true for un-migrated legacy ranchers. tier_v2 rates: Legacy Connect 10% · Pasture 7% · Ranch 3% · Operator 0%.)_
- **Founder/backer-facing:** "100 spots, $1,000 each. Numbered placement, lifetime priority, no equity, no theatrics. The Founding Herd is the people who paid in before this was easy to bet on."
- **Brand-facing:** "Three tiers. $99/$499/$2,500. Get your brand in front of D2C ranchers + the families who buy real beef."
- **Mission line (always available):** "We're gonna take back American ranching and agriculture. One family, one rancher, one freezer at a time."

---

## BRAND VOICE

### Tone
Direct. Lowercase opener. Plain English. No hype words. Rancher-aligned, never coastal-startup. Founder-first signature ("— Ben").

### YES words
real · direct · family · raised · cut · pasture · grass-fed · network · proof · routed · closed · freezer · ranch · partner · honest

### NO words (never use)
synergy · disrupt · ecosystem · stakeholder · curate · craft (verb) · journey · revolutionary (the noun "revolution" is OK) · platform-as-a-service · powered by · best-in-class · seamless · holistic

### Sentence patterns
- Lead with verb when possible.
- Two-sentence paragraphs. Three max.
- Numbers concrete: "10%", not "ten percent". "$1,200", not "twelve hundred dollars".
- One CTA per email.
- Sign every email `— Ben` or `— Benjamin`. Never `— The BuyHalfCow Team`.

### Subject lines
Lowercase. Sentence-fragment OK. Specific over clever. Examples:
- `welcome to the founding herd, [name]`
- `[ranch] is on the map — set up your page`
- `commission invoice: [buyer] — [ranch]`
- `your sackett ranch order is ready`
- `we routed sarah k. to you`

### Forbidden subject patterns
- ALL CAPS
- 🎉 emoji-stuffed openers (one emoji max, only when meaningful)
- "Don't miss out" / "Last chance" / fake urgency
- Anything that sounds like a SaaS launch announcement

---

## AUDIENCE SEGMENTS

### 1. BEEF BUYER
**Profile:** Family of 3-6, household income $80k+, owns or has access to a
freezer, fed up with grocery beef quality, willing to commit $1k-$3k to a
share once or twice a year. Often: ex-grocery shopper who tried farmers
markets, found the logistics frustrating, wants direct.

**Where they hang out:** Instagram (food + family content), local Facebook
groups, NextDoor, real-food podcasts, regenerative-ag communities.

**What they fear:**
1. Getting scammed by an unknown "rancher"
2. Beef arriving freezer-burned or wrong cuts
3. Wasting money on something they can't store
4. Being talked down to about food choices

**What they want to hear:**
1. "We verified the rancher already. You're not picking blind."
2. "Real prices, real cuts, real pickup dates."
3. "If something goes wrong, we make it right."
4. "Other families like yours bought from this rancher last month."

**Funnel entry:** `/access` quiz · `/wins` social proof · `/map` discovery

### 2. D2C RANCHER
**Profile:** Operates 10-500 head, sells some product direct already, knows
the marketing-is-hard problem, has a website (often Shopify or Squarespace),
processes through a local USDA facility, often multi-generational.

**Where they hang out:** Stockmanship Journal · Beef Magazine · regional
ag-extension Facebook groups · ranch-podcast Twitter · word-of-mouth at
processor parking lots.

**What they fear:**
1. Getting locked into a marketplace that owns the customer
2. Paying for leads that don't close
3. Surprise commission rules
4. Marketing tech they can't operate
5. BHC stealing their customers + reselling

**What they want to hear:**
1. "Non-exclusive. Sell anywhere else you want."
2. "Pick your commission: 0% on Operator, or pay-per-sale on Legacy Connect — your choice." _(2026-06-15: replaced the legacy "10% only when YOU close the deal" — tier_v2 commission is tier-based and collected upfront on the deposit.)_
3. "Pause routing or leave any time."
4. "Five-minute self-serve onboarding. No call required."
5. "We send you pre-screened, in-state, ready-to-buy buyers."

**Funnel entry:** `/map/add-a-rancher` · `/partner` · cold scrape via /map

### 3. FOUNDING HERD BACKER
**Profile:** Existing buyer who already believes in the mission, OR
follower from social who wants skin in the game without VC equity. Income
range varies wildly — some $9/mo Herd subscribers, some $15k Title Founders.
Common thread: they want their name on something real.

**Where they hang out:** Already on the BHC mailing list / IG follow / has
seen the founder content.

**What they fear:**
1. Funding something that gets sold to Tyson
2. Being treated like a number after they pay
3. The "give-back" being marketing fluff

**What they want to hear:**
1. "No equity. No SAFE. No securities. You buy perks + a name on the wall."
2. "15% of net profit goes back to ranchers when we hit profitability."
3. "Public expense ledger every quarter. We say where the money went."
4. "100 spots. Numbered. Forever."

**Funnel entry:** `/founders` · founder letters · IG founder content

### 4. BRAND PARTNER
**Profile:** D2C-aligned product brand (coolers, knives, cutting boards,
regen supplements, ranching media). Wants distribution to the rancher
network + the buyer list. Annual marketing budget $10k+.

**Where they hang out:** Industry publications · founder Twitter · already
in adjacent D2C ag/food communities.

**What they want to hear:**
1. "Direct distribution to verified D2C ranchers + their families."
2. "Logo placement, dedicated posts, founder-letter inclusions."
3. "We gate carefully. Fit > revenue. We've walked away from 2 sponsors already."

**Funnel entry:** `/brand-partners` · founder direct outreach

---

## FUNNEL STAGES (per segment)

Three stages: **TOFU** (awareness) → **MOFU** (consideration) → **BOFU** (close).

### BUYER FUNNEL

| Stage | Asset | Channel | CTA | Conversion event |
|-------|-------|---------|-----|------------------|
| TOFU | "Mystery beef" reel | IG / TikTok | "Follow @buyhalfcow" | Follow |
| TOFU | `/wins` page case studies | Twitter / IG link in bio | "See real deals" | Page view |
| TOFU | Founder narrative thread | Twitter / LinkedIn | "Read more" | Engagement |
| MOFU | `/map` discover map | Direct link in posts | "Find a rancher near you" | Map page view |
| MOFU | Rancher landing page (`/ranchers/[slug]`) | Map click-through | "See pricing" | Pricing scroll |
| MOFU | "Why direct beef" educational email | Welcome sequence | "Take the quiz" | Email open |
| BOFU | `/access` quiz | All channels converge | "Get private access" | Quiz submit |
| BOFU | Welcome + Ready-to-Buy email | Auto-fired | "I'm ready to buy" YES button | Click → match |
| BOFU | Intro email from rancher | Auto-fired post-match | "Reply to lock in" | Reply / phone call |
| CLOSE | Rancher dashboard "Closed Won" | Manual rancher action | n/a | $X commission accrued |

### RANCHER FUNNEL

| Stage | Asset | Channel | CTA | Conversion event |
|-------|-------|---------|-----|------------------|
| TOFU | Cold scrape → yellow pin on map | Public discovery | n/a (passive) | Pin appears |
| TOFU | Community-submit ("fan flagged you") | Email from BHC | "See your listing" | Page view |
| TOFU | "What is BHC" video | YouTube / IG | "Add yourself" | Click |
| MOFU | `/map/add-a-rancher` self-submit form | Direct link | "Add me to the map" | Form submit |
| MOFU | Welcome email + setup magic link | Auto-fired | "Set up your page" | Wizard load |
| MOFU | Wizard step 0 (business model + buyer count widget) | In-product | "Got it — let's set up" | Step 1 enter |
| BOFU | Wizard steps 1-3 (contact + brand + pricing) | In-product | "Save & continue" | Step 4 enter |
| BOFU | First-buyer simulation (step 4) | In-product | "Sign & go live" | Agreement signed |
| BOFU | Live page + dashboard | Auto-redirect | "Open dashboard" | Login |
| CLOSE | First closed deal | Rancher dashboard action | n/a | First $X commission |

### FOUNDER FUNNEL

| Stage | Asset | Channel | CTA | Conversion event |
|-------|-------|---------|-----|------------------|
| TOFU | Founder narrative threads | Twitter / IG | Follow | Follow |
| TOFU | "Why backing matters" content | Founder letters | Read | Open rate |
| MOFU | `/founders` page | Direct link | "See the tiers" | Page view |
| MOFU | Founders Wall live counter | `/founders#wall` | "Read the wall" | Wall scroll |
| BOFU | Tier card (Herd / Outlaw / Steward / Founding 100 / Title Founder) | `/founders` page | "Claim a spot" | Stripe Checkout |
| CLOSE | Stripe webhook → welcome email | Auto-fired | "See the wall" | Wall placement live |

### BRAND PARTNER FUNNEL

| Stage | Asset | Channel | CTA | Conversion event |
|-------|-------|---------|-----|------------------|
| TOFU | "We work with brands" social mention | IG / Twitter | "Brand partners" | Page view |
| TOFU | Founder direct outreach (manual) | Email | "20-min call" | Reply |
| MOFU | `/brand-partners` page | Direct link | "See tiers" | Page view |
| MOFU | Tier comparison + FAQ | On page | n/a | Scroll |
| BOFU | Stripe Payment Link per tier | Page CTA | "Sign up · [tier]" | Stripe payment |
| CLOSE | Manual fulfillment (logo, post, drop) | Ben | n/a | First deliverable shipped |

---

## CTA LIBRARY (verbatim)

### Buyer
- "Get Access to the Network"
- "Take the 90-second quiz"
- "Find a rancher near you"
- "See real deals" (→ /wins)
- "Reserve your share"
- "I'm ready to buy in 1-2 months" (warmup YES button — never change)

### Rancher
- "Add me to the map" (self-submit)
- "Add a rancher to the map" (community-submit + buyer-flagged-rancher)
- "Set up your page in 5 minutes"
- "Sign & go live"
- "Open my dashboard"
- "Schedule a 15-min call with Ben" (escape hatch)

### Founder
- "Claim a Founding 100 spot"
- "Claim a Title Founder spot"
- "Back the build · $9/mo"
- "Read the wall"
- "See the tiers"

### Brand
- "Sign up · Spotlight"
- "Sign up · Featured"
- "Sign up · Co-marketed"
- "Email to start"

---

## STAT LIBRARY (always-current — pull live for posts)

Use these in copy. Update via `/morning` Telegram digest or Airtable directly.

| Stat | Source | Frequency |
|------|--------|-----------|
| Total verified ranchers | Airtable Ranchers · Verification Status=Verified | live |
| Self-submitted ranchers (yellow pins) | Airtable Ranchers · Self-Submitted At not blank | live |
| Total deals closed | Airtable Referrals · Status=Closed Won | live |
| Total GMV | Sum of Sale Amount on Closed Won | live |
| Total members | Airtable Consumers count | live |
| Beef Buyer signups | Consumers · Segment=Beef Buyer | live |
| States covered | distinct State values | live |
| Founding 100 claimed | Consumers · Founder Tier=Founding 100 count | live |
| Title Founders claimed | Consumers · Founder Tier=Title Founder count | live |
| Founding Herd MRR | Sum of Tier Amount Paid for active subscriptions | monthly |

**Endpoints to call from copy / scripts:**
- `GET /api/stats/public` — buyer count, rancher count, state count
- `GET /api/stats/buyers-by-state?state=XX` — per-state buyer count

---

## EMAIL TEMPLATES (canonical)

All in `lib/email.ts`. Don't write new ones — extend existing.

### Buyer welcome ("Welcome + Ready to Buy")
- `sendWelcomeAndReadyToBuy()` — fired from `/api/consumers` POST
- Subject: `welcome to buyhalfcow, [name]`
- One CTA: "I'm ready to buy in 1-2 months" (warmup engage link)

### Buyer intro to rancher
- `sendInquiryToRancher()` — fired from `/api/matching/suggest`
- Subject: `we routed [buyer] to [ranch]`
- Reply-To tagged: `ref-[recordId]@replies.buyhalfcow.com`

### Rancher self-submit welcome
- `sendRancherSelfSubmitWelcome()` — fired from `/api/prospects/self-submit`
- Subject: `[ranch] is on the map — set up your page`
- Primary CTA: "Set up your page →" (magic link to wizard)
- "Book a call" fallback link present (Cal.com; new code resolves it live via `getOperatorBookingUrl`, `lib/calBooking.ts`)

### Rancher community-submit intro
- `sendRancherCommunityIntro()` — fired from `/api/prospects/self-submit` for community-flagged ranchers
- Subject: `[submitter] thinks you should know about us`

### Founder welcome (5 tier variants)
- `sendFoundingHerdWelcome()` — fired from `/api/webhooks/stripe` after `checkout.session.completed`
- Tier-specific copy. Single CTA: "See the wall" → `/founders#wall`
- Mission line ALWAYS appears once per email

### Instant commission invoice
- `sendInstantCommissionInvoice()` — fired from rancher dashboard close handler
- Subject: `commission invoice: [buyer] — [ranch]`
- Single line item, 30-day terms, 3 payment methods

### Drip emails
- `sendRancherOnboardingDripDay2/5/14()` — Day 2/5/14 nudges for self-submitted ranchers who haven't completed wizard
- `sendFounderLetterWaiting()` — monthly founder letter to WAITING-stage buyers

---

## SOCIAL TEMPLATES

### Twitter / X — case study post
```
🎯 [Ranch Name] ([State])

[N] closed deals · $[GMV] in [months] months

[Quote from rancher, 1 sentence]
— [Operator first name]

https://www.buyhalfcow.com/ranchers/[slug]
```

Generated via Telegram: `/casestudy [ranch slug or name]`

### Twitter / X — founder backer announcement
```
🪙 The Founding Herd grew today.

[Tier] · [Amount]
[Backer name OR "Anonymous backer"] is in.

[X] of 100 Founding 100 spots claimed.
[Y] of 10 Title Founders.

https://www.buyhalfcow.com/founders
```

### Instagram — rancher onboard reel caption
```
[Ranch Name] just joined the network.

[1-sentence story about the ranch]

If you're in [State] and want real beef from a real family — link in bio.

#realbeef #d2cbeef #[state]beef #buyhalfcow
```

### Instagram — buyer testimonial reel
```
"[Quote — buyer voice]"
— [First initial]. [Last initial], [State]

That's the whole product. Family → rancher → freezer.

Take the quiz: link in bio.
```

---

## ANTI-PATTERNS (what NOT to ship)

1. **Don't promise leads we can't deliver.** Never "guaranteed leads" / "X leads/month." Routing depends on buyer demand.
2. **Don't claim coverage we don't have.** "Every state" lies until we hit 50 states verified.
3. **Don't sell on "saving money."** D2C beef is often MORE per pound than grocery. Sell quality + ethics + freezer economics, not bargain.
4. **Don't pitch ranchers on commission discount.** 10% is the rate. We don't negotiate down.
5. **Don't use buyer names without consent.** First initial + last initial + state. That's it.
6. **Don't claim Founding Herd is investment.** It's not. No equity, no securities. Documented in `/founders` FAQ.
7. **Don't anti-grocery-chain.** We're for ranchers + families, not against any specific company. (We can call out Tyson/feedlot model in founder voice but not in mass marketing.)
8. **Don't fake scarcity.** Founding 100 IS capped at 100 — say so honestly. Don't manufacture countdown timers.
9. **Don't write "we" when "I" is true.** Founder-led brand. Ben writes Ben's voice.
10. **Don't promise "Phase 1 / Phase 2" delivery dates publicly.** Internal roadmap stays internal until shipped.

---

## CONVERSION PATHS — End-to-End

### Buyer: cold → closed deal
```
Cold (IG/Twitter content)
  → Click /access link
  → Take quiz (90 sec)
  → Score ≥60 + qualified → auto-route OR send Ready-to-Buy email
  → Click YES on email
  → matching/suggest fires intros to buyer + rancher
  → Buyer + rancher conversation
  → Rancher closes Won in dashboard → instant invoice fires
```
Median time: 2-21 days from quiz to close.

### Rancher: cold → first close
```
Cold OR self-submit OR community-flag
  → Land on /map/add-a-rancher (or auto-redirect from welcome email)
  → Wizard step 0-4 (5 min)
  → Sign agreement → page live → routing on
  → First buyer YES click in their state → intro email → close
```
Median time: 0-30 days from submit to first close.

### Founder: follower → backer
```
Follower (IG/Twitter)
  → Click /founders link
  → Read tier cards + Wall
  → Click tier
  → Stripe Checkout
  → Webhook fires → welcome email + Wall placement live
  → Telegram alert to Ben → personal email within 24h
```
Median time: 5-30 minutes from page load to backed.

### Brand: outreach → paid partnership
```
Founder DM / cold email
  → Schedule 20-min call
  → Send /brand-partners link
  → Brand picks tier
  → Stripe Payment Link payment
  → Manual fulfillment kicks off (logo, post, drop)
```
Median time: 7-30 days from outreach to paid.

---

## CHANNELS (active)

| Channel | Handle | Cadence | Owner |
|---------|--------|---------|-------|
| Instagram | @buyhalfcow | 3-5 posts/wk + daily story | Ben |
| Twitter / X | (TBD) | Daily, threads weekly | Ben |
| Founder mailing list | (Resend audience) | Monthly + drops | Ben + email-sequences cron |
| Founders Wall | `/founders#wall` | Live | Auto |
| Telegram bot | (private admin chat) | Real-time alerts | Auto |
| YouTube | (TBD) | Quarterly long-form | Ben |
| LinkedIn | (TBD) | Weekly when in B2B / brand-partner mode | Ben |

---

## KEY URLS

| Path | Purpose |
|------|---------|
| `/` | Homepage — buyer-primary CTA + rancher/founder/brand exits |
| `/access` | Buyer quiz (90-sec) — primary buyer entry |
| `/map` | Public discover map — D2C rancher hit list |
| `/map/add-a-rancher` | Self-submit + community-submit form |
| `/wins` | Public case study wall — closed deals |
| `/founders` | Founding Herd capital raise |
| `/brand-partners` | Brand partner tiered offer |
| `/ranchers` | All verified rancher pages |
| `/ranchers/[slug]` | Individual rancher landing page |
| `/rancher/setup?token=` | Self-serve onboarding wizard |
| `/rancher` | Rancher dashboard (post-onboarding) |
| `/member` | Buyer dashboard (post-quiz) |
| `/partner` | Legacy intake form |
| `/about` · `/faq` · `/news` | Static / editorial |
| `/terms` · `/privacy` · `/unsubscribe` | Legal |

---

## SKILL HANDOFF — How to Use This Doc

When generating any marketing material, the BHC skill should:

1. **Identify segment + funnel stage** — who is this for, where in the funnel?
2. **Pull voice from "BRAND VOICE"** — reject any output containing NO words.
3. **Pull copy from existing canonical templates** — if email, extend an existing function in `lib/email.ts` rather than write new from scratch.
4. **Pull stats live from `/api/stats/*`** — never hardcode numbers in marketing.
5. **Pin to channel-specific pattern** — Twitter post ≠ IG caption ≠ email.
6. **Apply CTA from "CTA LIBRARY"** — verbatim. Don't paraphrase.
7. **Cite source URL from "KEY URLS"** — link to the conversion surface.
8. **Reject anti-patterns** — see "ANTI-PATTERNS" list. If output triggers any, regenerate.

### Example skill invocation
> "Generate Instagram caption for AU Beef hitting 5 closed deals."

Skill should:
1. Identify segment: BUYER (the audience reading the IG post wants beef)
2. Funnel stage: TOFU (social discovery)
3. Voice: founder-led, lowercase, plain
4. Pull stats: `/api/casestudy/au-beef` (or Telegram `/casestudy au-beef`)
5. Pattern: Instagram rancher onboard reel caption
6. CTA: "link in bio" → `/access` (buyer-primary)
7. Output:
   ```
   AU Beef just hit 5 closed deals on the network.

   4th-generation Black Angus, Georgia raised, sold direct to families
   who want real beef.

   If you're in GA and want what their families eat — link in bio.

   #realbeef #d2cbeef #georgiabeef #buyhalfcow
   ```

---

## REVISION NOTES

- v1 (2026-05-03): Initial draft. Locked from current production state of marketplace + Founding Herd + brand partner offer.
- Future revisions: append phase as `## v2 (date) — Stripe Connect rollout` etc. Don't delete history.

---

*The food revolution doesn't happen unless ranchers win. Ranchers win when
families buy direct. Families buy direct when we route them. We route them
because they trust the network. They trust the network because it's real.*

— Ben
