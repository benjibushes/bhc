# BHC Email Audit — every automated + manual email, verbatim

_Generated 2026-06-23. Every nurture / sales / cron / lifecycle / broadcast email BHC can send — verbatim subject + body + trigger + `file:line`. Built to optimize each one._

---

## ⚠️ READ FIRST — what's actually LIVE vs dormant (this changes what to optimize)

1. **The whole nurture-sequence engine is OFF.** `app/api/cron/email-sequences/route.ts` hard-returns unless `EMAIL_SEQUENCES_ENABLED === 'true'` (killed 2026-06-09 in the "Cal-as-funnel" pivot). That dormant-izes the founder letters, every routing-segment nudge, the MATCHED + CLOSED sequences, and abandoned-application recovery. **Only 3 buyer crons run live today:** `abandoned-quiz-nudge`, `buyer-pulse`, `qualified-no-action`. → Decide per-sequence: revive (optimized) or delete. Everything in §1 marked "(sequences engine)" is built-but-silent.

2. **No deposit-paid confirmation email exists.** A buyer pays a deposit and gets **nothing** — `stripe-connect` webhook + `lib/stripeSettlement.ts` are Telegram-only. Same for `awaiting-payment-nudge` (operator Telegram only, never nudges the buyer). Biggest missing money-moment touch.

3. **Voice + signature drift across the whole set.** Sign-offs swing between `— Ben`, `— Benjamin, Founder`, lowercase `— ben`; subjects swing between lowercase founder-voice and Title Case. Several emails ship a **double footer** (the wrapper auto-appends address+unsubscribe, then the template hand-rolls its own). Easy normalization win — and the moment to bake in the new positioning ("we bring you the customers").

4. **Reply-To gaps lose replies.** The highest-stakes human emails — the rancher **Onboarding Package**, the post-signing **"set up your page"**, **reassign** + **resend-intro** rancher copy, both **land-inquiry** emails, and all three **self-submit drip** steps — carry **no tagged Reply-To**, so replies bypass the Conversations classifier (land in the default inbox, untracked).

5. **Dead copy.** The day-14 `onboarding-stuck` "final automated nudge" body is never reached (the code escalates to Telegram + `continue`s before the send).

6. **Two emails aren't templates — they're AI-generated per send.** `lib/autoRespond.ts` (inbound auto-replies) and the buyer chase (`referral-chasup`) are Claude-drafted. The only copy you can edit is their **system prompt** — captured verbatim where they appear.

---

## Counts (~86 distinct emails/templates)

| § | Section | Emails | Status |
|---|---------|--------|--------|
| 1 | Shared shell + buyer nurture / warmup / recovery | 28 | mixed — 3 crons live, the sequence engine dormant |
| 2 | Buyer sales · matching · transactional | 16 | mostly live (intros, login, order, chase, testimonial) |
| 3 | Rancher onboarding · migration | 12 | live |
| 4 | Rancher lifecycle · followup · misc automated | 18 | live |
| 5 | Manual broadcast + reengagement scripts | 12 (+8 listed) | manual (hand-run, `--execute` gated) |

_Not extracted (manual admin one-offs, not funnels): `app/api/admin/cleanup-stale-leads`, `app/api/backfill/send-campaign`._

---

## Contents
- **§1** Shared email shell · buyer nurture, warmup, recovery
- **§2** Buyer sales · matching · transactional
- **§3** Rancher onboarding · migration
- **§4** Rancher lifecycle · followup · misc automated
- **§5** Manual broadcast + reengagement scripts

---
# BHC Buyer-Nurture Email Audit — verbatim copy

## 1. Shared email shell

Every email funnels through `lib/email.ts`. The two entry points are the internal `resend.emails.send()` wrapper (used by the named template functions) and the exported `sendEmail()` helper (used directly by cron routes). `lib/emailMinimal.ts` is a thin layer that just calls `sendEmail()`.

**What wraps EVERY email (the `resend.emails.send` wrapper, `lib/email.ts:282-356`):**

- **From address:** `BuyHalfCow <ben@{domain}>` via `getFromEmail()` (`lib/email.ts:377-381`). Domain rotates across `SEND_DOMAINS` env (default `buyhalfcow.com`) round-robin for deliverability/warmup.
- **Suppression check:** before any send, recipient is lowercased and checked against an in-memory suppression set (Unsubscribed / Bounced / Complained, pulled from Consumers + Ranchers tables, 5-min TTL cache). Suppressed → silently skipped, returns `{ id: 'skipped-suppressed' }`. Bypass only with `_bypassSuppression: true`.
- **Reply-To tagging (`lib/email.ts:312-321`):** resolution priority — (1) explicit `replyTo` honored as-is; (2) `_replyContext: { type, recordId }` → tagged address `{type}-{recordId}@replies.buyhalfcow.com` (e.g. `ref-recXXX@…`, `usr-recXXX@…`, `rnc-recXXX@…`) so replies hit `/api/webhooks/resend-inbound` and log to the Conversations table; (3) default fallback `inbox@replies.buyhalfcow.com`. Tag types: `ref` (referral), `usr` (consumer), `rnc` (rancher), `inq`, `thread`.
- **CAN-SPAM footer (auto-appended to every HTML body unless `_skipFooter`, `lib/email.ts:474-485`):** physical address `BuyHalfCow · 1001 S. Main St. Ste 600 · Kalispell, MT 59901` (env `BUSINESS_ADDRESS`) + an `Unsubscribe` link (signed 365-day JWT token) + a `Privacy Policy` link. NOTE: many templates ALSO hand-roll their own inline footer/unsubscribe inside the body, so those emails carry the address/unsubscribe twice.
- **List-Unsubscribe headers:** templates pass `getUnsubscribeHeaders()` → `List-Unsubscribe: <…/api/unsubscribe?token=…>` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (`lib/email.ts:401-407`).
- **Preheader injection:** optional `preheader` field → hidden preview-text div injected after `<body>` (`lib/email.ts:266-280`).
- **Plain-text part:** auto-generated from HTML (after footer/preheader) for multipart/spam-filter friendliness (`htmlToPlainText`, `lib/email.ts:180-198`).
- **Rate limit:** global token bucket, 8 sends/sec, 1.1s backoff + retry on 429 (`lib/email.ts:231-258`).
- **Frequency cap + audit:** named templates route through `guardedSend()` (`lib/email.ts:414-467`) which runs `checkFrequencyCap()` and writes a row to the Email Sends table (`logEmailSend`) with status sent/suppressed. `sendEmail()` callers pass `templateName` to get the same treatment.
- **UTM:** link helper `utm(url, campaign, content)` appends `utm_source=email&utm_medium=drip&utm_campaign=…` (`lib/email.ts:490-495`).

**Design tokens shared by almost every body:** cream background `#F4F1EC`, white card `max-width:600px` with `1px solid #A7A29A` border, Georgia serif headings, body text `#2A2A2A`/`#6B4F3F`, black CTA button `#0E0E0E` with cream `#F4F1EC` text, uppercase letter-spaced. Signed `— Ben` / `— Benjamin, Founder` / tagline `Connecting every household to a ranch they trust.`

**IMPORTANT — pipeline currently PAUSED:** `app/api/cron/email-sequences/route.ts:849` hard-returns unless `EMAIL_SEQUENCES_ENABLED === 'true'` (sales-floor pivot 2026-06-09 — drip killed in favor of Cal-as-funnel). The cron stays scheduled; flipping the env re-enables every email in section 2's email-sequences subsection. The other crons (abandoned-quiz-nudge, buyer-pulse, qualified-no-action, etc.) are NOT behind this flag and run live.

---

## 2. Buyer nurture + warmup + recovery

> Ordering: email-sequences engine first (abandoned-recovery → routing-segment branch → stage-machine branch), then the standalone crons.

---

### email-sequences · Abandoned Application Recovery — Email 1 — `app/api/cron/email-sequences/route.ts:112` → `lib/email.ts:3769`
- **Fires:** daily 10am MT (gated by `EMAIL_SEQUENCES_ENABLED=true`). Consumer `Source="abandoned_application"`, `Status != "Approved"`, Sequence Stage `abandoned_pending`, age ≥ 24h. (Records created by `/api/abandoned-app`.) Cap 30/run.
- **To:** abandoned-application leads (entered email on /access, never finished) · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `You started something on BuyHalfCow — finish in 60 seconds?`
- **Body:**
> # You started something on BuyHalfCow — finish in 60 seconds?
> Hi {firstName}, _(or "Hey," if no name)_
>
> You started signing up for BuyHalfCow but didn't finish. No pressure — I just wanted to leave the door open.
>
> If you tell us what you're looking for (Quarter, Half, or Whole; budget; state), I'll send a one-click "ready to buy?" prompt right after — and the moment you tap YES, you get matched with a verified rancher in your state.
>
> Takes about 60 seconds. We saved your email so you don't have to retype it.
>
> **[Finish My Application →]** (`/access?email={email}` + UTM)
>
> — Benjamin, Founder
> BuyHalfCow

---

### email-sequences · Abandoned Application Recovery — Email 2 — `app/api/cron/email-sequences/route.ts:112` → `lib/email.ts:3769`
- **Fires:** daily 10am MT. Sequence Stage `abandoned_email1_sent`, ≥ 72h since last send.
- **To:** abandoned-application leads · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `Still want in? Your spot is held`
- **Body:**
> # Still want in? Your spot is held
> Hi {firstName},
>
> Quick check-in — you signed up for BuyHalfCow a few days ago but didn't finish the application.
>
> The flow is simple: finish the form (Quarter/Half/Whole + budget + state), then I send you a one-click "Ready to Buy in 1–2 months?" prompt. The moment you click YES, I match you with a verified rancher in your state — they reach out within 24–48 hours.
>
> If something stopped you (questions about pricing, how it works, what you'd actually get) just reply to this email and I'll answer personally.
>
> **[Finish My Application →]**
>
> — Benjamin, Founder · BuyHalfCow

---

### email-sequences · Abandoned Application Recovery — Email 3 — `app/api/cron/email-sequences/route.ts:112` → `lib/email.ts:3769`
- **Fires:** daily 10am MT. Sequence Stage `abandoned_email2_sent`, ≥ 7 days since last send. (Final touch.)
- **To:** abandoned-application leads · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `Last touch — what BuyHalfCow actually does`
- **Body:**
> # Last touch — what BuyHalfCow actually does
> Hi {firstName},
>
> Last note from me — I won't keep emailing.
>
> BuyHalfCow isn't a marketplace. It's a private network where I personally introduce serious buyers to verified ranchers. Most members save 30-50% vs grocery beef and end up with 6-12 months of premium cuts in their freezer.
>
> If you're still interested, finishing the form takes a minute. If not, no hard feelings — I'll stop the emails after this one.
>
> **[Finish My Application →]**
>
> — Benjamin, Founder · BuyHalfCow

---

### email-sequences · Routing Segment MATCH_NOW — rescue fallback — `app/api/cron/email-sequences/route.ts:475` → `lib/email.ts:4259`
- **Fires:** daily 10am MT. `Routing Segment = MATCH_NOW` (Ready to Buy=true), segment send count < 1, no locked active referral, AND auto-route to `/api/matching/suggest` found no rancher with capacity. (If auto-route succeeds the buyer instead gets the live intro email below — no rescue copy.)
- **To:** ready-to-buy buyers awaiting a manual rancher match · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `your rancher is lined up — intro coming in 24 hours`
- **Body:**
> # Your rancher is lined up
> Hi {firstName},
>
> You clicked "ready to buy" — thanks for the signal. I've matched you with a verified rancher in {buyerState} who's got capacity for you this season.
>
> You'll get a second email within the next 24 hours with their name, pricing (Quarter / Half / Whole), processing date, and direct contact info. They'll also reach out to you within 48 hours.
>
> From there it's between you and the ranch — pickup date, cut sheet, payment method. We take 10% only when the deal closes. The rancher keeps 90.
>
> If anything changes, reply to this email and I'll handle it.
>
> — Ben · BuyHalfCow

---

### email-sequences · MATCH_NOW promote-PA — buyer intro — `app/api/cron/email-sequences/route.ts:338` → `lib/email.ts:1132` (`sendBuyerIntroNotification`)
- **Fires:** daily 10am MT. MATCH_NOW buyer who has a stuck `Pending Approval` referral with a linked rancher → promoted to Intro Sent and this live intro fires (pricing + contact pulled from the rancher record).
- **To:** matched buyer · **Reply-To:** tagged `ref-{referralId}@replies.buyhalfcow.com` when `referralId` set
- **Subject:** `Your rancher match: {rancherName} in {state}` (🔥 prefix when readyToBuy) — *(subject built deeper in sendBuyerIntroNotification; pricing/contact/deposit/Cal blocks are dynamic per rancher)*
- **Body (verbatim structural copy, dynamic blocks noted):**
> Hi {firstName},
>
> _(intro line introducing {rancherName} as the buyer's verified match in {state}; when `readyToBuy` a "you confirmed you're ready to buy" reminder is added)_
>
> **Current pricing from {rancherName}:** _(table — rows shown only for configured tiers)_
> | Quarter Cow | ${quarterPrice} | {quarterLbs} lbs |
> | Half Cow | ${halfPrice} | {halfLbs} lbs |
> | Whole Cow | ${wholePrice} | {wholeLbs} lbs |
> **Next processing date:** {nextProcessingDate}
> [View full ranch page →] (`/ranchers/{rancherSlug}`)
>
> _Reserve-your-share block (one of two):_
> **RESERVE YOUR SHARE NOW** — {rancherName} processes on a rolling cycle — your deposit puts you on the books for the next available slot. Spots fill first-come, first-served. **[Reserve your share — secure deposit →]** **No deposit, no slot held.** Refundable until {rancherName} accepts your slot. Non-refundable after. Cold-chain guarantee + BHC mediation always apply.
> _(legacy ranchers get a tap-any-tier Payment-Link variant instead.)_
>
> _(plus rancher direct contact: name / email / phone; optional "Schedule 15-min call" Cal CTA; login link to `/member`.)_

*(Full per-tier/deposit/Cal HTML lives at `lib/email.ts:1132-1380+`; the load-bearing buyer-nurture copy is the reserve block + pricing table above.)*

---

### email-sequences · MATCH_NOW promote-PA — rancher intro — `app/api/cron/email-sequences/route.ts:356` (inline `sendEmail`)
- **Fires:** same promote-PA path as above — the rancher-side half of the introduction. *(Rancher-facing, included for completeness.)*
- **To:** matched rancher · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `BuyHalfCow Introduction: {buyerName} in {buyerState}`
- **Body:**
> # New buyer lead
> Hi {rancherName},
>
> You have a new buyer matched to you on BuyHalfCow. Reach out today:
>
> **Buyer:** {buyerName}
> **Email:** {buyerEmail}
> **Phone:** {buyerPhone}
> **Location:** {buyerState}
> **Order:** {orderType}
> **Budget:** {budgetRange}
> **Notes:** {notes} _(only if present)_
>
> — Ben, BuyHalfCow

---

### email-sequences · Routing Segment NUDGE_TO_ENGAGE — `app/api/cron/email-sequences/route.ts:498` → `lib/email.ts:4298`
- **Fires:** daily 10am MT. `Routing Segment = NUDGE_TO_ENGAGE` (qualified + in covered state, never engaged a warmup), segment count < 2, ≥ 7 days since last segment send. (Up to 2 lifetime sends.)
- **To:** qualified-but-unengaged buyers in covered states · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `quick question on your {buyerState} beef timing`
- **Body:**
> # One question on timing
> Hi {firstName},
>
> You signed up for BuyHalfCow a while back and we've got verified ranchers in {buyerState} with capacity right now. Before I introduce you, I want to make sure the timing is right.
>
> > **Are you ready to buy in the next 1–2 months?**
>
> If yes, tap below and I'll send the rancher's full info within 24 hours. They reach out to you direct. No middleman, no markup — we take 10% only when the deal closes.
>
> **[Yes — Ready to Buy]** (`/api/warmup/engage?token=…`)
>
> If not yet, just don't click. You stay on the list and we'll check back in a couple weeks. No pressure.
>
> — Ben · BuyHalfCow

---

### email-sequences · Routing Segment WARM_LEAD — ready check — `app/api/cron/email-sequences/route.ts:509` → `lib/email.ts:4341`
- **Fires:** daily 10am MT. `Routing Segment = WARM_LEAD` (clicked YES on warmup but never "Ready to Buy"), segment count < 4, ≥ 14 days since last segment send. (Up to 4 lifetime sends, bi-weekly.)
- **To:** warm leads (interested, not yet ready) · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `ready to buy yet? quick check-in`
- **Body:**
> # Ready yet?
> Hi {firstName},
>
> You said you were interested in beef from a {buyerState} rancher. We've still got capacity and I want to make sure I introduce you at the right time.
>
> **If you're ready to buy in the next 1–2 months**, tap below and I'll send rancher info within 24 hours. If timing isn't right yet, just sit tight — I'll check back in a couple weeks.
>
> **[Yes — Ready to Buy]** (`/api/warmup/engage?token=…`)
>
> — Ben · BuyHalfCow

---

### email-sequences · Routing Segment NO_BUDGET_FOUNDER_PITCH — `app/api/cron/email-sequences/route.ts:518` → `lib/email.ts:4432`
- **Fires:** daily 10am MT. `Routing Segment = NO_BUDGET_FOUNDER_PITCH` (wants BHC beef but budget < share cost), segment count < 1. (1 lifetime send, then monthly community letter.)
- **To:** mission-aligned buyers who can't afford a share this year · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `beef's not in the budget? back the mission for $100`
- **Body:**
> # Beef this year isn't in the budget? I get it.
> Hi {firstName},
>
> You signed up for BuyHalfCow. You care about how cattle gets raised. You're on the right side of the food fight. But buying a Quarter is $650–$1,000 — that's not in the budget for a lot of people this year. I won't pretend otherwise.
>
> Here's another way to be part of this without the freezer commitment.
>
> ---
>
> **The Founding Herd.** 100 numbered spots. Back the platform from $100 (Herd) to $1k (Outlaw+) to $15k (Title Founder). You get:
> - Numbered embroidered patch shipped to your door
> - Quarterly expense ledger in your inbox — see exactly where every dollar went
> - Name on the public Founders Wall (opt-in)
> - First-pick access when a rancher comes online in your state
> - Voting rights on platform direction decisions
>
> I'm not selling equity. I'm not running a crowdfund I'm going to disappear from. I'm building a marketplace I'd want to use, and the Founding Herd capital is what funds the recruiting team that brings ranchers + buyers together.
>
> **[See the Founding Herd]** (`/founders`)
>
> If $100 isn't in the budget either, no worries — you stay on the list and I'll email when {buyerState} comes online. The work continues either way.
>
> — Ben · BuyHalfCow

---

### email-sequences · Routing Segment STATE_WAITLIST — `app/api/cron/email-sequences/route.ts:527` → `lib/email.ts:4541`
- **Fires:** daily 10am MT. `Routing Segment = STATE_WAITLIST` (qualified + can afford, but uncovered state), segment count < 1. (1 lifetime send, then monthly community letter.)
- **To:** qualified buyers in uncovered states · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `scouting ranchers in {buyerState} — you're on the list`
- **Body:**
> # We're scouting {buyerState}
> Hi {firstName},
>
> Thanks for signing up. Straight read: we don't have a verified rancher in {buyerState} yet. You're on the waitlist.
>
> I cold-email D2C ranchers in uncovered states every week. {buyerState} is on the list. When one signs the agreement + goes live, you're one of the first I match them to.
>
> I'll email when it happens. No spam in the meantime — just one short monthly note so you know the platform is still building.
>
> Thanks for being patient w/ a small platform doing it right.
>
> — Ben · BuyHalfCow

---

### email-sequences · Routing Segment INCOMPLETE_PROFILE — `app/api/cron/email-sequences/route.ts:547` → `lib/email.ts:4383`
- **Fires:** daily 10am MT. `Routing Segment = INCOMPLETE_PROFILE` (missing Order Type / Budget), segment count < 3, ≥ 14 days since last segment send. (Up to 3 letters over 28d: D0 / D14 / D28; subject escalates by attempt.)
- **To:** buyers with incomplete profiles · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject (escalates by send count):**
  - send 0: `two questions on your beef — 30 seconds`
  - send 1: `still want beef from your area? — quick check`
  - send 2: `last note from me — close your loop or i'll stop`
  - *(the cron passes these via `subject` override; default if unset is `two questions on your beef — 30 seconds`)*
- **Body (same body all three sends):**
> # Two quick questions
> Hi {firstName},
>
> You signed up for BuyHalfCow but I don't have enough info to match you with the right rancher in {buyerState}. Two questions, 30 seconds.
>
> > **1.** How much beef do you want? _(Quarter ≈ 90 lbs, Half ≈ 180 lbs, Whole ≈ 360 lbs)_
> > **2.** What's your budget?
>
> Tap below to update your profile — takes less than a minute and gets you matched.
>
> **[Finish my profile]** (`/access`)
>
> If you'd rather just talk it through, reply to this email and I'll help you figure out what makes sense.
>
> — Ben · BuyHalfCow

---

### email-sequences · Stage WAITING — Founder Letter 1 (Day 7) — `app/api/cron/email-sequences/route.ts:567` → `lib/email.ts:793`
- **Fires:** daily 10am MT. `Buyer Stage = WAITING`, days-in-stage ≥ 7, Sequence Stage not yet `WAITING_*`. Stamps `WAITING_L1`.
- **To:** waitlisted buyers (no rancher in state yet) · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `what's actually happening — month one update`
- **Body:**
> Hey {firstName},
>
> Quick update — not marketing, just the real situation.
>
> I'm on the road right now visiting ranches, signing new partners, and building the supply chain so that when we match you, it's the right rancher — not just whoever's available.
>
> **What's happening this week:**
> - Locking down rancher partnerships across multiple states
> - Processing facility tours and agreements
> - Working on getting a verified rancher live in {state}
>
> **Two things you can do right now:**
> 1. **Follow the build** — I'm documenting everything in real time. Ranch visits, negotiations, the whole thing.
> 2. **Help us expand faster** — Know a rancher in {state} who sells direct? Reply with their name.
>
> You'll hear from me the moment there's a rancher ready in {state}. You're already in.
>
> — Benjamin, Founder, BuyHalfCow

---

### email-sequences · Stage WAITING — Founder Letter 2 (Day 30) — `app/api/cron/email-sequences/route.ts:576` → `lib/email.ts:793`
- **Fires:** daily 10am MT. `Buyer Stage = WAITING`, days-in-stage ≥ 30, Sequence Stage `WAITING_L1`. Stamps `WAITING_L2`.
- **To:** waitlisted buyers · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `the ranchers I'm meeting are the real deal`
- **Body:**
> Hey {firstName},
>
> Quick update from the road. I've been visiting ranches, meeting families who've been raising cattle for generations. These aren't factory farms — these are real operations getting squeezed out by big processors.
>
> > "We're gonna take back American ranching and agriculture." That's not a tagline. That's why I'm doing this.
>
> The ranchers I'm partnering with want buyers who care about where their beef comes from. That's you.
>
> **Here's what I need from you:**
> - **Reply to this email** — tell me what cut you're looking for (quarter, half, whole). Helps me prioritize {state}.
> - **Know a rancher in {state}?** Reply with their name. I'll reach out personally.
>
> We're close. More soon.
>
> — Benjamin, Founder, BuyHalfCow

---

### email-sequences · Stage WAITING — Founder Letter 3+ (monthly, Day 60/90/120…) — `app/api/cron/email-sequences/route.ts:588` → `lib/email.ts:793`
- **Fires:** daily 10am MT. `Buyer Stage = WAITING`, Sequence Stage `WAITING_L{n}`, days-in-stage ≥ expected (60 for L3, then +30 each). Stamps `WAITING_L{n+1}`. (letterNumber ≥ 3.)
- **To:** long-waitlisted buyers · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `month {n} update — {state} status`
- **Body:**
> Hey {firstName},
>
> Month {n} update. {state} is still in the build phase. Here's where things are:
>
> **What I'm working on this month:**
> - Active conversations with ranchers in your area
> - Scaling the operation in states already live
> - Building the case studies that recruit the next wave of ranchers
>
> If you've gotten this far, you're committed — and I appreciate it. The wait is real, but so is the network we're building. Reply if you have questions or know a rancher I should meet.
>
> — Benjamin, Founder, BuyHalfCow

---

### email-sequences · Stage READY — Day-7 last-call nudge — `app/api/cron/email-sequences/route.ts:607` (inline `sendEmail`)
- **Fires:** daily 10am MT. `Buyer Stage = READY`, days-in-stage ≥ 7, Sequence Stage ≠ `READY_NUDGE`. Fires once. `{rancherName}` = buyer's active rancher or "a rancher in your area".
- **To:** READY buyers who went quiet after intro · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `last call — {rancherName} is open in {state}`
- **Body:**
> Hey {firstName},
>
> I introduced you to **{rancherName}** last week — didn't hear back, so this is my last nudge.
>
> **Are you ready to buy in the next 1–2 months?** If yes, click below and I'll send their full info. If not, I'll drop you off the active list and check back when timing fits.
>
> **[Yes — Ready to Buy]** (`/api/warmup/engage?token=…`)
>
> — Ben

---

### email-sequences · Stage MATCHED — Day-4 check-in — `app/api/cron/email-sequences/route.ts:630` → `lib/email.ts:880`
- **Fires:** daily 10am MT. `Buyer Stage = MATCHED`, days-in-stage ≥ 4, Sequence Stage ≠ `MATCHED_D4`. Fires once.
- **To:** matched buyers · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `did you connect with {rancherName}?`
- **Body:**
> Hey {firstName},
>
> Quick check-in — I introduced you to {rancherName} a few days ago. Did you connect?
>
> If yes: how'd it go? Any feedback for me?
>
> If not yet: just hit reply and tell me what's up. If you didn't see their email, I'll resend it. If you've got cold feet, totally fine — tell me what changed and I'll work on a different fit.
>
> Either way, I want to hear from you. This network only works if both sides actually talk.
>
> — Ben

---

### email-sequences · Stage CLOSED — Day-14 cuts education — `app/api/cron/email-sequences/route.ts:653` → `lib/email.ts:979`
- **Fires:** daily 10am MT. `Buyer Stage = CLOSED` AND buyer has a Closed Won referral (actually purchased), days-in-stage ≥ 14, Sequence Stage not yet `CLOSED_CUTS`/`CLOSED_M*`/`CLOSED_REPEAT`. Stamps `CLOSED_CUTS`. `{tier}` derived from Order Type (quarter/half/whole/share).
- **To:** buyers who closed a purchase · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `your {tier} cheat sheet — what to cook first`
- **Body:**
> # Your {tier} cheat sheet, {firstName}.
> Most people get their first ranch order, look at 200 lbs of frozen vacuum-sealed packages, and freeze (no pun intended). Here's the field guide.
>
> **Cook these first (the unfamiliar ones)**
> - **Chuck roast (3-4 lbs):** Dutch oven, 6-8 hours at 225°F with onion, garlic, broth. Falls apart with a fork. Best ranch beef you'll cook.
> - **Short ribs:** Same braise as chuck. The cut grocery stores price out of reach is in your freezer for free.
> - **Oxtail:** Don't toss this. Slow-braise 4 hours with red wine and root veg. The richest beef stew on earth.
> - **Tongue:** Boil 3 hours with bay + onion, peel, slice thin. Tacos al pastor at home for $3.
>
> **The reliable everyday cuts**
> - **Ground beef** — the workhorse. Tacos, burgers, chili, bolognese.
> - **Stew meat** — beef stew, beef and broccoli, fajitas if you slice thin.
> - **Sirloin / round steaks** — fast hot pan, don't overcook (medium-rare = pink center).
> - **Ribeye / NY strip** — these are the steaks. Cast iron, salt, butter. Don't sauce them.
>
> **Two rules that matter**
> - **Thaw in fridge, not microwave.** 24-48 hrs for steaks, 2-3 days for roasts. The vacuum seal protects flavor — don't undo it with a thaw shortcut.
> - **Stack flat in the freezer.** Standing up makes finding the cut you want a treasure hunt. Keep similar cuts together.
>
> Reply with what you've cooked so far — I'm collecting first-cook stories.
>
> — Ben
>
> p.s. — bhc patches just shipped to the print shop. founder backers get first pick when they hit my desk. **[shop bhc merch]** (`/shop`)

---

### email-sequences · Stage CLOSED — Monthly letters (Day 60/90/120 = months 2/3/4) — `app/api/cron/email-sequences/route.ts:662,670,678` → `lib/email.ts:1048`
- **Fires:** daily 10am MT. Purchased CLOSED buyer. Month 2: Sequence `CLOSED_CUTS` + day ≥ 60 → `CLOSED_M2`. Month 3: `CLOSED_M2` + day ≥ 90 → `CLOSED_M3`. Month 4: `CLOSED_M3` + day ≥ 120 → `CLOSED_M4`.
- **To:** post-purchase buyers · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `month {monthNumber} — what's happening in the network`
- **Body (same body, {monthNumber} = 2/3/4):**
> Hey {firstName},
>
> Month {monthNumber} since your first order. Quick update from across the network — not a sales pitch, just what's happening.
>
> **What's new:**
> - New ranchers going live — you'll see them on the homepage if you check
> - New states opening up that we couldn't serve before
> - Existing partners scaling up to take more volume
>
> In a few months I'll ping you about the next round. For now, hope your freezer's still well-stocked.
>
> Reply anytime — I read every one.
>
> — Benjamin

---

### email-sequences · Stage CLOSED — Month-5 repeat purchase ask — `app/api/cron/email-sequences/route.ts:687` → `lib/email.ts:1091`
- **Fires:** daily 10am MT. Purchased CLOSED buyer, Sequence Stage `CLOSED_M4` or `CLOSED_M3`, days-in-stage ≥ 150. Stamps `CLOSED_REPEAT`.
- **To:** post-purchase buyers ~5 months out · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `running low? want me to ping {rancherName}?`
- **Body:**
> Hey {firstName},
>
> Five months since your last order with {rancherName}. Most of our buyers are running low about now.
>
> Want me to reach out to {rancherName} about reserving the next one from their fall harvest? Just reply with "yes" and I'll set it up. _(reads "the next share" when no first name)_
>
> Want to try a different rancher this round? Also fine — reply with "different" and I'll match you with someone new.
>
> Don't need anything? Reply with "not yet" and I'll check back in a few months.
>
> — Ben

---

### email-sequences · Rancher agreement reminder — Day 3 — `app/api/cron/email-sequences/route.ts:784` (inline `sendEmail`)
- **Fires:** daily 10am MT. Rancher `Onboarding Status = "Docs Sent"`, not yet signed, 3–7 days since docs sent, stage `none`. *(Rancher-facing, not buyer-nurture — included per "every email in this file".)*
- **To:** ranchers in onboarding · **Reply-To:** tagged `rnc-{rancherId}@replies.buyhalfcow.com`
- **Subject:** `{firstName}, your agreement is ready to sign`
- **Body:**
> Hi {firstName},
>
> Just a quick reminder — your BuyHalfCow Commission Agreement for **{ranchName}** is ready for your signature.
>
> Once signed, you can immediately start setting up your ranch page and we can begin sending buyers your way.
>
> **Quick recap:** 10% commission on referred sales only. No upfront fees. Buyers pay you directly.
>
> If you have any questions, just reply to this email.
>
> — Benjamin, Founder · BuyHalfCow

---

### email-sequences · Rancher agreement reminder — Day 7 — `app/api/cron/email-sequences/route.ts:784` (inline `sendEmail`)
- **Fires:** daily 10am MT. 7–14 days since docs sent, stage `reminder_day3`. *(Rancher-facing.)*
- **To:** ranchers in onboarding · **Reply-To:** tagged `rnc-{rancherId}@replies.buyhalfcow.com`
- **Subject:** `Need help with your agreement, {firstName}?`
- **Body:**
> Hi {firstName},
>
> I noticed you haven't signed the BuyHalfCow agreement yet for **{ranchName}**. No pressure — just want to make sure everything makes sense.
>
> If you have questions about the commission structure, the process, or anything else, just reply to this email and I'll get back to you personally.
>
> We have buyers actively looking for ranch-direct beef in {state}, and I'd love to get you connected with them.
>
> — Benjamin, Founder · BuyHalfCow

---

### email-sequences · Rancher agreement reminder — Day 14 (last) — `app/api/cron/email-sequences/route.ts:784` (inline `sendEmail`)
- **Fires:** daily 10am MT. ≥ 14 days since docs sent, stage `reminder_day7`. *(Rancher-facing.)*
- **To:** ranchers in onboarding · **Reply-To:** tagged `rnc-{rancherId}@replies.buyhalfcow.com`
- **Subject:** `Last check-in — buyers waiting in {state}` _(falls back to "your area" when no state)_
- **Body:**
> Hi {firstName},
>
> This is my last follow-up about the BuyHalfCow partnership for **{ranchName}**.
>
> We currently have buyers looking for ranch-direct beef in {state} and your operation would be a great fit. The agreement takes about 2 minutes to review and sign.
>
> If now isn't the right time, no worries at all. Just reply and let me know, and I'll reach out again when it makes sense.
>
> — Benjamin, Founder · BuyHalfCow

---

### abandoned-quiz-nudge · Touch 1 (invite) — `app/api/cron/abandoned-quiz-nudge/route.ts:68`
- **Fires:** hourly. `Status=Approved`, `Qualified At` empty, signed up within 21d (`QUIZ_NUDGE_MAX_DAYS`) and > 1h ago, not suppressed, not MATCHED/CLOSED, AND state has an operational rancher (served-states only). Touch 1 = first sighting. Progress tracked via `[quiz-nudge YYYY-MM-DD tN]` stamp in Notes; max 1/day; cap 50/run.
- **To:** approved buyers who never took the qualify quiz · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `{firstName}, finish your quiz to lock in a rancher ({state})`
- **Body:**
> # Hey {firstName} —
> You started signing up for BuyHalfCow but haven't finished the 60-second quiz yet.
>
> The quiz tells me **which rancher in {state} fits you**, what cut breakdown to push, and when you'll get your beef. About a minute. No payment, no pressure.
>
> **[Finish my quiz →]** (`/qualify/{consumerId}?token=…`)
>
> Questions? Hit reply.
> — Ben · BuyHalfCow · _Connecting every household to a ranch they trust._

---

### abandoned-quiz-nudge · Touch 2 (reminder, +2d) — `app/api/cron/abandoned-quiz-nudge/route.ts:73`
- **Fires:** hourly. Same target; touch 2 fires ≥ 2 days after touch 1.
- **To:** same · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `Still time to get matched in {state}`
- **Body:**
> # Hey {firstName} —
> Circling back — your BuyHalfCow quiz is still open.
>
> Sixty seconds and I'll match you with a real {state} rancher and lock in your cut breakdown. No payment to take it — it just tells me what you actually want.
>
> **[Finish my quiz →]**
>
> Questions? Hit reply.
> — Ben · BuyHalfCow · _Connecting every household to a ranch they trust._

---

### abandoned-quiz-nudge · Touch 3 (scarcity, +4d) — `app/api/cron/abandoned-quiz-nudge/route.ts:78`
- **Fires:** hourly. Same target; touch 3 fires ≥ 4 days after touch 2.
- **To:** same · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `Your rancher spot in {state} is still open — for now`
- **Body:**
> # Hey {firstName} —
> Quick heads up, {firstName}.
>
> Spots with our {state} ranchers fill as families come through. Yours is still open, but I can't hold it without knowing what you're after. The 60-second quiz locks it in.
>
> **[Finish my quiz →]**
>
> Questions? Hit reply.
> — Ben · BuyHalfCow · _Connecting every household to a ranch they trust._

---

### abandoned-quiz-nudge · Touch 4 (last call, +7d) — `app/api/cron/abandoned-quiz-nudge/route.ts:83`
- **Fires:** hourly. Same target; touch 4 fires ≥ 7 days after touch 3. Final touch (drip exhausted after 4).
- **To:** same · **Reply-To:** default `inbox@replies.buyhalfcow.com`
- **Subject:** `Last call, {firstName} — should I close your file?`
- **Body:**
> # Hey {firstName} —
> This is my last note, {firstName} — I don't want to keep emailing if the timing's off.
>
> If you still want real beef from a {state} rancher, the quiz is right here and takes a minute. If not, no worries at all — just reply and I'll close it out.
>
> **[Finish my quiz →]**
>
> Questions? Hit reply.
> — Ben · BuyHalfCow · _Connecting every household to a ranch they trust._

---

### buyer-pulse · "Did your rancher reach out?" 3-button check-in — `app/api/cron/buyer-pulse/route.ts:137`
- **Fires:** daily. Referral `Status="Intro Sent"`, ≥ 5 days since intro (`Intro Sent At`/`Approved At`), `Buyer Pulse Sent At` empty (one pulse per intro), buyer not suppressed. Cap 25/run. (Also fires a parallel SMS to opted-in buyers.)
- **To:** buyers introduced 5+ days ago with no movement · **Reply-To:** tagged `ref-{referralId}@replies.buyhalfcow.com`
- **Subject:** `{firstName}, did {rancherName} reach out?`
- **Body:**
> # Quick check-in, {firstName}
> I introduced you to **{rancherName}** a few days ago. Just making sure they reached out — and if not, fixing it.
>
> One tap below:
>
> **[✅ YES — we're connecting]** (`/api/buyer-pulse?token=…` answer=connected)
> **[❌ NO — never heard from them]** (answer=ghosted)
> **[🤔 YES but stalled / questions]** (answer=stalled)
>
> If you tap "No," I'll personally fix it — find you a different rancher or get this one moving today. No pressure either way.
>
> — Benjamin
>
> BuyHalfCow · 1001 S. Main St. Ste 600, Kalispell, MT 59901
>
> _(Companion SMS: "hey {firstName} — quick check in. did {rancherName} text you yet? reply 1=yes 2=no 3=need help. reply STOP to opt out. — Ben")_

---

### qualified-no-action · Abandon-cart nudge — `app/api/cron/qualified-no-action/route.ts:43`
- **Fires:** every 30 min (skipped if `MATCHING_ENABLED=false`). `Qualified At` between 4h and 30min ago, Buyer Stage ≠ CLOSED/MATCHED, not suppressed, Notes has no `[no-action-nudge` stamp, AND an active `Intro Sent` referral exists (else skipped). Dedup: stamps `[no-action-nudge YYYY-MM-DD]` so fires at most once. (Also fires SMS to opted-in buyers.)
- **To:** qualified buyers matched today who haven't locked their slot · **Reply-To:** tagged `usr-{buyerId}@replies.buyhalfcow.com`
- **Subject:** `{firstName}, your match with {rancherName} is still open`
- **Body:**
> # Hey {firstName} —
> Saw you got matched with **{rancherName}** in {state} earlier today but haven't locked your slot yet. No pressure — wanted to make sure the link didn't get lost.
>
> **What happens if you don't act:** the slot sits open for someone else in your state. {rancherName}'s processing dates fill on a first-come basis.
>
> **If you have questions before deciding:** hit reply. I read every email and answer same-day.
>
> **[Open your match →]** (`/member`)
>
> — Benjamin, BuyHalfCow
>
> _(Companion SMS: "Hey {firstName} — your match with {rancherName} is still open. Lock your slot: {SITE_URL}/member — Ben @ BuyHalfCow (reply STOP to opt out)")_

---

### stuck-buyer-recovery — `app/api/cron/stuck-buyer-recovery/route.ts`
- **Fires:** daily. **Sends NO buyer email.** Retries `/api/matching/suggest` for buyers stuck at `Buyer Stage=READY` + `Ready to Buy=true` with no active referral (capacity may have freed / new rancher live). On match, `/api/matching/suggest` itself fires the intro emails (`sendBuyerIntroNotification` etc.) — but this route's only outbound message is a **Telegram digest to the operator** (`🔄 Stuck-buyer recovery …`), not an email to buyers. No verbatim buyer copy originates here.

---

### re-warm-cohort — `app/api/cron/re-warm-cohort/route.ts`
- **Fires:** daily 10:30am MT. **Sends NO email.** Reanimates buyers warmed 60+ days ago with no engagement by clearing `Warmup Sent At`/`Warmup Stage` so the rancher-launch-warmup cron re-picks them up later. Only outbound message is a **Telegram heads-up to the operator** (`♻️ Re-warm cohort …`). No buyer-facing copy here.

---

### reclassify-buyers — `app/api/cron/reclassify-buyers/route.ts`
- **Fires:** daily 04:00 UTC. **Sends NO email.** Recomputes each Consumer's `Routing Segment` (via `classifyBuyer`) and writes it back. It only sets the field that the email-sequences routing-segment branch reads the next morning. No email, no Telegram, no buyer copy.

---

## Coverage notes
- **Distinct buyer-facing emails extracted:** 24 (3 abandoned-app recovery + 1 MATCH_NOW rescue + 1 MATCH_NOW live buyer intro + 4 routing-segment nudges [NUDGE_TO_ENGAGE, WARM_LEAD, NO_BUDGET, STATE_WAITLIST] + 1 INCOMPLETE_PROFILE + 3 WAITING founder letters + 1 READY nudge + 1 MATCHED Day-4 + 1 CLOSED cuts + 1 CLOSED monthly + 1 CLOSED repeat-ask + 4 abandoned-quiz-nudge touches + 1 buyer-pulse + 1 qualified-no-action).
- **Rancher-facing emails in email-sequences (included, labeled):** 4 (1 MATCH_NOW promote-PA rancher intro + 3 agreement reminders D3/D7/D14).
- **No-email crons:** stuck-buyer-recovery, re-warm-cohort, reclassify-buyers (operator Telegram / field writes only).
- **Whole pipeline gate:** email-sequences emails are dormant unless `EMAIL_SEQUENCES_ENABLED=true` (paused 2026-06-09). The standalone crons (quiz-nudge, buyer-pulse, qualified-no-action) are live.
## Buyer sales · matching · transactional

> Verbatim extraction of every email fired from the 11 requested route/cron files. Where a route hands off to a `@/lib/email.ts` helper, the helper's actual HTML body is reproduced here too (helper name + `lib/email.ts:line` noted). `{placeholders}` mark interpolated values. Reply-To: BHC tags replies with a referral/record context (`_replyContext: { type: 'ref', recordId: <referralId> }`) which routes to `ref-<referralId>@replies.buyhalfcow.com` (inbound webhook); emails without it default to `ben@buyhalfcow.com`.

---

### Rancher Intro (auto-fire on match) — `app/api/matching/suggest/route.ts:1060`
- **Fires:** A buyer is matched to a rancher (auto-approve, every successful match). Sent to the matched rancher inline in the route.
- **To:** Rancher · **Reply-To:** tagged `ref-{referralId}` (`_replyContext: { type: 'ref', recordId: referral.id }`)
- **Subject:** `{subjectPrefix}BuyHalfCow Introduction: {buyerName} in {buyerState}` — where `subjectPrefix` = `🔥 READY TO BUY · ` when buyer's `Ready to Buy` is set, else empty.
- **Body:**
> New Qualified Buyer Lead
>
> Hi {rancherName},
>
> *{readyBanner — shown only if buyer is Ready-to-Buy:}* **READY TO BUY in 1–2 months.** Buyer just clicked YES on the Ready-to-Buy CTA. They're expecting your call within 24–48 hours.
>
> *{qualBlock — shown only if buyer cleared the quiz with score ≥75:}* ⭐ Qualified buyer — {qualScore}/100 · **Tier:** {qa.tier} · **Timing:** {qa.timing} · **Storage:** {storage label} · Buyer cleared the 4-question qualification quiz and acknowledged commitment to respond within 24 hours.
>
> A qualified buyer in your area just came through BuyHalfCow and has been connected to you:
>
> **Buyer:** {buyerName}
> **Email:** {buyerEmail}
> **Phone:** {buyerPhone} *(shown only if present)*
> **State:** {buyerState}
> **Order:** {orderType | "Not specified"}
> **Budget:** {budgetRange} *(shown only if present)*
> **Notes:** {notes} *(shown only if present)*
>
> Reach out within 24 hours to close the sale. Reply-all to keep me in the loop.
>
> *{actionsBlock — four one-click quick-action buttons, JWT-signed `${SITE}/api/rancher/quick-action?token=...&action=...`:}*
> [💬 In talks] [✓ Closed Won] [✗ Closed Lost] [⏭ Pass]
> One-click status updates — no login. Closed Won button asks for sale amount + auto-generates the 10% commission invoice via Stripe.
>
> — Benjamin, BuyHalfCow

---

### Buyer Intro ("Meet your rancher") — `app/api/matching/suggest/route.ts:1196` → helper `sendBuyerIntroNotification` `lib/email.ts:1132`
- **Fires:** Same match event as above; sent to the buyer right after the rancher intro. Suppressed only when caller passes `skipBuyerIntro` AND the matched rancher is `tier_v2`.
- **To:** Buyer · **Reply-To:** tagged `ref-{referralId}` (set when `referralId` present)
- **Subject:** `{readyPrefix}Meet your rancher — {rancherName}` — `readyPrefix` = `ready to buy — ` when buyer confirmed Ready-to-Buy, else empty.
- **Preheader:** `Meet your rancher match: {rancherName}`
- **Body:**
> *Progress header:* Step 4 of 5 · Connect — ✓ Apply · ✓ Qualify · ✓ Match · **Connect** · Stock
>
> Your Rancher Introduction
>
> Hi {firstName},
>
> *{readyBlock — only if Ready-to-Buy:}* **You confirmed you're ready to buy in the next 1–2 months.** {rancherName} has been notified and will reach out within 24–48 hours.
>
> I've personally vetted and matched you with **{rancherName}**. They know you're coming — here's what to do next.
>
> *{contactBlock — if rancher has a slug:}* **{rancherName}** [Contact {rancherName} →] (button → `/ranchers/{slug}/contact`)
> *{contactBlock — no slug:}* **{rancherName}** · Email: {rancherEmail} · Phone: {rancherPhone} (if present)
>
> *{pricingBlock — if any tier price configured:}* Current pricing from {rancherName}: table of [Quarter Cow / Half Cow / Whole Cow → $ {price} → {lbs} lbs]. **Next processing date:** {date} (if set). [View full ranch page →]
>
> *{reserveBlock + calBlock — order swaps depending on tier_v2 vs legacy}*
>
> **— Reserve block, tier_v2 (magic-link present):** RESERVE YOUR SHARE NOW — {rancherName} processes on a rolling cycle — your deposit puts you on the books for the next available slot. Spots fill first-come, first-served. [Reserve your share — secure deposit →] (button → magic-link verify → `/checkout/{referralId}/deposit`). **No deposit, no slot held.** Refundable until {rancherName} accepts your slot. Non-refundable after. Cold-chain guarantee + BHC mediation always apply.
>
> **— Reserve block, legacy (no magic-link, has pay links):** RESERVE YOUR SHARE NOW — {rancherName} processes on a rolling cycle — your deposit puts you on the books for the next available slot. Spots fill first-come, first-served. Tap any tier above to lock in your share. **No deposit, no slot held.** Refundable until {rancherName} accepts your slot. Non-refundable after.
>
> **— Cal block, Operator tier:** LOCK IN YOUR SHARE — 15 MIN WITH BEN — {rancherName} works with us under our Operator program — that means I (Ben, BuyHalfCow founder) personally walk every buyer through pricing, processing dates, cuts, and delivery. Pick a time and I'll have your slot reserved. [Book your 15-min call with Ben →]. Same beef. Same rancher. I just make sure both sides show up prepared.
>
> **— Cal block, rancher Cal slug set (non-Operator):** SCHEDULE A 15-MIN INTRO CALL — Pick a time that works for both of you. {rancherName} sets their availability — book a slot and they'll be expecting your call. No phone tag. [Book your 15-min call →] (→ `/book/{referralId}`). Ben (BuyHalfCow founder) is CC'd on every booking — we make sure both sides show up prepared.
>
> **What to discuss:**
> - What cuts are available and current pricing
> - Processing timeline and delivery options
> - Any questions about their operation
>
> They'll walk you through everything. No pressure, no rush — this is a direct relationship between you and your rancher.
>
> If you don't hear back within 48 hours, reply to this email and I'll follow up on my end.
>
> — Benjamin, Founder, BuyHalfCow
> [Unsubscribe]

---

### State Waitlist Letter — `app/api/matching/suggest/route.ts:1326` → helper `sendStateWaitlistLetter` `lib/email.ts:4541`
- **Fires:** No rancher matched (buyer in an uncovered state). Fired at signup-time match attempt, gated so it only sends once (`Routing Segment Send Count == 0`).
- **To:** Buyer · **Reply-To:** default (ben@)
- **Subject:** `scouting ranchers in {buyerState} — you're on the list`
- **Body:**
> We're scouting {buyerState}
>
> Hi {firstName},
>
> Thanks for signing up. Straight read: we don't have a verified rancher in {buyerState} yet. You're on the waitlist.
>
> I cold-email D2C ranchers in uncovered states every week. {buyerState} is on the list. When one signs the agreement + goes live, you're one of the first I match them to.
>
> I'll email when it happens. No spam in the meantime — just one short monthly note so you know the platform is still building.
>
> Thanks for being patient w/ a small platform doing it right.
>
> — Ben, BuyHalfCow
> *(standard email footer w/ unsubscribe)*

---

### Rancher Intro (manual admin approve) — `app/api/referrals/[id]/approve/route.ts:96`
- **Fires:** Admin clicks Approve on a Pending referral in `/admin` (PATCH, admin-auth gated). Sent inline to the rancher.
- **To:** Rancher · **Reply-To:** default (ben@); body instructs "Reply-all" · `templateName: sendReferralApprovedIntro`
- **Subject:** `BuyHalfCow Introduction: {buyerName} in {buyerState}`
- **Body:**
> New Qualified Buyer Lead
>
> Hi {rancherName},
>
> You have a new qualified buyer lead from BuyHalfCow:
>
> **Buyer:** {buyerName}
> **Email:** {buyerEmail}
> **Phone:** {buyerPhone}
> **Location:** {buyerState}
> **Order:** {orderType}
> **Budget:** {budgetRange}
> **Notes:** {buyerNotes} *(shown only if present)*
>
> Please reach out to them directly to discuss availability and pricing.
>
> **Reply-all to this email to keep me in the loop.**
>
> — Benjamin, BuyHalfCow
> Remember: 10% commission applies to sales made through BuyHalfCow referrals.

---

### Member Login — application still under review — `app/api/auth/member/login/route.ts:63`
- **Fires:** Buyer requests a login link but their Consumer `Status` is `pending` or blank (not yet approved). Privacy: API always returns the same generic success message regardless.
- **To:** Buyer (member applicant) · **Reply-To:** default (ben@)
- **Subject:** `Your BuyHalfCow application is still under review`
- **Body:**
> Still reviewing your application
>
> Hi {firstName | "there"},
>
> We got your request to log in, but your BuyHalfCow application is still under review. I personally review every application — you'll hear back within 24 hours with next steps.
>
> If it's urgent, just reply to this email.
>
> — Benjamin, Founder

---

### Member Login — magic link — `app/api/auth/member/login/route.ts:97` (via `sendMagicLink`, body passed inline from route)
- **Fires:** Buyer requests a login link and `Status` ∈ {approved, active, waitlisted}. 7-day JWT.
- **To:** Buyer (member) · **Reply-To:** default (ben@)
- **Subject:** `Your BuyHalfCow Login Link`
- **Body:**
> Your Login Link
>
> Hi {firstName | "there"},
>
> Click the button below to access your BuyHalfCow member dashboard:
>
> [Log In to Your Dashboard] (button → `{siteUrl}/member/verify?token={token}`)
>
> This link works for 7 days. If you didn't request this, you can ignore this email.
>
> BuyHalfCow

---

### Ready-to-Buy rancher alert — `app/api/member/ready-to-buy/route.ts:191`
- **Fires:** Logged-in buyer (already qualified + already has an active matched rancher) taps "Ready to buy this month" on their dashboard. Emails the matched rancher. (If the buyer had NO active referral, the route instead calls matching/suggest, which fires the standard Rancher Intro + Buyer Intro above, and this email is skipped.)
- **To:** Rancher · **Reply-To:** default (ben@); body says "Reply-all"
- **Subject:** `🔥 {firstName} is ready to buy — call this week`
- **Body:**
> Your buyer just flagged as ready to purchase
>
> Hi {rancherName},
>
> **{buyerName}** in {buyerState} — who I introduced you to earlier — just tapped "Ready to buy this month" on their BuyHalfCow dashboard.
>
> This is the clearest signal I can give you: they want to pull the trigger. If you can, call or email them this week before they cool off.
>
> *(highlight box:)* **{buyerName}** · 📧 {memberEmail} · 📞 {buyerPhone} (if present) · **Wants:** {buyerOrderType | "Not specified"} · {buyerBudget}
>
> Reply-all if you need me to help close, or mark this one as "Closed Won" in your [rancher dashboard] after the sale.
>
> — Benjamin, BuyHalfCow

---

### Order Request — rancher notification — `app/api/orders/request/route.ts:239`
- **Fires:** Buyer submits the inline order-request form on a rancher's landing page (`/ranchers/[slug]`). Rancher must be operational. Sent to the rancher.
- **To:** Rancher · **Reply-To:** tagged `ref-{referralId}` (`_replyContext: { type: 'ref', recordId: referral.id }`) — body says "Reply directly to this email"
- **Subject:** `New order request: {TIER_LABEL} — {buyerName}` *(TIER_LABEL ∈ Quarter Cow / Half Cow / Whole Cow)*
- **Body:**
> New order request — {TIER_LABEL}
>
> Hey {rancherFirstName | "there"},
>
> You just got an order request through your BuyHalfCow page.
>
> *(table:)*
> **Buyer** {buyerName}
> **Email** {buyerEmail}
> **Phone** {phone} *(shown only if present)*
> **State** {buyerState} · {zip} *(shown only if present)*
> **Wants** {TIER_LABEL}
>
> *{buyer note block — only if message present:}* BUYER NOTE — {message}
>
> **Reply directly to this email to reach {buyerName}** — your reply lands in their inbox. Confirm timing, processing date, and how you'd like to take payment.
>
> Tracked in BuyHalfCow as Referral `{referral.id}`. Ben gets a Telegram alert too.
>
> — Ben, Founder, BuyHalfCow

---

### Order Request — buyer confirmation — `app/api/orders/request/route.ts:272`
- **Fires:** Same order-request submission; confirmation sent to the buyer.
- **To:** Buyer · **Reply-To:** default (ben@)
- **Subject:** `Order request sent — {ranchName}`
- **Body:**
> You're connected with {ranchName}
>
> Hey {buyerFirstName | "there"},
>
> We sent your **{TIER_LABEL}** request to {rancherName} at {ranchName}. They typically reply within 48 hours to confirm timing, processing date, and payment details.
>
> If you don't hear back in 48 hours, reply to this email and Ben will personally chase it down.
>
> — Ben, Founder, BuyHalfCow
>
> BuyHalfCow · Kalispell, MT 59901

---

### Qualify — resend quiz link — `app/api/qualify/resend-link/route.ts:84`
- **Fires:** Buyer with an expired/stale qualify JWT submits the "resend my link" form (`/qualify/[id]` error UI). Looked up by email; skipped if Unsubscribed/Bounced. Privacy: API always returns `ok:true` (no enumeration). Fresh 24h qualify JWT minted.
- **To:** Buyer · **Reply-To:** default (ben@) · `templateName: sendQuizResendLink`
- **Subject:** `{firstName}, your fresh quiz link`
- **Body:**
> Hey {firstName} —
>
> Here's a fresh link to finish your 60-second qualification quiz for {state}:
>
> [Open quiz →] (button → `{SITE_URL}/qualify/{consumerId}?token={qualifyToken}`)
>
> Questions? Hit reply.
> — Ben
> BuyHalfCow
> *Connecting every household to a ranch they trust.*

---

### Cron: Awaiting-Payment nudge — `app/api/cron/awaiting-payment-nudge/route.ts`
- **Fires:** Daily. Finds referrals stuck `Awaiting Payment` >14 days (throttled 7d/referral).
- **NO EMAIL SENT.** This cron is **Telegram-only** — it sends an operator card to `TELEGRAM_ADMIN_CHAT_ID` (line 109), not an email to buyer or rancher. (Telegram text: "🕓 Awaiting Payment {n}d … Options: Rancher confirms payment via /rancher dashboard / Mark Closed Lost / Re-nudge rancher.") Included here for completeness; no buyer/rancher/admin email is generated.

---

### Cron chasup: Rancher Day-2 lead reminder — `app/api/cron/referral-chasup/route.ts:293` → helper `sendRancherLeadReminder` `lib/email.ts:3708`
- **Fires:** Referral stuck on `Intro Sent` ≥2 days (throttled 4d via `Rancher Reminded At`). Up to 10/run.
- **To:** Rancher · **Reply-To:** default (ben@); body asks to update status or reply "pass"
- **Subject:** `Reminder — {buyerName} is waiting ({daysSinceIntro}d since intro)`
- **Body:**
> Quick reminder
>
> Hi {firstName},
>
> {daysSinceIntro} days ago I introduced you to **{buyerName}** in {buyerState}. They're a verified buyer and they're waiting to hear from you.
>
> *(lead box:)*
> **Buyer:** {buyerName}
> **State:** {buyerState}
> **Phone:** {buyerPhone | "Email only"}
> **Email:** {buyerEmail}
> **Looking for:** {orderType | "Beef share"} · {budgetRange | "Budget TBD"}
>
> Reach out today if you can — buyers cool off fast. Even a quick "hey, here's what I have available" text or email keeps the deal alive.
>
> [Open Your Dashboard] (button → `{SITE_URL}/rancher`)
>
> If you've already reached out, log into your dashboard and update the status to **Rancher Contacted** so I stop nudging you.
>
> If you can't take this lead, just reply to this email with "pass" and I'll route them to another rancher.
>
> — Ben, BuyHalfCow

---

### Cron chasup: Rancher stale-prompt (1-click update) — `app/api/cron/referral-chasup/route.ts:547`
- **Fires:** Referral on `Intro Sent` with no activity ≥14 days (throttled 7d via `Last Chased At`, increments Chase Count). Up to 10/run. Inline email.
- **To:** Rancher · **Reply-To:** tagged `ref-{refId}` (`_replyContext: { type: 'ref', recordId: p.refId }`)
- **Subject:** `Quick check — {buyerName}: still working it?`
- **Body:**
> Hey {rancherName},
>
> It's been {daysSinceActivity} days since I saw activity on this lead. Want to give me a 1-click update?
>
> **Buyer:** {buyerName}
>
> *(four buttons → `{SITE_URL}/api/rancher/quick-action?token=...&action=...`):*
> [💬 In talks] [✓ Closed Won] [✗ Closed Lost] [⏭ Pass]
>
> If you're actively working this one, just click "💬 In talks" — it refreshes the lead in your dashboard. No login needed.
>
> — Ben

---

### Cron chasup: Buyer AI re-engagement (chase-up #1–#3) — `app/api/cron/referral-chasup/route.ts:675`
- **Fires:** Referral on `Intro Sent`/`Rancher Contacted` gone stale (5d window for Intro Sent, 14d for Rancher Contacted), buyer not unsub/bounced, rancher Active. Body paragraphs are AI-generated per-send via Claude (warm, 2-3 paragraphs); the surrounding shell is fixed. Max 3 chase-ups/referral, 25/run.
- **To:** Buyer · **Reply-To:** default (ben@); body asks to reply "YES"
- **Subject:** chase #1 → `Quick check-in — {rancherName} on BuyHalfCow` · final (#3) → `Last follow-up — {rancherName} on BuyHalfCow` · middle → `Following up — {rancherName} on BuyHalfCow`
- **Body (fixed shell; `{aiDraft}` is the model-generated body):**
> Hi {firstName},
>
> {aiDraft — AI-generated 2–3 paragraph re-engagement copy, signed "Benjamin from BuyHalfCow"; on the final follow-up the prompt instructs it to mention this is the last follow-up}
>
> *(highlight box:)* **Already bought from {rancherName}?** Just reply **"YES"** to this email and I'll close the loop on our end. Takes 5 seconds.
>
> You're receiving this because you signed up on BuyHalfCow. [Unsubscribe] (→ `{SITE_URL}/unsubscribe?email={buyerEmail}`)
>
> *AI draft prompt (system):* "You are Ben's AI business assistant for BuyHalfCow, a private beef brokerage. Write warm, direct emails that feel personal."
> *AI draft prompt (user):* "Draft a friendly, concise re-engagement email for a beef buyer who was introduced to a rancher {daysStale} days ago and we haven't heard back. This is follow-up #{chaseCount} of 3. 2-3 short paragraphs. Warm, not pushy. {if final: Mention this is your last follow-up.} Do NOT include a subject line — just the body paragraphs. Sign as Benjamin from BuyHalfCow. Buyer: {buyerName}, {buyerState} / Rancher introduced: {rancherName} / Order interest: {orderType | 'bulk beef'}, Budget: {budgetRange | 'not specified'}"

---

### Cron chasup: Repeat-purchase ("order again") — `app/api/cron/referral-chasup/route.ts:748` → helper `sendRepeatPurchaseEmail` `lib/email.ts:2965`
- **Fires:** Inside the chasup cron. Referral `Closed Won`, `Closed At` older than 250 days, not yet sent (`Repeat Outreach Sent` unset). 7-day member-login JWT minted.
- **To:** Buyer (past purchaser) · **Reply-To:** default (ben@)
- **Subject:** `Time for another half, {firstName}?`
- **Body:**
> Ready for Another Round?
>
> Hi {firstName},
>
> It's been about a month since you picked up beef from **{rancherName}**. If the freezer is running low, now's a great time to lock in another order.
>
> *(highlight box:)* **{rancherName}** is still taking buyers. Same quality, same rancher, no middleman markup.
>
> Log in to let us know you want to be matched again — we'll get you connected within 24 hours.
>
> [Order Again →] (button → `{loginUrl}` = `/member/verify?token={token}`)
>
> Not ready yet? No worries — you'll stay in our network and we'll check in again when the time is right.
>
> — Benjamin, Founder, BuyHalfCow
> [Unsubscribe]

---

### Cron: Testimonial ask — `app/api/cron/testimonial-collection/route.ts:134` → helper `sendTestimonialAsk` `lib/email.ts:4492`
- **Fires:** Daily. Referral `Closed Won` + `Sale Amount > 0`, `Closed At` between 7 and 90 days ago, never asked before (lifetime dedupe). Cap 5/run. 120-day review-submit JWT minted.
- **To:** Buyer · **Reply-To:** tagged `ref-{referralId}` (`_replyContext: { type: 'ref', recordId: data.referralId }`)
- **Subject:** `quick favor — one sentence about your {cut}?` *(cut = lowercased order type, e.g. "half")*
- **Body:**
> Quick favor, {firstName}.
>
> Hey {firstName} — Ben here, founder of BuyHalfCow.
>
> You got {cutPhrase} from {ranchName} a couple weeks back. How is it?  *(cutPhrase = "a half"/"a whole"/"a quarter" or "beef")*
>
> If you have 30 seconds, click below to leave a quick rating + one sentence. Real words, your voice. I'd like to share it on the site (first name + state only — no last name, no email).
>
> [Leave a quick review] (button → `{SITE_URL}/reviews/submit?token={reviewToken}`)
>
> Or just hit reply with one sentence — like:
>
> *"freezer's full, family's fed, talked to the rancher direct."*
>
> If you'd rather not, totally fine — no follow-up.
>
> Thanks for backing real ranchers.
>
> — Ben, BuyHalfCow

---

### Pay redirect — rancher notice (Connect / on-platform path) — `app/ranchers/[slug]/pay/[tier]/route.ts:93`
- **Fires:** Buyer clicks a tier "buy" link on a rancher page and the rancher is on Stripe Connect (`isRancherOnConnect`). Buyer is redirected to on-platform checkout (`/access?rancher={slug}`); rancher gets this notice.
- **To:** Rancher · **Reply-To:** default (ben@)
- **Subject:** `New buyer interest — {label} on BuyHalfCow` *(label ∈ Quarter Share / Half Share / Whole Share)*
- **Body:**
> New Buyer Interest
>
> Hi {rancherName},
>
> Someone just clicked to purchase a **{label}** through your BuyHalfCow page. They've been routed to BuyHalfCow's on-platform checkout (Stripe Connect commission flow) — you'll receive payment via your connected Stripe account once the order is confirmed.
>
> Keep an eye on your Stripe Connect dashboard for the incoming order.
>
> — Benjamin, BuyHalfCow

---

### Pay redirect — rancher notice (legacy Payment-Link path) — `app/ranchers/[slug]/pay/[tier]/route.ts:116`
- **Fires:** Same tier-click, but rancher is legacy (not Connect) AND has a payment link set. Buyer redirected to the rancher's external payment link (with UTMs); rancher gets this notice.
- **To:** Rancher · **Reply-To:** default (ben@)
- **Subject:** `New buyer interest — {label} on BuyHalfCow`
- **Body:**
> New Buyer Interest
>
> Hi {rancherName},
>
> Someone just clicked to purchase a **{label}** through your BuyHalfCow page. They've been redirected to your payment link.
>
> Keep an eye on your payment processor for the incoming order. If they don't complete payment, we'll follow up with them automatically.
>
> — Benjamin, BuyHalfCow

---

### Stripe Connect webhook — payout failed — `app/api/webhooks/stripe-connect/route.ts:670`
- **Fires:** `payout.failed` event on a rancher's connected account (bank rejected the BHC payout). Looked up by Connect account id.
- **To:** Rancher · **Reply-To:** default (ben@); body says "reply to this email + i'll help"
- **Subject:** `your stripe payout failed — quick fix needed`
- **Body:**
> hey {firstName} — heads up, your bank rejected your latest BuyHalfCow payout (${amount}).
>
> reason: {failureMessage}
>
> usually means a typo in your routing/account # or the account was closed. fix it in your [billing dashboard] (→ https://buyhalfcow.com/rancher/billing) or just reply to this email + i'll help.
>
> — Ben @ BuyHalfCow

---

### Stripe Connect webhook — deposit/payment confirmation
- **NO buyer/rancher confirmation email is sent from this file.** `app/api/webhooks/stripe-connect/route.ts` handles `payment_intent.succeeded` (buyer_deposit / final_invoice) by calling `settleBuyerDeposit` / `settleFinalInvoice` (`lib/stripeSettlement.ts`) and `charge.refunded` / `charge.dispute.*` / `account.application.deauthorized`. All buyer/rancher-facing notifications for these events are **Telegram-only** within this file (e.g. "↩️ Deposit refunded — PI …", "🚨 STRIPE DISPUTE …", "🏦 STRIPE CONNECT ACTIVE …", "🟢 {ranch} auto-went-live …"). Any deposit-paid confirmation email to the buyer/rancher (if one exists) is emitted downstream by the settlement library, not by this route. The only email this file sends directly is the **payout-failed** rancher email above.
# BHC Rancher Onboarding + Migration Email Audit

Verbatim copy of every email sent from the 9 audited files (drip-step bodies pulled from `lib/email.ts`). `{placeholders}` mark runtime interpolations. Reply-To "tag" = the `_replyContext` object passed to `sendEmail` (routes inbound replies into the Conversations table); "none" = no tag set.

---

## Rancher onboarding · migration

### Onboarding Package (Next Steps & Agreement) — `app/api/ranchers/[id]/send-onboarding/route.ts:179`
- **Fires:** On-demand. POST by admin/onboarding (cookie / `x-admin-password` / `x-internal-secret`) from the dashboard "Send Onboarding Docs" action after a rancher call. Sends once; stamps `Onboarding Status = Docs Sent` only after email succeeds.
- **To:** rancher · **Reply-To:** none (`sendEmail` called without `_replyContext`)
- **Subject:** `BuyHalfCow Partnership - Next Steps & Agreement`
- **Body:**
> # BuyHalfCow Partnership - Next Steps
>
> Hi {rancherName},
>
> *(if call context present)* Thanks for connecting with us! Here's everything you need to get started:
> *(otherwise)* We're excited to have you in the BuyHalfCow network! Here's everything you need to get started:
>
> *(if callSummary)* **Your Operation:** {callSummary}
> *(if confirmedCapacity)* **Capacity Confirmed:** {confirmedCapacity} orders/month
> *(if specialNotes)* **What Makes You A Great Fit:** {specialNotes}
>
> ## Next Steps
>
> ### 1. Review & Sign Commission Agreement
> - 10% commission on all verified referred sales
> - Buyers pay you directly — you control pricing
> - 24-month commission term from first referral
> - No upfront fees
>
> **[ REVIEW & SIGN AGREEMENT ]** → {signingLink}
> This link is valid for 30 days.
>
> ### 2. Review the Info Packet & Media Agreement
> - Rancher Info Packet covers the full process from verification to listing
> - Media Agreement covers content usage and marketing guidelines
> - We'll need: ranch photos, beef type details, pricing, certifications
>
> [Commission Agreement] → {SITE_URL}/docs/BHC_Commission_Agreement.docx
> [Media Agreement] → {SITE_URL}/docs/BHC_Media_Agreement.docx
> [Rancher Info Packet] → {SITE_URL}/docs/BHC_Rancher_Info_Packet.pdf
>
> ### 3. Verification
> After signing, you'll complete a quick verification on your dashboard. Just provide at least 2 of the following:
> - 2-3 customer references (name + contact info)
> - Google Reviews or Facebook Reviews link
> - Social media presence (Instagram, Facebook, etc.)
> - USDA processing facility name
> - Certifications (USDA, organic, grass-fed, etc.)
>
> No product samples needed — we verify through references and social proof.
>
> ### 4. Go Live
> - After signing, you'll be taken straight to your dashboard to set up your ranch page
> - Once verified, your profile goes live and you start receiving qualified buyer leads
> - We'll stay in close contact throughout the process
>
> **Questions?** Reply to this email or text me directly.
>
> Looking forward to working with you!
>
> — Benjamin, Founder
> BuyHalfCow

---

### Agreement Signed — Set Up Your Ranch Page — `app/api/ranchers/sign-agreement/route.ts:213`
- **Fires:** On-demand. POST when rancher submits the signature form at `/rancher/sign-agreement` (valid signing token + `signatureName` + `agreedToTerms`). Sent immediately after the agreement is recorded.
- **To:** rancher · **Reply-To:** none (no `_replyContext`); footer routes questions to `{ADMIN_EMAIL}` (default `admin@buyhalfcow.com`)
- **Subject:** `Agreement signed — set up your ranch page, {firstName}`
- **Body:**
> # Agreement Signed — You're Almost Live
>
> Hi {firstName},
>
> Great news — your Commission Agreement for **{ranchName}** is now signed and on file.
>
> **Two things to do right now:**
>
> ✅ **Agreement signed** — Done
> 🖥️ **Set up your ranch page** — Add your logo, tagline, about text, pricing, and payment links. This is what buyers will see.
> 🔍 **Start verification** — Submit verification signals on your dashboard (3+ signals = instant approval).
> 🟢 **Go live** — Once verified, your page goes live and buyers start coming in.
>
> **[ SET UP YOUR RANCH PAGE ]** → {dashboardLink}
> This link logs you in automatically. Valid for 7 days.
>
> **🔍 Verification — Here's How:**
> On your dashboard, fill in any of the following. **3 or more = instant auto-approve.** Fewer than 3 = we review within 24-48h.
> - 2-3 customer references (name + contact info)
> - Google Reviews or Facebook Reviews link
> - Social media presence (Instagram and/or Facebook)
> - USDA processing facility name
> - Certifications (USDA, organic, grass-fed, etc.)
> - Gallery photos of your operation
>
> Once verified, your page goes live and buyers route to you on the next 2-hourly approval cycle.
>
> **What to have ready for your page:**
> - Ranch logo or photo
> - A short tagline (one sentence)
> - Your "about" story — why buyers should trust you
> - Pricing for quarter, half, and/or whole
> - Payment link (Square, Stripe, PayPal, etc.)
>
> **The faster you set up your page and send a sample, the faster you're live and receiving buyer leads.**
>
> — Benjamin, Founder
> BuyHalfCow
> Questions? Email {ADMIN_EMAIL}

---

### Resend Signing Link — `app/api/ranchers/resend-agreement/route.ts:74`
- **Fires:** On-demand. POST to `/api/ranchers/resend-agreement` — rancher self-serve recovery (lookup by `{email}`, no login) or admin-initiated (`{rancherId}`). Skipped if already signed or no email on file.
- **To:** rancher · **Reply-To:** none (no `_replyContext`)
- **Subject:** `Your BuyHalfCow signing link (resent)`
- **Body:**
> # Here's a fresh signing link
>
> Hi {rancherName},
>
> As requested, a fresh 30-day link to review and sign your Commission Agreement. Your previous link may have expired, bounced, or been lost.
>
> **[ Review & Sign Agreement ]** → {signingLink}
> This link is valid for 30 days.
>
> Questions? Reply to this email.
>
> — Benjamin, BuyHalfCow

---

### V2 Upgrade Invite (legacy → tier_v2 migration) — `app/api/admin/ranchers/[id]/send-v2-upgrade/route.ts:167`
- **Fires:** On-demand. POST by admin/onboarding (or `x-internal-secret`) to migrate a live legacy rancher to platform-collected deposits. Refuses (409) if rancher already `tier_v2`. Stamps `Migration Status = invited` + a 14-day `Migration Deadline`. `templateName: 'sendV2UpgradeInvite'` (whitelisted past the 3/wk frequency cap).
- **To:** rancher · **Reply-To:** `{ type: 'rnc', recordId: {rancherId} }`
- **Subject:** `{firstName} — buyers can pay you direct now`
- **Body:**
> # {firstName}, buyers can pay you direct now
>
> Hey {firstName} — for a while I've wanted buyers to pay you directly through BuyHalfCow instead of you chasing invoices. I had to get the payment setup approved to move money on your behalf. That's done. So I'm turning it on for the ranchers actually moving beef — and {ranchName} is one of them.
>
> **What changes:**
> - **Buyers reserve their share with a deposit that lands in YOUR Stripe account same-day.** Money down means they show up — no ghosting.
> - **I run every buyer call + qualification.** You just fulfill the order.
> - **Same beef, same payout** — I collect the commission once, up front, instead of chasing it after the close.
>
> **Your options** (start small, upgrade anytime):
>
> | Plan | Detail |
> |---|---|
> | **Legacy Connect — keep your 10%, $0/mo** | Deposits + I run the calls. Most ranchers start here. |
> | **Pasture — $150/mo · 7%** | Listing, landing page, buyer matching. |
> | **Ranch — $350/mo · 3%** | + priority routing, quarterly copy rewrites, social features. |
> | **Operator — $500/mo · 0%** | + done-for-you marketing. Zero commission. |
>
> **Two ways to go:**
>
> **SET IT UP MYSELF (5 MIN)**
> Pick your plan, connect your bank, set your deposit — taking orders the same day. Have your business info + bank account handy.
> **[ Set it up myself → ]** → {setupUrl}
>
> **BOOK 15 MIN WITH ME**
> Questions, or want to do it together? Grab a slot and I'll set you up live on the call.
> **[ Book 15 min → ]** → {benMigrationCalUrl with Cal.com prefill (name, email, rancherId)}
>
> Hit reply with any questions — I read every email.
>
> — Ben, BuyHalfCow

---

### Resend Setup Wizard Link — `app/api/admin/ranchers/[id]/resend-setup/route.ts:92`
- **Fires:** On-demand. POST by admin/onboarding (or `x-internal-secret`) to re-send a rancher their setup-wizard link. Mints a fresh 60-day token; stamps `Docs Sent At` (date-only).
- **To:** rancher · **Reply-To:** `{ type: 'rnc', recordId: {rancherId} }`
- **Subject:** `{firstName}, your {ranchName} setup link`
- **Body:**
> # Hi {firstName} — let's get {ranchName} live
>
> Here's your setup link. It's a short wizard — confirms your info, signs the partner agreement, and gets your page online.
>
> Most folks finish in under 10 minutes.
>
> **[ Start Setup ]** → {setupUrl}
> This link is yours — valid for 60 days.
>
> **What's in the wizard:**
> - Confirm contact + service area
> - Add your tagline, about text, photos
> - Sign the partner agreement (10% commission, 24mo term, no upfront fees)
> - Set pricing for quarter / half / whole
> - Page goes live after verification (usually same-day)
>
> Questions? Just reply — I read every email.
>
> — Benjamin, BuyHalfCow

---

### Onboarding-Stuck Nudge (day3 / day7) — `app/api/cron/onboarding-stuck/route.ts:171`
- **Fires:** CRON, daily 16:00 UTC. Targets ranchers stuck in a bucket (`connect-stuck`, `signed-no-page`, `call-complete`, `docs-sent`) — sends at **day 3** and **day 7** since the bucket's anchor date. Throttled: won't re-send the same bucket within 4 days. Cap 25 sends/escalations per run. Skips unsubscribed. (**Day 14 sends NO email** — escalates to admin Telegram instead; see next entry.) `dayBucket` only changes one line: day3/day7 use the "5 minutes" line.
- **To:** rancher · **Reply-To:** `{ type: 'rnc', recordId: {rancher.id} }`
- **Subject:** `{firstName}, you're 1 step from live on BuyHalfCow`
- **Body:**
> # {firstName} — you're almost live
>
> You started your BuyHalfCow setup but haven't finished. We've got buyers in your area waiting.
>
> *(if any missing items)* **To go live, we still need:**
> {missing items — one or more of, by bucket:}
> - *(connect-stuck)* Finish connecting your bank with Stripe — about 5 minutes, then buyers can pay you
> - *(signed-no-page)* A URL slug (in My Page tab)
> - *(signed-no-page)* At least one price
> - *(signed-no-page, tier_v2)* Connect your bank with Stripe
> - *(signed-no-page, legacy)* At least one payment link (Square / Stripe / PayPal)
> - *(call-complete)* Sign the partner agreement (1 click in the setup wizard)
> - *(docs-sent)* Open your setup link and finish the wizard
>
> **[ Finish Setup ]** → {setupUrl}
>
> 5 minutes and you're live + receiving buyer leads.
>
> Questions? Reply to this email.
> — Benjamin, BuyHalfCow

---

### Onboarding-Stuck Nudge — Day 14 FINAL variant — `app/api/cron/onboarding-stuck/route.ts:171` (body builder `:58`)
- **Fires:** CRON, daily 16:00 UTC. NOTE: in code, day≥14 ranchers are **escalated to admin Telegram, not emailed** (`bucket === 'day14'` short-circuits before send). The `day14` urgency copy below exists in `emailHtml()` but is only reachable if the day-14 escalation branch is bypassed. Captured for completeness — same body as above except the closing urgency line:
- **To:** rancher · **Reply-To:** `{ type: 'rnc', recordId: {rancher.id} }`
- **Subject:** `{firstName}, you're 1 step from live on BuyHalfCow`
- **Body (urgency line only — rest identical to day3/day7 above):**
> **This is your final automated nudge.** If now isn't the right time, just reply STOP and we'll close your account cleanly.

---

### Self-Submit Drip — Day 2 — `app/api/cron/rancher-onboarding-drip/route.ts:109` → `lib/email.ts:4117` (`sendRancherOnboardingDripDay2`)
- **Fires:** CRON, runs daily, picks whoever's eligible. Sends when `Self-Submit Drip Stage = welcome-sent` AND ≥2 days since `Self-Submitted At`. Only self-submitted prospects (via `/map/add-a-rancher`). Stop conditions: Verified / opted-out / Paused / Non-Compliant / onboarding moved past pre-onboarding. CTA leads with the 5-min wizard (`setupUrl` minted per send); UTM-tagged.
- **To:** rancher · **Reply-To:** none (sent via `resend.emails.send` directly; List-Unsubscribe headers only)
- **Subject:** `Re: {ranchName} on the map`
- **Body:**
> Hey {first},
>
> {ranchName} is on the map but still a yellow pin — visible, but not getting routed customers. Meanwhile {families in {state} / families near you} are searching BuyHalfCow for a half or whole cow right now, and your pin can't take them until you're live.
>
> Flipping green is a 5-minute self-serve setup — logo, prices, done. No call unless you want one.
>
> *(if setupUrl present — primary path:)*
> **[ Set up your page → (5 min) ]** → {setupUrl}
> No call needed — or if you'd rather talk first, [grab 15 min with me] → {CALENDLY_LINK}
>
> *(if no setupUrl — fallback:)*
> **[ Grab a slot ]** → {CALENDLY_LINK}
>
> Reply with a phone number if email isn't your thing. I'll call you.
>
> — Ben

---

### Self-Submit Drip — Day 5 — `app/api/cron/rancher-onboarding-drip/route.ts:113` → `lib/email.ts:4161` (`sendRancherOnboardingDripDay5`)
- **Fires:** CRON, daily. Sends when `Self-Submit Drip Stage = day2-sent` AND ≥5 days since `Self-Submitted At`. Same stop conditions as Day 2.
- **To:** rancher · **Reply-To:** none (direct `resend.emails.send`; List-Unsubscribe headers only)
- **Subject:** `What we actually do for ranchers like you`
- **Body:**
> Hey {first},
>
> I haven't bombarded you with a sales deck because that's not what we do. Two-line version of what BuyHalfCow does for D2C ranchers:
> - **Public map + listing** — families searching for real beef in your county find you, not Walmart.
> - **Buyer matching** — we route pre-screened families with confirmed budgets and timing directly to ranchers we've vetted.
> - **Marketing services** — story-driven email, content, and outreach so families understand why your beef is worth $7/lb instead of $4/lb.
>
> You don't need a call to start — the 5-minute self-serve wizard gets {ranchName} live and routable today.
>
> *(if setupUrl present — primary path:)*
> **[ Set up {ranchName} → (5 min) ]** → {setupUrl}
> Rather talk it through first? [Book 15 min with me] → {CALENDLY_LINK}
>
> *(if no setupUrl — fallback:)*
> **[ Book the call ]** → {CALENDLY_LINK}
>
> — Ben
> Founder, BuyHalfCow

---

### Self-Submit Drip — Day 14 (last note) — `app/api/cron/rancher-onboarding-drip/route.ts:117` → `lib/email.ts:4206` (`sendRancherOnboardingDripDay14`)
- **Fires:** CRON, daily. Sends when `Self-Submit Drip Stage = day5-sent` AND ≥14 days since `Self-Submitted At`. Final drip email; next cycle flips stage to `completed` (drip stops). If still a Prospect after this, Ben gets a "call them" Telegram.
- **To:** rancher · **Reply-To:** none (direct `resend.emails.send`; List-Unsubscribe headers only)
- **Subject:** `Last note from me`
- **Body:**
> Hey {first},
>
> Last note from me unless I hear back — I don't want to be that guy who emails forever.
>
> {ranchName} stays on the map as a yellow pin either way. But yellow doesn't get routed buyers — green does, and green is a 5-minute setup away.
>
> *(if setupUrl present — primary path:)*
> **[ Set up in 5 min → ]** → {setupUrl}
> Or [grab a quick call] → {CALENDLY_LINK} if you'd rather.
>
> *(if no setupUrl — fallback:)*
> **[ Pick a slot ]** → {CALENDLY_LINK}
>
> If you want OFF the map, just reply "remove" and you're gone, same day.
>
> — Ben

---

### Migration Deadline Nudge (7d / 4d / 2d / 1d) — `app/api/cron/migration-deadline/route.ts:178` (builder `:64`)
- **Fires:** CRON, daily 15:00 UTC. For legacy ranchers with `Migration Status ∈ {invited, call_scheduled, upgrading}` (excludes `Active Status = Paused`). Fires a nudge email only when days-left-to-`Migration Deadline` is exactly **7, 4, 2, or 1**. (At ≤0 days: no email — auto-pauses the rancher + Telegram alert.) `templateName: 'sendMigrationNudge'`.
- **To:** rancher · **Reply-To:** `{ type: 'rnc', recordId: {rancherId} }`
- **Subject (≤1 day):** `{firstName} — {ranchName} payout upgrade deadline tomorrow`
- **Subject (>1 day):** `{firstName} — {daysLeft} days left to upgrade {ranchName} payouts`
- **Body:** (`{urgency}` = "tomorrow" if ≤1d, "in 2 days" if ≤2d, else "in {daysLeft} days")
> # {firstName}, {urgency} on the payout upgrade
>
> Quick reminder — you've got **{daysLeft} day(s)** left to switch {ranchName} to the new platform-collected deposit flow. After the deadline, the system pauses new lead routing to your page until you finish.
>
> **5-min DIY path:** open your wizard, pick tier, Stripe Connect, set deposits. Done.
>
> **[ Finish the upgrade → ]** → {setupUrl}
>
> **Want me to walk you through it on a 15-min call?**
> **[ Book your 15-min call → ]** → {bookUrl with Cal.com prefill (name, email, rancherId)}
>
> Reply to this email if you hit any snag — I'll respond same-day.
>
> — Benjamin, BuyHalfCow

---

### Monthly Compliance / Sales Report — `app/api/cron/compliance-reminders/route.ts:92`
- **Fires:** CRON, runs daily 09:00 UTC but **only acts on the 1st of the month** (UTC date-1 guard; other days are a no-op heartbeat). Targets `Active Status = Active` AND `Agreement Signed = true`. Skips: no email, unsubscribed/bounced/complained, `tier_v2` or mid-migration (`invited`/`call_scheduled`/`upgrading`), or reminded within last 25 days (dedup). After send, flips ranchers with ≥2 `Consecutive Missed Reports` to `Non-Compliant`.
- **To:** rancher · **Reply-To:** none (no `_replyContext`); reply-to-collect-sales is the entire mechanic
- **Subject:** `BuyHalfCow Monthly Sales Report - {month}` (e.g. "June 2026")
- **Body:**
> # Monthly Sales Report
>
> Hi {name},
>
> Please report any sales from BuyHalfCow referrals last month.
>
> Simply reply to this email with:
> - Number of sales completed
> - Total sale amount
> - Any buyer feedback
>
> If no sales were made through BuyHalfCow referrals, reply **"No sales"**.
>
> This helps us track commissions and improve the matching process.
>
> — Benjamin, BuyHalfCow
## Rancher lifecycle · followup · misc automated

### New-applicant gentle reminder (prospect nudge) — `app/api/cron/rancher-followup/route.ts:223`
- **Fires:** Daily (15 UTC). For a rancher with NO Onboarding Status set (just applied) who is ≥2 days old, not Paused/Non-Compliant, has an email, not Unsubscribed, and `Last Onboarding Nudge At` ≥2 days ago. Per-rancher 2-day throttle.
- **To:** Rancher (prospect) · **Reply-To:** `rnc` tag (`{ type: 'rnc', recordId: rancher.id }`)
- **Subject:** `{first}, {ranchName} is on the map — what's next?`
- **Body:**
> Hey {first},
>
> Just a quick check-in — **{ranchName}** has been on the BuyHalfCow map for a couple days now. Yellow pin, visible to buyers, but not yet routed customers.
>
> The fastest way to flip from "visible" to "getting leads" is a 15-minute call. I'll show you what we do, ask how you sell today, and we figure out together if it's a fit.
>
> **[Book the 15-min call]** ({calLink})
>
> If now isn't the right time, just reply and let me know. No pressure.
>
> — Ben
> Founder, BuyHalfCow

---

### Stale lead nudge to active rancher — `app/api/cron/rancher-followup/route.ts:346` (helper `lib/email.ts:2904` `sendRancherLeadNudge`)
- **Fires:** MONDAY ONLY (15 UTC). Rancher has ≥1 referral in `Intro Sent`/`Rancher Contacted` older than 5 days, with per-referral 7-day throttle (`Rancher Reminded At`). Leads grouped per rancher into one email.
- **To:** Rancher · **Reply-To:** default (`getUnsubscribeHeaders`; no tagged reply context)
- **Subject:** `You have {N} lead{s} waiting on an update`
- **Body:**
> # Your leads need a status update
>
> Hi {rancherName},
>
> You have **{N} lead{s}** that haven't been updated in over 5 days. A quick status update helps us keep buyers engaged and slots filled.
>
> | Buyer | Status | Last Updated |
> | --- | --- | --- |
> | {buyerName} | {status} | {daysSince}d ago |
> _(one row per lead)_
>
> Just log in and mark each lead as Closed Won, Closed Lost, or add a note if still in progress.
>
> **[Update My Leads →]** ({dashboardUrl} = `{SITE_URL}/rancher`)
>
> Questions? Just reply to this email.
>
> — Benjamin, Founder
> BuyHalfCow

---

### Rancher Reactivation — Tier A WARM — `app/api/cron/rancher-reactivation/route.ts:81` (helper `lib/email.ts:1500` `sendRancherReactivationWarm`)
- **Fires:** Daily weekday tick (16 UTC) ONLY when `RANCHER_REACTIVATION_ENABLED === 'true'` AND today ≥ `CAMPAIGN_START_DATE`. Tier A = dormant legacy ranchers (had some onboarding). First-touch capped at 8/day; also fires as the +5d reminder.
- **To:** Rancher · **Reply-To:** default (unsubscribe headers); body has explicit "Remove me" unsubscribe link
- **Subject:** `still want buyers from us, {first}?`
- **Body:**
> # Still want buyers from us?
>
> Hi {first},
>
> We're putting BuyHalfCow ranchers on direct deposits, and I'm running every buyer call myself now.
>
> To keep sending you buyers I need about 15 minutes to get {ranchName} set up on the new flow. Pick a time and I'll handle the rest.
>
> **[Book a 15-min call]** ({bookUrl})
>
> If you're not taking orders anymore, no problem — remove yourself below and I'll close it out.
>
> **[Remove me]** ({removeUrl})
>
> Reply to this email if you've got a question instead.
>
> — Ben
> BuyHalfCow

---

### Rancher Reactivation — Tier B COLD — `app/api/cron/rancher-reactivation/route.ts:88` (helper `lib/email.ts:1565` `sendRancherReactivationCold`)
- **Fires:** Same cron/gate as Tier A. Tier B = legacy ranchers listed but never onboarded (blank Onboarding Status). First-touch capped at 8/day; also fires as the +5d reminder.
- **To:** Rancher · **Reply-To:** default (unsubscribe headers); body has explicit "Remove me" unsubscribe link
- **Subject:** `closing your BuyHalfCow listing unless…`
- **Body:**
> # Closing your listing unless…
>
> Hi {first},
>
> {ranchName} is listed on BuyHalfCow but we never got you live. I'm cleaning up the roster.
>
> Want buyers? Book 15 minutes and I'll set you up on the new direct-deposit flow.
>
> **[Book a 15-min call]** ({bookUrl})
>
> Otherwise I'll close your listing — no hard feelings. You can remove yourself below.
>
> **[Remove me]** ({removeUrl})
>
> Reply to this email if you've got a question instead.
>
> — Ben
> BuyHalfCow

---

### Admin reassign → new rancher intro — `app/api/admin/referrals/[id]/reassign/route.ts:166`
- **Fires:** Admin POSTs a reassign of a referral to a different rancher. Inline `sendEmail` to the NEW rancher after capacity rebalance.
- **To:** Rancher (new assignee) · **Reply-To:** default (no `_replyContext` set)
- **Subject:** `BuyHalfCow Introduction: {buyerName} in {buyerState}`
- **Body:**
> # New Qualified Buyer Lead
>
> Hi {rancherName},
>
> You have a new qualified buyer lead from BuyHalfCow:
>
> **Buyer:** {buyerName}
> **Email:** {buyerEmail}
> **Phone:** {buyerPhone}
> **Location:** {buyerState}
> **Order:** {orderType}
> **Budget:** {budgetRange}
> **Notes:** {buyerNotes} _(only if notes present)_
>
> Please reach out to them directly to discuss availability and pricing.
>
> — Benjamin, BuyHalfCow · 10% commission applies to sales made through referrals.

---

### Resend intro → rancher copy — `app/api/admin/referrals/[id]/resend-intro/route.ts:58`
- **Fires:** Admin POSTs "resend intro" on a referral already in Intro Sent. Re-fires rancher intro (`templateName` pinned to `sendRancherIntroNotification` to bypass the 3/week cap).
- **To:** Rancher · **Reply-To:** default (no `_replyContext`)
- **Subject:** `[Resend] BuyHalfCow Introduction: {buyerName} in {buyerState}`
- **Body:**
> # Buyer Lead — Resent
>
> Hi {rancherName},
>
> Resending this introduction in case the first email got lost. Please reach out to them today:
>
> **Buyer:** {buyerName}
> **Email:** {buyerEmail}
> **Phone:** {buyerPhone}
> **Location:** {buyerState}
> **Order:** {orderType}
> **Budget:** {budgetRange}
> **Notes:** {buyerNotes} _(only if notes present)_
>
> — Benjamin, BuyHalfCow

---

### Resend intro → buyer copy — `app/api/admin/referrals/[id]/resend-intro/route.ts:112` (helper `lib/email.ts:1132` `sendBuyerIntroNotification`)
- **Fires:** Same resend-intro POST as above; also re-fires the buyer intro via `sendBuyerIntroNotification`. (This is the same template the matching flow uses for the first buyer intro.)
- **To:** Buyer · **Reply-To:** `ref` tag when `referralId` present (`{ type: 'ref', recordId: referralId }`); else default ben@<domain>
- **Subject:** `{readyPrefix}Meet your rancher — {rancherName}` — where `readyPrefix` = `ready to buy — ` when buyer is Ready-to-Buy, else empty
- **Body:** (progress bar + conditional pricing/reserve/Cal blocks; full verbatim)
> **Step 4 of 5 · Connect**
> [progress bar]
> ✓ Apply · ✓ Qualify · ✓ Match · **Connect** · Stock
>
> # Your Rancher Introduction
>
> Hi {firstName},
>
> _(readyBlock — only if readyToBuy:)_ **You confirmed you're ready to buy in the next 1–2 months.** {rancherName} has been notified and will reach out within 24–48 hours.
>
> I've personally vetted and matched you with **{rancherName}**. They know you're coming — here's what to do next.
>
> _(contactBlock — with rancherSlug:)_ **{rancherName}** · **[Contact {rancherName} →]** (`{SITE_URL}/ranchers/{slug}/contact`)
> _(contactBlock — without slug:)_ **{rancherName}** · Email: {rancherEmail} · Phone: {rancherPhone} (if present)
>
> _(pricingBlock — only if any tier price set:)_
> Current pricing from {rancherName}:
> | Quarter Cow | ${quarterPrice} | {quarterLbs} lbs |
> | Half Cow | ${halfPrice} | {halfLbs} lbs |
> | Whole Cow | ${wholePrice} | {wholeLbs} lbs |
> **Next processing date:** {nextProcessingDate} (if set)
> [View full ranch page →] (`{SITE_URL}/ranchers/{slug}`)
>
> _(reserveBlock — tier_v2 / magic-link variant:)_
> **RESERVE YOUR SHARE NOW**
> {rancherName} processes on a rolling cycle — your deposit puts you on the books for the next available slot. Spots fill first-come, first-served.
> **[Reserve your share — secure deposit →]** ({depositMagicLinkUrl})
> **No deposit, no slot held.**
> Refundable until {rancherName} accepts your slot. Non-refundable after. Cold-chain guarantee + BHC mediation always apply.
>
> _(reserveBlock — legacy pay-link variant:)_
> **RESERVE YOUR SHARE NOW**
> {rancherName} processes on a rolling cycle — your deposit puts you on the books for the next available slot. Spots fill first-come, first-served.
> Tap any tier above to lock in your share. **No deposit, no slot held.**
> Refundable until {rancherName} accepts your slot. Non-refundable after.
>
> _(calBlock — Operator-tier variant:)_
> **LOCK IN YOUR SHARE — 15 MIN WITH BEN**
> {rancherName} works with us under our Operator program — that means I (Ben, BuyHalfCow founder) personally walk every buyer through pricing, processing dates, cuts, and delivery. Pick a time and I'll have your slot reserved.
> **[Book your 15-min call with Ben →]** ({benSalesCalUrl}, prefilled name/email/referralId)
> Same beef. Same rancher. I just make sure both sides show up prepared.
>
> _(calBlock — rancher-slug variant:)_
> **SCHEDULE A 15-MIN INTRO CALL**
> Pick a time that works for both of you. {rancherName} sets their availability — book a slot and they'll be expecting your call. No phone tag.
> **[Book your 15-min call →]** (`{SITE_URL}/book/{referralId}`)
> Ben (BuyHalfCow founder) is CC'd on every booking — we make sure both sides show up prepared.
>
> **What to discuss:**
> - What cuts are available and current pricing
> - Processing timeline and delivery options
> - Any questions about their operation
>
> They'll walk you through everything. No pressure, no rush — this is a direct relationship between you and your rancher.
>
> If you don't hear back within 48 hours, reply to this email and I'll follow up on my end.
>
> — Benjamin, Founder
> BuyHalfCow
> [Unsubscribe] ({unsubscribeUrl})

---

### Rancher accepts lead → buyer "slot locked" — `app/api/rancher/referrals/[id]/accept/route.ts:170` (builder at `:36`)
- **Fires:** Rancher clicks Accept on a referral with a paid deposit (or Status=Awaiting Payment). Stamps Rancher Accepted At, flips to Slot Locked, emails the buyer. (Also fires `slot_locked` SMS if ENABLE_SMS + opt-in, and a Telegram op alert — not email.)
- **To:** Buyer · **Reply-To:** `ref` tag (`{ type: 'ref', recordId: id }`); `templateName: 'sendBuyerSlotLocked'`
- **Subject:** `{first} — {rancherName} accepted your slot`
- **Body:**
> Slot locked in.
>
> Hey {first} — **{rancherName}**{ at {ranchName} — if ranchName set} just accepted your deposit and committed your processing slot.
>
> **WHAT THIS MEANS**
> Your deposit is now non-refundable. {rancherName} has set aside cuts of meat for you and put your processing slot on their calendar. The BHC cold-chain guarantee + dispute mediation still apply.
>
> **Next steps:**
> - {rancherName} will reach out within 24h to confirm pickup/delivery details
> - You'll get a fulfillment confirmation email when your beef is ready
> - Final invoice (balance due) gets sent when processing completes
>
> Accepted {dateStr} · Questions? Reply here. — Benjamin, BuyHalfCow

---

### Resend warmup (YES-button) — `app/api/admin/consumers/[id]/resend-warmup/route.ts:91`
- **Fires:** Admin (or internal-secret caller) POSTs resend-warmup for a consumer not unsubscribed and not already engaged. Mints a `warmup-engage` JWT server-side (60d) and sends the YES-to-buy email.
- **To:** Buyer (consumer) · **Reply-To:** `usr` tag (`{ type: 'usr', recordId: id }`)
- **Subject:** `{firstName}, we've got a rancher in {state} now` — OR (no state) `{firstName}, ready to buy?`
- **Body:** ({stateLabel} = state, or "your state")
> # hey {firstName} —
>
> quick update: we now have a verified rancher serving {stateLabel}, and you're one of the first I'm letting know.
>
> back when you signed up, we didn't have anyone in your area yet. that's changed.
>
> **One question:** are you ready to buy in the next 1–2 months?
>
> if yes, click below. I'll personally match you with the rancher serving {stateLabel} and they'll reach out within 24–48 hours with pricing, processing dates, and how to lock in your order.
>
> **[Yes — Ready to Buy]** ({engageUrl} = `{SITE_URL}/api/warmup/engage?token=...`)
> one click confirms. we only introduce ranchers to confirmed buyers.
>
> not ready yet? just don't click. you stay on the list, no pressure.
>
> — Benjamin, BuyHalfCow

---

### Cal reminder (1 hour before call) — `app/api/cron/cal-reminder-1h/route.ts:123` (builder at `:40`)
- **Fires:** Every 10 min. Referrals with `Sales Call Start At` in the [now+55m, now+70m] window and `Sales Call Completed At` blank, deduped via `[cal-reminder-1h]` Notes stamp. Email always; SMS (`cal_reminder`) gated by ENABLE_SMS + opt-in.
- **To:** Buyer (attendee) · **Reply-To:** default; `templateName: 'sendCalReminder1h'`
- **Subject:** `{first}, our call starts in 1 hour`
- **Body:** ({when} = formatted local time, or "soon")
> # Hey {first} —
>
> Quick reminder: our call starts at **{when}**. About an hour from now.
>
> _(only if calLink — currently never set:)_ Join link: {calLink}
>
> I'll walk you through the rancher match, processing timeline, and what locking your slot looks like. Bring questions — that's the whole point.
>
> Need to reschedule? Reply to this email.
> — Ben
> BuyHalfCow
> _Connecting every household to a ranch they trust._

---

### Rancher launch warmup (buyer) — `app/api/cron/rancher-launch-warmup/route.ts:215` & `:345`; also fired immediately via `lib/triggerLaunchWarmup.ts` (helper `lib/email.ts:3631` `sendRancherLaunchWarmup`)
- **Fires:** Daily 14 UTC (and fire-and-forget right when a rancher goes live, via `triggerLaunchWarmup`). Phase 1 — for each operational rancher, warms Waitlisted/WAITING/READY buyers in that rancher's served states (Trust-Mode full drain OR throttled daily batch). Per-buyer `Warmup Sent At` dedup; per-rancher 24h cooldown; caps 100 warmups/run.
- **To:** Buyer · **Reply-To:** default (unsubscribe headers); `templateName: 'sendRancherLaunchWarmup'`
- **Subject:** `{ranchName} just went live in {buyerState} — ready to buy?`
- **Body:**
> # Good news — we found you a rancher
>
> Hi {first},
>
> When you signed up for BuyHalfCow, there wasn't a verified rancher in {buyerState} yet. That just changed.
>
> **{ranchName}** just passed our verification and is opening their first round of buyers this week. Since you've been waiting, I want to introduce you first.
>
> **One question first:** Are you looking to buy in the next 1–2 months?
>
> If yes, click below — I'll send the rancher's full info (pricing, processing date, contact) right after, and they'll reach out to you directly within 24–48 hours.
>
> **[Yes — Ready to Buy]** ({engageUrl})
> Clicking confirms you're ready to purchase in the next 1–2 months. Only confirmed buyers are introduced — keeps quality high for ranchers.
>
> Not ready yet? Just don't click — you stay on the list and we'll check back when timing fits. No pressure, no hard feelings.
>
> — Ben
> BuyHalfCow

---

### Rancher launch warmup — Day-7 nudge (buyer) — `app/api/cron/rancher-launch-warmup/route.ts:454` (helper `lib/email.ts:3670` `sendRancherLaunchWarmupNudge`)
- **Fires:** Same cron, Phase 2. Waitlisted buyers warmed ≥7 days ago who haven't engaged (Warmup Engaged At blank) and aren't already nudged/matched/dropped. Cap 50 nudges/run. {ranchName} resolved from a live rancher in the buyer's state (fallback "our new rancher").
- **To:** Buyer · **Reply-To:** default (unsubscribe headers); `templateName: 'sendRancherLaunchWarmupNudge'`
- **Subject:** `Last call — {ranchName} still has slots`
- **Body:**
> # Quick follow-up
>
> Hi {first},
>
> I sent you a note last week about **{ranchName}** opening spots. Didn't hear back, so this is my last nudge.
>
> **Are you ready to buy in the next 1–2 months?** If yes, tap below and I'll send the rancher's info right after. Otherwise I'll drop you off the active list — you won't get more about this rancher until you tell me to.
>
> **[Yes — Ready to Buy]** ({engageUrl})
>
> — Ben
> BuyHalfCow

---

### Backer monthly founder letter — `app/api/cron/backer-monthly-letter/route.ts:102` (helper `lib/email.ts:2257` `sendBackerMonthlyLetter`)
- **Fires:** 1st of each month, 14 UTC. Every consumer with `Founder Tier` set, not suppressed, not already sent this calendar month (`Backer Letter Sent At` per-month idempotency). Cap 200/run.
- **To:** Backer (founder) · **Reply-To:** default (unsubscribe headers)
- **Subject:** `bhc {monthLabel} — founder letter` (e.g. `bhc june 2026 — founder letter`)
- **Body:** ({numberLine} = `founder #{N} —` when founderNumber set)
> hey {first} —
>
> monthly letter from the road. {numberLine} this is the part i committed to when you backed bhc — no skipping a month, no PR fluff. just where we are.
>
> # this month
>
> **{closedThisMonth}** deal(s) closed · **{newRanchers}** new rancher(s) live _(the "new ranchers" clause only shows when > 0)_
>
> cumulative across the network: **{ranchers}** ranchers, **{buyers}** buyers, **{states}** state(s) active. every count above is a real row in airtable — i don't round up.
>
> _(only if f100 > 0:)_ founding 100: **{f100}/100** claimed. when this fills, the wall closes and the next tier opens.
>
> # what's next
>
> the rebuild keeps going. if you have a rancher you want me to chase, a state you think we should open, or just want to talk — reply to this email and it lands directly with me.
>
> _we're gonna take back american ranching and agriculture. one family, one rancher, one freezer at a time._
>
> — ben
>
> {BUSINESS_ADDRESS}
> [unsubscribe] ({unsubscribeUrl})

---

### Monthly commission invoice (rancher) — `app/api/cron/commission-invoices/route.ts:155` (helper `lib/email.ts:3537` `sendMonthlyCommissionInvoice`)
- **Fires:** 1st of each month, 16 UTC. Ranchers with unpaid Closed Won referrals. tier_v2 ranchers are SKIPPED (commission already taken at deposit). Per-month dedup via Email Sends lookup. Covers prior calendar month.
- **To:** Rancher · **Reply-To:** default (unsubscribe headers)
- **Subject:** `Commission Invoice — {monthYear} — BuyHalfCow`
- **Body:**
> # Commission Invoice
>
> Hi {operatorName},
>
> Here is your commission summary for **{monthYear}** from BuyHalfCow.
>
> **{ranchName}**
> Period: {monthYear}
>
> | Buyer | Order | Sale | Commission |
> | --- | --- | --- | --- |
> | {buyerName} | {orderType} | ${saleAmount} | ${commissionDue} |
> _(one row per sale; if no new sales this month, a single placeholder row "(No new sales this month)" / "—" / $0 / $0)_
>
> **This Month:** ${totalCommissionDue}
> **Total Unpaid Balance:** ${runningTotalUnpaid}
>
> **Payment Instructions**
> Please remit payment within 15 days. Easiest option:
>
> _(only if COMMISSION_PAYMENT_URL set:)_ **[Pay ${runningTotalUnpaid} Now]** ({COMMISSION_PAYMENT_URL}) · Secure card payment via Stripe · Or pay manually:
>
> - **Venmo:** @BuyHalfCow
> - **Zelle:** {ADMIN_EMAIL}
> - **Check:** Payable to BuyHalfCow — reply for mailing address
>
> Questions about this invoice? Reply to this email.
>
> — Benjamin, Founder
> BuyHalfCow
> [Unsubscribe] ({unsubscribeUrl})

---

### Land inquiry → seller — `app/api/land/[id]/inquire/route.ts:84`
- **Fires:** Anyone submits the public inquiry form on an Approved land listing (rate-limited 3/min, 10/hr per IP). Emails the seller.
- **To:** Seller · **Reply-To:** default (no `_replyContext`)
- **Subject:** `🏞 New inquiry on your {acreage}-acre listing`
- **Body:**
> # New Land Inquiry
>
> Hi {sellerName},
>
> Someone just inquired about your **{acreage}-acre {propertyType}** listing in {propertyLocation} via BuyHalfCow.
>
> **{name}**
> 📧 {email}
> 📞 {phone} _(only if phone given)_
>
> **Their message:**
> {message}
>
> Reply to them directly — we just made the introduction. If a sale closes, BuyHalfCow earns a 1% referral fee per the partnership terms.
>
> — Benjamin, BuyHalfCow

---

### Land inquiry → inquirer confirmation — `app/api/land/[id]/inquire/route.ts:110`
- **Fires:** Same inquiry POST; confirmation back to the person who inquired.
- **To:** Buyer (inquirer) · **Reply-To:** default (no `_replyContext`)
- **Subject:** `Your inquiry on {propertyLocation} — BuyHalfCow`
- **Body:**
> # Inquiry sent
>
> Hi {name},
>
> We forwarded your inquiry on the **{acreage}-acre {propertyType}** in {propertyLocation} (asking {askingPrice}) to {sellerName}. They typically respond within 1-3 business days.
>
> Want to see more listings or get notified when new ones go up? [Join the network →] (`{SITE_URL}/access`)
>
> — Benjamin, BuyHalfCow

---

### Inbound-reply AI auto-response — `lib/autoRespond.ts:36`
- **Fires:** Inbound buyer email classified as `ghost` or `scheduling` (conservative trigger) by the inbound webhook. Claude (haiku) drafts a short reply; sent back to the original sender. Skipped if draft is empty/<20 chars or classify fails.
- **To:** Buyer (original sender) · **Reply-To:** default (no `_replyContext`)
- **Subject:** `Re: {subject}` (truncated to 200 chars)
- **Body:** AI-generated (not a fixed template) — governed by this system prompt, output wrapped in `<p>{draft}</p>`:
> You are an AI assistant drafting a SHORT reply on behalf of Ben (the BuyHalfCow operator) to a buyer who emailed back. Tone: warm, concise, no marketing speak. Sign off "— Ben". One paragraph. No bullet lists. No "circle back". Acknowledge their message specifically. If they asked about scheduling: tell them the rancher will reach out within 48 hours. If they said they never heard from the rancher: apologize and say we are routing them to a backup rancher.

Representative output shape: one warm paragraph acknowledging their message, then `— Ben`. Scheduling → "the rancher will reach out within 48 hours"; never-heard-from-rancher → apology + "we are routing them to a backup rancher."

---

### Thread message mirror (buyer ↔ rancher) — `app/api/threads/[id]/message/route.ts:131`
- **Fires:** A buyer or rancher POSTs a message into a contract/deal thread (rate-limited 10/min per sender). Mirrors the message by email to the OTHER side, with a `thread-<id>@replies.<domain>` Reply-To so replies route back into the thread.
- **To:** The other party (rancher if sender=buyer; buyer if sender=rancher) · **Reply-To:** `thread` tag (`{ type: 'thread', recordId: id }`)
- **Subject:** `New message — {subjectPrefix}` (subjectPrefix = thread Subject, or "BuyHalfCow message")
- **Body:** ({senderLabel} = "a buyer" when sender is buyer; "your rancher" when sender is rancher)
> {senderLabel} just sent you a message:
>
> {messageBody}
>
> Reply to this email to respond. Your reply will land in the BuyHalfCow thread for both of you.
# BHC One-Off / Broadcast Email Script Inventory

> All scripts below are **MANUAL one-time sends** — run by hand from the CLI (dry-run by default, `--execute` to fire). They are **NOT** part of any automated cron sequence. Every script gates the actual send behind `--execute`; without it they only print a dry-run preview.

---

## Manual broadcast + reengagement scripts (run by hand, NOT automated)

### launch-broadcast.mjs — manual
- **Purpose:** One-time platform go-live blast to every approved Beef Buyer; state-aware copy (in-state rancher vs. no-rancher-yet). Scheduled via Resend `scheduled_at`.
- **To:** Approved Beef Buyers in NEW/WAITING/READY stage (excludes MATCHED/CLOSED + suppressed) · two variants by whether their state has a verified rancher
- **Subject (in-state):** `{first}, {state} just went live`
- **Subject (no-rancher):** `{first}, the network is live`
- **Body (in-state variant):**
> {first}, the network is live in {state}.
>
> Quick update — BuyHalfCow just went live. Public discover map. Verified ranchers. Direct routing. The whole stack.
>
> What that means for you: take the 90-second quiz and we'll match you to a verified rancher in {state} who's ready to take orders right now. Quarter, half, or whole. Real beef from a real ranch.
>
> [Take the 90-sec quiz] (→ {SITE_URL}/access)
>
> Or browse the map first:
> [See the map] (→ {SITE_URL}/map)  [See real deals] (→ {SITE_URL}/wins)
>
> If you want to back the build instead of (or alongside) buying beef, the Founding Herd just opened — five tiers, real backing, no equity, no theatrics. {SITE_URL}/founders
>
> *We're gonna take back American ranching and agriculture. One family, one rancher, one freezer at a time.*
>
> — Ben
> Founder, BuyHalfCow
>
> BuyHalfCow · Kalispell, MT 59901
> [Unsubscribe]

- **Body (no-rancher variant):**
> {first}, the network is live.
>
> Quick update — BuyHalfCow just went live. Public discover map. Verified ranchers across the country. Direct routing buyer-to-rancher. The whole thing.
>
> {state} doesn't have a verified rancher yet — but every week I'm onboarding new ones state by state. The moment one goes live in {state}, you're one of the first to hear and we'll route you direct.
>
> In the meantime, you can:
> [See the map] (→ {SITE_URL}/map)  [Flag a rancher in {state}] (→ {SITE_URL}/map/add-a-rancher)
>
> Know a direct-to-consumer rancher in {state}? Drop their info on the map at {SITE_URL}/map/add-a-rancher and we'll reach out to them directly. You help us close the gap, you get routed first when they go live.
>
> Want to back the build directly? The Founding Herd just opened — five tiers, real backing, no equity, no theatrics. {SITE_URL}/founders
>
> *We're gonna take back American ranching and agriculture. One family, one rancher, one freezer at a time.*
>
> — Ben
> Founder, BuyHalfCow
>
> BuyHalfCow · Kalispell, MT 59901
> [Unsubscribe]

---

### relaunch-broadcast.mjs — manual
- **Purpose:** Ship-day re-launch blast announcing the rebuilt customer experience to existing approved buyers; READY buyers get a one-click YES-to-match button, WAITING buyers get a founder letter.
- **To:** Approved buyers in READY or WAITING stage (excludes MATCHED/CLOSED + suppressed)
- **Subject (READY):** `{first}, {state} just got a rancher — ready to buy?`
- **Subject (WAITING):** `{first}, quick update on {state}`
- **Body (READY variant):**
> {first}, your state has a rancher.
>
> Quick update — I just rebuilt the entire BuyHalfCow customer experience. Cleaner, simpler, less spam, more direct connection between you and a verified rancher.
>
> The most important thing: **{state} now has a verified rancher in our network.** If you're ready to buy a quarter, half, or whole cow in the next 1–2 months, I'll match you with them today.
>
> **One question:** are you ready to buy in the next 1–2 months?
>
> [Yes — Ready to Buy] (→ {engageUrl} = /api/warmup/engage?token=…)
> One click. They'll reach out within 24–48 hours with pricing, processing date, and how to lock it in.
>
> Not ready yet? Just don't click. You stay on the list, no pressure.
>
> — Benjamin
> Founder, BuyHalfCow
>
> BuyHalfCow · 1001 S. Main St. Ste 600 · Kalispell, MT 59901
> [Unsubscribe]

- **Body (WAITING variant):**
> {first}, quick update from the road.
>
> I just rebuilt the entire BuyHalfCow customer experience. Cleaner, simpler, less spam, more direct connection between you and a verified rancher when one's ready in your area.
>
> {state} doesn't have a verified rancher yet — but I'm working on it. Every week I'm signing new ranchers state by state. The moment one goes live in your area, you'll be one of the first to hear.
>
> From now on, I'll send you a short note once a month — not marketing, just the real situation. What I'm seeing on the road, which states are about to launch, the actual numbers.
>
> Reply if you have questions or know a rancher in {state} I should reach out to.
>
> — Benjamin
> Founder, BuyHalfCow
>
> BuyHalfCow · 1001 S. Main St. Ste 600 · Kalispell, MT 59901
> [Unsubscribe]

---

### merch-mission-series-broadcast.mjs — manual
- **Purpose:** Three-email mission-driven merch series to every approved consumer (Day 0 sends now; Days +3 and +7 queued via Resend `scheduledAt` in the same run). All three queued at once so it can be audited before any send. (One manual run; the Day 3/7 scheduling is Resend-side, not a cron.)
- **To:** All Approved consumers (excludes suppressed, mid-purchase active referrals [Intro Sent / Rancher Contacted / Negotiation / Pending Approval], and Non-Responsive). Closed Won customers DO get it.
- **Subject (Email 1):** `quick story behind the hat`
- **Subject (Email 2):** `what the hat actually does`
- **Subject (Email 3):** `last note — the link`
- **Body (Email 1 — story):**
> Hi {firstName},
>
> When I started BuyHalfCow, the goal was bigger than helping you find a freezer of beef. The goal was to put a dent in how American families think about food — to swing them away from sterile grocery aisles and back toward the ranchers who've been doing it right for generations.
>
> One family at a time, one hat at a time.
>
> That's why the merch exists. Every cap, every shirt, every patch you wear is a quiet billboard for ranch-direct beef. A stranger in line at the coffee shop asks about the logo, and now another family knows there's a better way to feed their kids than ground chuck wrapped in plastic.
>
> The hat isn't the point. The conversation it starts is.
>
> Tomorrow I'll send you what wearing it actually does for the mission. For now — that's the why.
>
> — Benjamin
> BuyHalfCow · 1001 S. Main St. Ste 600, Kalispell, MT 59901
> [Unsubscribe]

- **Body (Email 2 — mission):**
> Hi {firstName},
>
> Here's what gets us closer to a country where every family knows their rancher:
>
> **People wearing it. Period.** We're rebuilding a supply chain that the industry spent 60 years dismantling. Demand has to outrun supply for ranchers to feel it's worth raising better cattle, processing locally, selling direct. Every family that converts away from grocery beef pulls the system one notch closer to where it should be.
>
> When you wear the cap, you're not buying merch. You're recruiting.
>
> Every conversation it starts:
> - Plants the idea that ranch-direct is an option
> - Sends another family to find their own rancher
> - Validates the work American ranchers are doing
> - Builds the demand signal that opens up new states
>
> One more email coming with the link. Wear it loud — that's the entire mission.
>
> — Benjamin
> [Unsubscribe]

- **Body (Email 3 — link):**
> Hi {firstName},
>
> Promised this is the last note. If you've been thinking about a cap or shirt:
>
> https://www.sackett-ranch.com/pages/buy-half-cow
>
> Not pushing — wearing it is a choice, not a requirement. But if you do, I'd love to hear about a conversation it starts. Reply with a story sometime.
>
> Either way, you're part of why this works.
>
> — Benjamin
> [Unsubscribe]

---

### rancher-pilot-pitch.mjs — manual
- **Purpose:** "Push is coming to shove" pilot-deal pitch to every unsigned rancher; two CTA buttons — PUSH ME LIVE (activate + queue warmup) / TAKE ME OFF THE LIST (suppress + reject). Conditional second paragraph based on whether docs were already sent.
- **To:** Unsigned ranchers (excludes Agreement Signed, suppressed, status=rejected, no email; manual skip list e.g. La Barronena)
- **Subject:** `softer pilot deal — first 4 sales free in {state}`
- **Body:**
> Hi {firstName},
>
> Quick note. I've been onboarding ranchers state-by-state for BuyHalfCow and you're one of the few I haven't gotten across the line yet. Wanted to give you a clean update + an even cleaner offer.
>
> *[if docs already sent]* Last we left it, the partnership agreement was already in your inbox. The two buttons below replace the agreement entirely — clicking **PUSH ME LIVE** counts as your signature on the new pilot terms (commission-free first 4, then white-glove). Cleaner than chasing the PDF.
> *[if docs NOT sent]* I'd been sitting on whether to send you the partnership agreement. Honestly the old terms (10% commission) were heavier than they needed to be, and you'd be right to drag your feet on it. So I'm skipping the PDF entirely — the two buttons below replace the agreement.
>
> **The new pilot deal — simpler than it was**
> **Sign on → first 4 closed deals are 100% commission-free.** You keep everything you sell.
> After deal #4, we transition you to **full white-glove marketing service**. Flat monthly retainer, we run your direct-to-consumer growth (lead gen, email, ads, content). No commissions, ever again. Either side can walk if it's not working.
>
> The 4 buyers will be real {state} families who've already raised their hand — not cold lists. We've been building a waitlist in your state and they're sitting there, waiting for a rancher.
>
> **Two buttons. Push is coming to shove.**
> [PUSH ME LIVE] (→ /api/rancher/activate?token=…)
> Click → you're activated, leads start routing within 24 hours, {state} buyers get warmed up.
>
> [Take me off the list] (→ /api/rancher/decline?token=…)
> No follow-up, no questions. I'll remove you cleanly.
>
> That's it. No PDF, no call required to start. If **PUSH ME LIVE** goes through, I'll text you within a few hours to walk through the rancher dashboard and answer anything live.
>
> If neither button feels right and you want to talk first — just hit reply.
>
> — Benjamin
> Founder, BuyHalfCow · {ADMIN_EMAIL}
>
> BuyHalfCow · 1001 S. Main St. Ste 600, Kalispell, MT 59901
> Sent to {email} ({ranchName}). The "Take me off the list" button suppresses you from all future operational + marketing email.

---

### reengage-covered-state-waitlist.mjs — manual
- **Purpose:** Re-engage buyers stuck on the waitlist while a rancher in their state is already operationally live (casualties of routing drift). YES click fires hot-lead matching bypass. Supports `--state=XX` filter.
- **To:** Approved + Waitlisted buyers whose state has a Live/Active/signed rancher (excludes suppressed, Non-Responsive, Closed Won, already-RTB, active referrals)
- **Subject:** `{firstName}, we just got a rancher live in {state}`
- **Body:**
> Hi {firstName},
>
> Quick update — when you signed up, we didn't have a verified rancher in {state} yet. That's changed.
>
> **{ranchName}** is now live and accepting buyers from your state. They've signed our agreement, are vetted, and ready to talk to you about a quarter, half, or whole cow.
>
> Are you still ready to buy in the next 1-2 months?
>
> [YES — connect me] (→ /api/warmup/engage?token=…)
>
> Click YES and we'll fire your intro to {ranchName} immediately. No clicking = stay on the network, we'll check in again next time something changes.
>
> — Benjamin
> BuyHalfCow · 1001 S. Main St. Ste 600, Kalispell, MT 59901
> [Unsubscribe]

---

### reengage-unsigned-ranchers.mjs — manual
- **Purpose:** Re-engage unsigned ranchers, segmented by where they stalled. Group A (Docs Sent, never signed) → fresh signing magic link. Group B (stale / no onboarding status) → self-serve setup-wizard magic link.
- **To:** Unsigned ranchers with valid email (excludes signed, Removed, Paused/Non-Compliant, suppressed)
- **Subject (Group A):** `{first}, picking back up on {ranchName}`
- **Subject (Group B):** `{first}, {ranchName} is on the map — finish setup?`
- **Body (Group A — signing nudge):**
> {first}, picking back up on {ranchName}.
>
> Quick note — we sent you the BuyHalfCow partner agreement a while back and I never saw it come through signed. No judgement, life gets in the way. I'm circling back because we just went live with the new platform and {ranchName} is on the public discover map already.
>
> If you're still in, the agreement is the only thing standing between you and routed buyers. Five minutes, one signature, your page goes live the moment you sign. Same 10% commission on closed deals. Non-exclusive. Pause routing whenever you want.
>
> [Sign the agreement] (→ /rancher/sign-agreement?token=…)
>
> Want to revise anything first? Reply to this email — it lands directly with me.
>
> If {ranchName} is no longer running or you're not interested, reply "remove" and I'll take you off the list — no fight.
>
> — Ben
> Founder, BuyHalfCow
>
> BuyHalfCow · Kalispell, MT 59901
> [Unsubscribe]

- **Body (Group B — setup wizard):**
> {first}, {ranchName} is on the map.
>
> Quick note — we already had our chat about {ranchName} joining BuyHalfCow. The build's now done: public discover map is live, self-serve setup wizard exists, and the partner agreement is signable inline.
>
> Since we already connected, your wizard skips the call step and takes you straight to: confirm contact → set your prices → sign agreement inline → page goes live. Five minutes.
>
> [Finish setup → go live] (→ /rancher/setup?token=…)
>
> Want a fresh call before signing? Book one any time at cal.com/ben-beauchman-1itnsg.
>
> If {ranchName} isn't operating direct-to-consumer anymore or you're not interested, you can click the link above and tap "Remove {ranchName} from BuyHalfCow" at the bottom of the wizard. Or reply "remove" and I'll take you off the list — no fight.
>
> — Ben
> Founder, BuyHalfCow
>
> BuyHalfCow · Kalispell, MT 59901
> [Unsubscribe]

---

### _reengage-closed-lost.mjs — manual
- **Purpose:** Re-engage ~753 unique auto-closed buyers (killed by a runaway cron). Served-state buyers get a one-click YES re-engagement email; unserved-state buyers get flipped to Waitlisted + WAITING (no email, caught later by waitlist blast).
- **To (email track):** Approved buyers with an auto-closed Closed Lost referral in a state that now has a Live rancher (excludes suppressed, MATCHED/CLOSED, rancher-passed closes, no email/state)
- **Subject:** `Quick — you still in?`
- **Body:**
> Hey {first},
>
> Earlier this year you raised your hand for half-cow matching. Things got noisy on our end — we rebuilt the platform, paused matching while we did it, and a lot of you got auto-closed by a cron job that shouldn't have run. That's on me.
>
> We're back. Verified ranchers shipping in your state. Quarter, half, whole. Direct from rancher to family, no middleman.
>
> **Still want to be matched?**
>
> [Yes, match me] (→ /api/warmup/engage?token=…)
> One click. We pick a verified rancher in your state and fire the intro within minutes.
>
> If you're not interested anymore, just ignore this — won't email again.
>
> — Ben
> Founder, BuyHalfCow
>
> BuyHalfCow · Kalispell, MT 59901
> [Unsubscribe]

---

### brimstone-launch.mjs — manual
- **Purpose:** Brimstone Beef (Matt Hirschi) flagship multi-state launch chain — run the moment Matt clicks PUSH ME LIVE. Overrides soft-pilot defaults to traditional 10%, auto-routes pre-existing hot leads, sends state-specific warmup blasts (AZ/NV/UT), posts a Telegram summary. Three distinct outbound emails below.
- **To:** Routable buyers in UT/AZ/NV (Approved, no active referral, not suppressed/Non-Responsive); plus the rancher (brimstonebeef@gmail.com) and each hot-lead buyer.
- **Subject (warmup, AZ):** `Arizona — your rancher just went live`
- **Subject (warmup, NV):** `Nevada — your rancher just went live`
- **Subject (warmup, UT):** `Brimstone Beef just went live in Utah — ready to buy?`
- **Subject (hot-lead → rancher):** `🔥 READY TO BUY · BuyHalfCow Lead: {buyerName} in {state} ({orderType})`
- **Subject (hot-lead → buyer):** `{firstName}, your {state} match — Brimstone Beef`
- **Body (AZ/NV flagship warmup):**
> {STATE} launch · first rancher
> {State} — your rancher just went live
>
> Hi {first},
>
> You signed up on BuyHalfCow hoping to find a rancher in {state}. We didn't have one. So we waited.
>
> **Brimstone Beef just went live as the first BuyHalfCow rancher serving {state}.**
> Run by Matt Hirschi — 4th-gen operation out of Utah, USDA-certified, ships AZ / UT / NV. Grass-fed Angus, 1,500-cow capacity per month. They want serious {stateAbbrev} buyers and they want them now.
>
> **One question:** are you ready to buy a quarter, half, or whole cow in the next 1–2 months?
>
> [Yes — Ready to Buy] (→ /api/warmup/engage?token=…)
> Click → I send Matt's full info (pricing, processing date, contact) right after. He reaches out within 24–48 hours.
>
> Not ready yet? Just don't click. You stay on the list, we'll check back when timing fits. No pressure.
>
> — Benjamin
> Founder, BuyHalfCow
>
> BuyHalfCow · 1001 S. Main St. Ste 600, Kalispell, MT 59901
> [Unsubscribe]

- **Body (UT standard warmup):**
> Brimstone Beef just went live in Utah
>
> Hi {first},
>
> When you signed up for BuyHalfCow, we were lining up local Utah ranchers. **Brimstone Beef** just passed verification and is open for buyers.
>
> Run by Matt Hirschi out of Randolph / Promontory / Collinston — 4th-generation Utah cattle operation, USDA-certified, grass-fed Angus. 1,500/mo capacity, so they have room for serious buyers.
>
> **One question:** are you looking to buy in the next 1–2 months?
>
> If yes, click below — I'll send Matt's pricing, processing date, and contact info right after. He'll reach out within 24–48 hours.
>
> [Yes — Ready to Buy] (→ /api/warmup/engage?token=…)
> Confirms you're ready in 1–2 months. Quality gate — only confirmed buyers get rancher intros.
>
> Not yet? Just don't click. You stay on the list, no pressure.
>
> — Benjamin
> BuyHalfCow · 1001 S. Main St. Ste 600, Kalispell, MT 59901
> [Unsubscribe]

- **Body (hot-lead notice → rancher / Matt):**
> Hot lead from your launch — {state}
>
> **READY TO BUY in 1–2 months.** This buyer was on the {state} waitlist and already raised their hand before you went live. They're expecting your call within 24–48 hours.
>
> Hi Matt,
>
> Buyer: {buyerName}
> Email: {buyerEmail}
> Phone: {buyerPhone}
> State: {state}
> Order: {orderType}
> Budget: {budget}
> Notes: {notes}
>
> They've been told to expect your outreach. Reply-all to keep me looped in.
>
> — Benjamin, BuyHalfCow

- **Body (hot-lead match → buyer):**
> Hi {firstName},
>
> You'd been on the {state} waitlist after telling us you're ready to buy. We just got a rancher live who serves {state}:
>
> **Brimstone Beef** · Matt Hirschi
> 4th-generation Utah ranch · USDA-certified · grass-fed Angus · ships AZ/UT/NV
> 📧 brimstonebeef@gmail.com
>
> Matt will reach out within 24–48 hours. Or feel free to email him direct.
>
> Thanks for hanging in.
>
> — Benjamin
> Founder, BuyHalfCow
>
> BuyHalfCow · 1001 S. Main St. Ste 600, Kalispell, MT 59901
> [Unsubscribe]

---

### brimstone-course-correct.mjs — manual
- **Purpose:** Single course-correction email to Matt Hirschi (Brimstone Beef) — re-frames the earlier soft-pilot pitch as a traditional 10% flagship deal before he clicks anything. Same PUSH ME LIVE / TAKE ME OFF buttons. Aborts if already signed.
- **To:** Matt Hirschi · brimstonebeef@gmail.com (cc: admin)
- **Subject:** `{firstName} — different deal for Brimstone (re: my email an hour ago)`
- **Body:**
> Hi {firstName},
>
> Quick heads up — the email I sent earlier tonight pitched a soft 4-close commission-free pilot. That's our default for smaller-capacity ranchers. Looking at Brimstone's scale (1,500/mo, USDA, 3-state shipping), I want to run this differently with you.
>
> **The real deal for Brimstone**
> **Traditional partnership — 10% commission, full transparency, no pilot terms.**
> We treat you as a flagship from day 1. Why? You've got the volume. We've got the buyers. Here's what's already lined up in your shipping radius:
>
> 51 Arizona · 17 Utah · 20 Nevada
> **88 routable buyers — 11 of them already clicked "ready to buy in 1-2 months."**
>
> You'd be the **first BuyHalfCow rancher in Arizona AND Nevada.** Both pipelines have been waiting for someone to ship to them. Today they get you.
>
> **What happens the moment you click PUSH ME LIVE**
> 1. **All 88 buyers re-engaged within minutes** — emails go out from us reintroducing them to Brimstone Beef. Custom Arizona/Nevada launch copy emphasizing you're the first.
> 2. **The 11 hot ones get routed to your inbox the same hour.** Each email tagged 🔥 READY TO BUY — they expect a call within 24-48h.
> 3. **Your landing page goes live** at buyhalfcow.com/ranchers/brimstone-beef. You'll set up your photos, pricing, and story through the rancher dashboard at your own pace — there's no rush. We'll route leads with what we have today.
> 4. **I personally track every metric for the next 60 days** — first-close cycle time, conversion rate, total revenue. I'm building this into a case study with you as the centerpiece. If we hit the numbers I think we'll hit, you'll be the rancher I show every other ranch operator I onboard from here on out.
>
> **Two buttons. Same as before, real this time.**
> [PUSH ME LIVE] (→ /api/rancher/activate?token=…)
> Click → I activate your record on flagship terms within 60 seconds, then the launch chain fires for UT / AZ / NV.
>
> [Take me off the list] (→ /api/rancher/decline?token=…)
> No follow-up, no questions. I'll remove you cleanly.
>
> If you'd rather get on a call before clicking — totally fair. Just reply and we'll set 15 min this week.
>
> — Benjamin
> Founder, BuyHalfCow · {ADMIN_EMAIL} · 8(redacted)
>
> BuyHalfCow · 1001 S. Main St. Ste 600, Kalispell, MT 59901
> Sent to brimstonebeef@gmail.com · Replaces my earlier email. The "Take me off" button suppresses you from all future operational + marketing email.

---

### homestead-pilot-welcome.mjs — manual
- **Purpose:** Pilot-welcome / onboarding email to All Natural Homestead Beef (Joseph & Jamie Hewitson) — activates them in CO as the default for Quarter shares, explains pilot terms (5 commission-free closes → $500/mo retainer), provides a 30-day dashboard magic link.
- **To:** Joseph & Jamie · homesteadbeeforders@gmail.com (cc: admin) — operational, no unsubscribe
- **Subject:** `you're live in CO — here's what happens next`
- **Body:**
> Hi Joseph & Jamie,
>
> Quick note — you're officially live on BuyHalfCow as of today. Your ranch is the active CO partner alongside High Lonesome, with one important difference: you're the default for **Quarter shares**. High Lonesome doesn't do quarters, so every Quarter buyer in Colorado now routes to you.
>
> **The pilot deal (locked in)**
> **First 5 Closed Won deals → $0 commission.** Sale comes in, you keep 100%. That's the entire offer for the trial.
> After deal #5, we move to a flat **$500/month marketing retainer** — commission goes away permanently. Either side can walk if it's not working.
>
> Goal of the trial: prove the lead flow is real and you can close it. That's it. No commission games, no fine print.
>
> **What gets routed to you, automatically**
> - Every **Quarter** buyer in CO (HL doesn't do them — these are yours by default)
> - Half + Whole buyers in CO when High Lonesome is at capacity or has passed on the lead
> - 5 buyers I'm hand-routing to you today as the first batch — most are Quarter buyers HL was sitting on. Watch your inbox over the next hour.
>
> Each match emails you the buyer's name, phone, email, share size, and budget. **Reply within 24 hours** — that's the whole game. After 14 days of no contact the lead auto-reroutes.
>
> **Your dashboard**
> Use this to see leads, mark deals Closed Won / Closed Lost, and pause routing if you go on vacation:
> [Open Homestead dashboard] (→ /rancher/verify?token=…)
> Link is good for 30 days. After that, log in at {SITE_URL}/rancher/login with this same email — we'll send a fresh link.
>
> **Two quick things to do this week**
> 1. **Set your Quarter / Half / Whole pricing** in the dashboard so it shows on your public page (homestead-beef). Right now buyers see no prices, which kills conversion.
> 2. **Add 2-3 photos** of the ranch + cattle. Same dashboard. Buyers click through to your page before they reach out — photos matter.
>
> **How I track responses**
> When a buyer reaches out and you reply, mark the lead "Rancher Contacted" in the dashboard. When the deal closes, mark "Closed Won" and enter the sale amount. That's how I know you hit deal #5 and trigger the retainer conversation. (No CRM gymnastics — three clicks per lead.)
>
> Reach out anytime. Reply to this email or text me direct.
>
> — Benjamin
> Founder, BuyHalfCow
>
> BuyHalfCow · 1001 S. Main St. Ste 600, Kalispell, MT 59901
> Sent to homesteadbeeforders@gmail.com · Operational email (no unsubscribe — partner communications).

---

### _send-rancher-review-digest.mjs — manual
- **Purpose:** Per-rancher "admin clean-up" digest after a bad batch of unfiltered leads got pushed. Lists each lead admin auto-touched today (STALE-REVERT / REROUTE / CLEANUP), each with 4 JWT quick-action buttons (In Talks / Won / Lost / Pass) so the rancher self-corrects without logging in.
- **To:** Each affected rancher (grouped from today's auto-closed referrals; skips paused/removed/no-email)
- **Subject:** `Quick admin: {n} leads need your read (1 click each)`
- **Body:**
> Hey {rancherFirst}, quick admin clean-up.
>
> Heads up — we had a backend hiccup earlier today and a wave of leads got pushed to your inbox without my usual filtering. Some of those buyers may have actually been good fits, others probably weren't ready. I closed the unverified ones on my end so we'd stop spamming you.
>
> **Here are the {n} leads where we need your read.** Tap one button per lead so the system reflects reality:
>
> **💬 In Talks** — you've reached out and they're engaged. Keeps the lead active.
> **✓ Closed Won** — you closed the sale (any time recently). Asks for sale amount, auto-generates the 10% commission invoice.
> **✗ Lost** — they're out (price/timing/etc). One-click close.
> **⏭ Pass** — you never contacted them or they're not a fit. Releases the lead so we can route it elsewhere.
>
> *[per-lead rows: buyer name (state), order type · budget, email · phone, optional note, + the 4 action buttons]*
>
> No action needed for leads that are already correct. Buttons are signed links — no login.
>
> — Ben
> BuyHalfCow · Kalispell, MT 59901

---

### _send-bulletproof-recovery-digest.mjs — manual
- **Purpose:** Recovery digest for the ~70 leads auto-killed by the pre-fix referral-chasup cron (May 5–11). Each affected rancher gets one apology email listing their lost leads, each with 4 JWT quick-action buttons (Still in talks / Closed Won / Truly lost / Pass).
- **To:** Each affected rancher (grouped from Closed Lost referrals marked AUTO-REASSIGNED; skips paused/removed/no-email)
- **Subject:** `My bad — {n} of your leads got auto-killed by mistake. 5-sec fix per lead.`
- **Body:**
> Hey {rancherFirst}, my bad. I owe you a fix.
>
> An automation on my end was auto-closing leads it thought were stale. Turns out the automation couldn't see when you were working leads off-platform — calls, your own email, text. It killed **{n} of your leads** between May 5 and May 11 that may have actually been live.
>
> I fixed the code yesterday (now requires real signal from you before closing anything). But I need your help cleaning up the records.
>
> **For each lead below, tap one button.** Takes 5 seconds each. The system updates itself — no login.
>
> **💬 Still in talks** — you're working it. Restores lead to active in your dashboard.
> **✓ Closed Won** — you closed the sale. Asks for amount, auto-generates the 10% commission invoice.
> **✗ Truly lost** — they're out. Keeps it closed.
> **⏭ Pass** — wasn't a fit, releases buyer for someone else.
>
> *[per-lead rows: buyer name (state), order type · auto-closed date, email · phone, + the 4 action buttons]*
>
> Any lead you click "Closed Won" on — I'll send you the Stripe commission invoice automatically and we'll get the record straight. If you missed any sales that aren't even on this list, reply and I'll dig in.
>
> Sorry again. Code is fixed going forward.
> — Ben
> BuyHalfCow · Kalispell, MT 59901

---

## Other one-time ops scripts (named-situation blasts)

These also send email via Resend but are narrowly-scoped one-time ops fixes for a specific named rancher or incident — listed for awareness, copy not extracted:

- `segment-backfill-and-au-beef-route.mjs` — one-off: backfill Segment="Beef Buyer" on approved consumers, then route the 6 GA engaged buyers to AU Beef (creates referrals + sends intro emails).
- `cleanup-au-beef-mistake.mjs` — rolls back the AU Beef over-routing mistake from the script above (reverts referrals to Closed Lost) and sends a single clarifying note to Terrell (AU Beef operator).
- `homestead-move-quarters-from-hl.mjs` — moves CO Quarter buyers off High Lonesome (who doesn't do Quarters) onto Homestead Beef; reroutes active referrals + notifies.
- `homestead-route-rtb-waitlist.mjs` — routes the RTB-waitlisted CO Quarter buyers directly to Homestead via Airtable+Resend (no API call); sends intros.
- `chase-high-lonesome-stalled.mjs` — one-off chase-up emailing every stalled High Lonesome buyer (Rancher Contacted, no chases, 12+ days old) in a single batch the cron can't catch up on.
- `_send-lilyhill-followup.mjs` — one-shot: schedules a single Lily Hill follow-up email (May-20 visit + tier-ladder) for next morning, logs to Airtable Conversations.
- `_revert-stale-pushes.mjs` — reverts today's stale-lead matches (109 referrals from buyers who never opted in / had no Warmup Engaged At); includes corrective email sends.
- `_fix-replyto-queue.mjs` — infra fix: cancels + re-queues scheduled Resend emails that had Ben's personal Gmail hardcoded as Reply-To (so buyer replies stop landing in his personal inbox).
