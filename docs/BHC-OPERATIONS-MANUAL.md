# BuyHalfCow Operations Manual

> ⚠️ **For the current top-down picture, read [`BHC-PLATFORM-MAP.md`](BHC-PLATFORM-MAP.md) first.**
> That doc is kept in sync with the code (tier_v2 deposits, 33 crons, the migration wave,
> the money model). This manual (dated 2026-05-27) predates the tier_v2 deposit launch and
> is retained for its long-form operator narrative — treat the Platform Map as authoritative
> where they differ.

**Version:** 2026-05-27
**Purpose:** Top-down view of every email, onboarding flow, customer journey, funnel, and piece of infrastructure that runs BHC. Hand this to a new operator and they can run the business without rewriting a single line of code.

**Status as of writing:** 17 ranchers live, 1533 buyers in database, 24 crons running daily, 45+ Telegram operator commands, 17 Airtable tables. Branch `stage-3-verticals` is the working branch; production is `main`.

---

## Table of contents

1. [What BHC actually is](#1-what-bhc-actually-is)
2. [Daily operator routine](#2-daily-operator-routine)
3. [Customer journeys](#3-customer-journeys)
4. [Email inventory (54 templates)](#4-email-inventory)
5. [Cron schedule (24 crons)](#5-cron-schedule)
6. [Telegram bot reference](#6-telegram-bot-reference)
7. [Infrastructure](#7-infrastructure)
8. [Playbooks — "when X happens, do Y"](#8-playbooks)
9. [Troubleshooting](#9-troubleshooting)
10. [Emergency procedures](#10-emergency-procedures)
11. [Operator glossary](#11-operator-glossary)

---

## 1. What BHC actually is

**Business model:** private network connecting verified American ranchers with serious beef buyers. Not a marketplace. Not e-commerce. The platform makes money 3 ways:

1. **Per-sale commission** from ranchers (7% Pasture / 3% Ranch / 0% Operator tier).
2. **Monthly subscription** from ranchers ($150 Pasture / $350 Ranch / $500 Operator).
3. **Tiered subscriptions** from brand partners ($295 Spotlight / $595 Featured / $1500 Co-marketed) + Founder backers ($25/mo to $1000 lifetime).

**Two payment models for ranchers** — both shipping simultaneously:

- **Legacy:** rancher collects payment themselves (Stripe Payment Link / Venmo / check). BHC invoices commission monthly via Stripe.
- **tier_v2 (Stripe Connect):** BHC owns the Checkout flow. Buyer pays deposit + BHC fee on top via Stripe Connect direct charge. Rancher gets deposit immediately. BHC takes commission immediately. Rancher collects fulfillment balance directly outside BHC.

**Critical principle:** **commission is on FULL sale price**, not on deposit. If rancher sells $2000 half cow with $850 deposit, BHC takes 7% × $2000 = $140 upfront — paid via the deposit Checkout.

---

## 2. Daily operator routine

Every morning, run these 4 Telegram commands in order. Should take 5 minutes.

```
/cronstatus          → confirm last-24h crons all green
/whatfired today     → see today's activity baseline
/morning             → AI-curated brief: self-submits, founders, hot leads
/templatestats       → confirm email volume sane (no spike >2× baseline)
```

**Expected daily numbers (currently):**
- 5-15 new buyer signups
- 0-3 rancher self-submits
- 8-20 email sends (mostly drips)
- 1-5 referral status transitions

**Red flags to investigate same-day:**
- Any cron with `🚨 CRON ERROR` Telegram alert → run `/cronhealth`
- Send volume >2× baseline → run `/templatestats` + `/emaillog <highest-volume>`
- Cap breaches in `/spam-audit` Saturday digest → review caps
- New rancher signed agreement but `/cronstatus` shows `rancher-launch-warmup` partial → manual `/resume <name>` to fire warmup

**Weekly routine (Saturday morning):**
- `/spam-audit` Telegram digest auto-fires Sat 14:00 UTC. Review top-20 recipients + suggested template kills.

---

## 3. Customer journeys

Five distinct personas. Each has an entry → conversion → retention loop.

### 3.1 Buyer journey

```
ENTRY ─→ ROUTING ─→ HANDOFF ─→ CLOSE ─→ POST-PURCHASE ─→ AFFILIATE
  │         │          │         │             │              │
 /access   matching   intro    deposit /     Day-0/14/30/90  auto-enroll
 /map      /suggest   emails   Closed-Won    cadence         on Closed Won
 /ranchers/                    button
 [slug]
```

**Stage 1 — ENTRY**
- Surfaces: `/access` quiz, `/access/[state]` (programmatic SEO), `/ranchers/[slug]`, `/map`, exit-intent modal (email-only)
- Trigger: `POST /api/consumers` (full) or `POST /api/consumers/quick` (exit-intent)
- Capture: name, email, state, segment (Beef Buyer / Community / Backup), order type, budget, timing, intent signals, UTM params, affiliate `?ref=` code
- Server: computes intent score 0-100, normalizes state, blocks throwaway domains, dedupes by email
- Result: Consumers row, `Status='Approved'`, `Buyer Stage='NEW'`
- Emails: `sendWelcomeAndReadyToBuy` (covered state) OR `sendStateWaitlistLetter` (no rancher in state)
- Telegram: hot-lead alert if score ≥ 80
- CAPI: `Lead` event with `event_id=record.id` + fbp/fbc cookies

**Stage 2 — ROUTING (matching engine)**
- Trigger: signup invokes `POST /api/matching/suggest` synchronously when state covered + buyer qualified
- Gates: state-match, capacity (Redis atomic INCR), tier specialty, Admin Approved Multi-State, performance score sort
- Result: Referrals row `Status='Intro Sent'` + intro emails fire
- Emails: `sendBuyerIntroNotification` to buyer + `sendInquiryToRancher` to rancher (Reply-To tagged)
- Telegram: `🔥 READY-TO-BUY MATCH` for hot leads

**Stage 3 — HANDOFF**
- Rancher receives intro with Reply-To tag
- Reply lands at `/api/webhooks/resend-inbound` → classification (Conversations table) → activity stamp
- Buyer can click YES on warmup email → `GET /api/warmup/engage` → re-fire matching with `warmupEngaged=true`

**Stage 4 — CLOSE (two paths)**

**Path A — legacy** (rancher takes payment outside BHC):
- Rancher hits Closed Won button in dashboard
- BHC creates Stripe Invoice for commission via `createCommissionInvoice`
- `sendInstantCommissionInvoice` to rancher
- Capacity DECR (Redis atomic)

**Path B — tier_v2** (BHC-hosted Checkout):
- Buyer hits `/checkout/[refId]/deposit` → BHC creates Stripe Checkout Session via `createDepositCheckout`
- Buyer pays (deposit + BHC fee on full sale price) → Stripe webhook `payment_intent.succeeded` → auto-Closed Won
- Telegram: `💰 DEPOSIT PAID — Rancher $X · BHC $Y · Balance at fulfillment $Z`
- CAPI: `Purchase` event with value=totalChargedDollars

**Stage 5 — POST-PURCHASE**
- Day 0: `sendPostPurchaseWelcome`
- Day 14: `sendCutsEducation`
- Day 30: `sendClosedMonthlyLetter`
- Day 90: `sendRepeatPurchaseAsk`
- Auto-enroll as affiliate via `ensureBuyerAffiliate` (mints 6-char code)

---

### 3.2 Rancher journey

```
PROSPECT ─→ WIZARD ─→ AGREEMENT ─→ LIVE ─→ FIRST SALE ─→ ONGOING
   │           │          │         │           │            │
 self-       4 steps    sign JWT  Active +    recordClose  monthly
 submit /    + Stripe   triggers  Page Live + Closed Won   commission
 community / Connect    go-live   warmup                   + Pilot
 admin-add   step       flip      drain                    Upsell at goal
```

**Stage 1 — PROSPECT**
- Surface: `/map/add-a-rancher` self-submit form OR admin manual-add
- Trigger: `POST /api/prospects/self-submit`
- Result: Ranchers row, `Verification Status='Prospect'`, `Self-Submitted At=now`, magic link minted
- Emails: `sendRancherSelfSubmitWelcome` (self) OR `sendRancherCommunityIntro` (community submit)
- Telegram: `🟡 SELF-SUBMIT` alert with Onboard/Block buttons

**Stage 2 — WIZARD (`/rancher/setup`)**
- 4 steps: Contact → Brand → Pricing → Review
- Auto-save per text field, current-step persistence
- Pricing step collects: `Quarter Price`, `Half Price`, `Whole Price` (full sale prices) + NEW `Quarter Deposit`, `Half Deposit`, `Whole Deposit` (optional upfront amounts)
- tier_v2 ranchers: separate Stripe Connect onboarding step mints `acct_*`
- No Stripe Products required — BHC creates Checkout Sessions dynamically using `price_data` against Connect acct

**Stage 3 — AGREEMENT**
- Rancher signs via JWT magic link
- Auto-flip: `Onboarding='Live'`, `Active='Active'`, `Page Live=true`, fires `triggerLaunchWarmup` (F3 fix — drains waitlisted buyers in state immediately)
- Telegram: agreement-signed alert with Verify button

**Stage 4 — LIVE**
- `/ranchers/[slug]` page goes public
- Eligible for matching engine via `isRancherOperationalForBuyers`
- Per-match intro emails fire

**Stage 5 — FIRST SALE / ONGOING**
- Pipeline same as buyer Stage 4 above
- First-sale Telegram celebration with lifetime + monthly counters
- Pilot Upsell: at `Pilot Closes Goal` (lifetime closes), `sendPilotUpsellEmail` fires + auto-pauses to protect rancher attention
- Monthly commission invoice via `commission-invoices` cron (legacy ranchers only)

---

### 3.3 Brand partner journey

```
/brand-partners ─→ Stripe Checkout ─→ webhook ─→ BRANDS row + welcome ─→ monthly renewal
```

- Surface: `/brand-partners` tier page (Spotlight / Featured / Co-marketed)
- Trigger: `GET /api/checkout/brand?tier=<slug>` → resolves env price ID → Stripe Checkout Session (subscription mode, `metadata.type='brand-partner-tier'`)
- Gate: hard-error redirect if Price ID env unset (F2 fix removed silent Payment Link fallback)
- Webhook: `checkout.session.completed` → upserts BRANDS row + sends `sendBrandListingConfirmation`
- Renewals: `invoice.paid` stamps `Last Renewal At` (F2 fix)
- Dunning: `invoice.payment_failed` fires `sendBrandPaymentFailed` (I-7 fix)

### 3.4 Backer / Founders journey

```
/founders ─→ Stripe Checkout ─→ webhook ─→ Consumers row Founder Tier ─→ monthly letter cron
```

- Surface: `/founders` page (Herd / Outlaw / Steward × monthly/annual + Founding 100 + Title Founder lifetime tiers)
- Cap-enforced tiers: `POST /api/founders/checkout` blocks at `FOUNDING_100_CAP` / `TITLE_FOUNDER_CAP`
- Webhook: `checkout.session.completed` → Consumers row `Founder Tier` set
- Welcome: tier-aware `sendFoundingHerdWelcome` (steward/outlaw/herd/founder #N/title founder variants)
- Ongoing: `backer-monthly-letter` cron fires `sendBackerMonthlyLetter` on 1st of month (Backer Letter Sent At stamps per-month idempotency)

### 3.5 Wholesale buyer journey

```
/wholesale ─→ form ─→ POST /api/wholesale/signup ─→ Inquiries row ─→ admin alert + buyer confirmation
```

- Surface: `/wholesale` B2B page
- Trigger: `POST /api/wholesale/signup` with business name + contact + volume + cuts of interest
- Result: Inquiries row, `Interest Type='Wholesale'`, structured Notes payload (no schema migration)
- Emails: `sendWholesaleConfirmation` to applicant + `sendAdminAlert` to operator
- Telegram: `NEW WHOLESALE APPLICATION` single-line alert
- Handoff: admin manually reaches out 24-48h with matching ranchers

### 3.6 Affiliate journey

```
Closed Won ─→ ensureBuyerAffiliate ─→ magic-link login ─→ /a/[code] ─→ share ─→ tracked deposits
```

- Auto-enroll: every Closed Won buyer triggers `ensureBuyerAffiliate` (idempotent by email, mints 6-char code)
- Result: Affiliates row `Source='auto-closed-won'`, `Linked Consumer=[buyerId]`, Consumer row stamped with `Affiliate Code`
- Share: affiliate dashboard shows `shareUrl = /access?ref={CODE}` or `/a/[code]` short link
- Attribution: `?ref=CODE` → `validateAffiliateRefForSignup` blocks self-referrals → writes Consumer `Referred By`
- Click tracking: `POST /api/affiliates/track-click` (idempotent via sessionStorage)
- Magic-link login: `sendAffiliateLoginLink` for dashboard access

---

## 4. Email inventory

54 send helpers in `lib/email.ts`. Every send wraps `guardedSend` → checks pause + whitelist + frequency cap + suppression (Unsubscribed/Bounced/Complained) → logs to Email Sends table.

**Frequency cap:** rolling 7-day window, default 3 sends per recipient (`EMAIL_FREQUENCY_CAP_PER_WEEK` env). 22 templates whitelisted (always send).

### 4.1 Buyer emails (24)

| Function | Trigger | Cap |
|---|---|---|
| `sendConsumerConfirmation` | Application Received (non-auto path) | Capped |
| `sendConsumerApproval` | Admin approves consumer | Whitelisted |
| `sendWelcomeAndReadyToBuy` | Auto-approve at signup (covered state) | Capped |
| `sendFounderLetterWaiting` | `email-sequences` cron Day 7/30/monthly | Capped |
| `sendMatchNowRescue` | MATCH_NOW segment | Capped |
| `sendBuyerIntroNotification` | matching/suggest creates referral | Whitelisted |
| `sendAbandonedRecoveryEmail` | 24h / 3d / 7d after /access abandon | Capped |
| `sendNudgeToEngage` | NUDGE_TO_ENGAGE segment, up to 2 lifetime, 7d apart | Capped |
| `sendWarmLeadReadyCheck` | WARM_LEAD segment, up to 4 lifetime, 14d apart | Capped |
| `sendIncompleteProfileAsk` | INCOMPLETE_PROFILE, 3 sends over 28d (I-6 fix) | Capped |
| `sendNoBudgetFounderPitch` | Budget <$500 | Capped |
| `sendStateWaitlistLetter` | Signup uncovered state + matching no-match (F-1 fix) | Capped |
| `sendRancherLaunchWarmup` | `rancher-launch-warmup` cron when rancher goes live | Capped |
| `sendRancherLaunchWarmupNudge` | Day 7 follow-up | Capped |
| `sendWaitlistEmail` | `batch-approve` cron auto-approved + uncovered state | Capped |
| `sendBackfillEmail` | Auto-approved + missing fields | Capped |
| `sendRerouteNotification` | Rancher passes on lead | Capped |
| `sendPostPurchaseWelcome` | Closed Won | Capped |
| `sendCutsEducation` | Day 14 post-Closed Won | Capped |
| `sendClosedMonthlyLetter` | Month 2/3/4 post-Closed Won | Capped |
| `sendRepeatPurchaseAsk` | Month 5 post-Closed Won | Capped |
| `sendRepeatPurchaseEmail` | `referral-chasup` cron 30-day repeat | Capped |
| `sendTestimonialAsk` | `testimonial-collection` cron ~14d after Closed Won | Capped |
| `sendBuyerFulfillmentConfirmation` | Rancher hits Confirm Fulfillment | Whitelisted |

### 4.2 Rancher emails (18)

| Function | Trigger | Cap |
|---|---|---|
| `sendProspectClaimMagicLink` | `/api/prospects/claim` form | Whitelisted |
| `sendRancherSelfSubmitWelcome` | `/api/prospects/self-submit` self path | Whitelisted |
| `sendRancherCommunityIntro` | Community submit on rancher's behalf | Capped |
| `sendRancherOnboardingDripDay2` | `rancher-onboarding-drip` cron Day 2 | Capped |
| `sendRancherOnboardingDripDay5` | Day 5 | Capped |
| `sendRancherOnboardingDripDay14` | Day 14 last touch | Capped |
| `sendPartnerConfirmation` | `/api/partners` rancher/brand/land application | Whitelisted |
| `sendRancherCheckIn` | Telegram `/checkin` on stalled pipeline | Capped |
| `sendPipelineUpdateEmail` | Telegram `/blitz` re-engagement | Capped |
| `sendRancherApproval` | Admin approves | Whitelisted |
| `sendRancherGoLiveEmail` | Admin flip Live | Whitelisted |
| `sendInquiryToRancher` | matching creates referral | Whitelisted |
| `sendTrackedContactEmail` | `/api/public/ranchers/[slug]/contact` form | Capped |
| `sendRancherLeadReminder` | `referral-chasup` cron Day 2 Intro Sent w/o action | Capped |
| `sendRancherLeadNudge` | `rancher-followup` cron stale leads | Capped |
| `sendInstantCommissionInvoice` | Rancher hits Closed Won | Whitelisted |
| `sendMonthlyCommissionInvoice` | `commission-invoices` cron 1st of month | Whitelisted |
| `sendPilotUpsellEmail` | Rancher hits pilot-closes goal | Capped |

### 4.3 Brand partner emails (4)

| Function | Trigger | Cap |
|---|---|---|
| `sendBrandApprovalWithPayment` | Admin approves brand | Whitelisted |
| `sendBrandListingConfirmation` | Stripe payment success | Whitelisted |
| `sendBrandPaymentFailed` | Stripe invoice.payment_failed dunning (I-7) | Whitelisted |
| `sendWholesaleConfirmation` | `/api/wholesale/signup` (I-5) | Whitelisted |

### 4.4 Backer emails (2)

| Function | Trigger | Cap |
|---|---|---|
| `sendFoundingHerdWelcome` | Stripe checkout completed on Founder tier | Whitelisted |
| `sendBackerMonthlyLetter` | `backer-monthly-letter` cron 1st of month (I-4) | Capped |

### 4.5 Admin / operator alerts (2)

| Function | Trigger | Cap |
|---|---|---|
| `sendAdminAlert` | Any new application (consumer/rancher/brand/wholesale) | Whitelisted |
| `sendInquiryAlertToAdmin` | `/api/inquiries` POST pending | Whitelisted |

### 4.6 Affiliate emails (3)

| Function | Trigger | Cap |
|---|---|---|
| `sendAffiliateInvite` | Admin sends invite | Capped |
| `sendAffiliateWelcome` | `/api/admin/affiliates` POST (auto-enroll) | Capped |
| `sendAffiliateLoginLink` | `/api/auth/affiliate/login` magic link | Capped |

### 4.7 Operator utility (4)

| Function | Trigger | Cap |
|---|---|---|
| `sendMagicLink` | `/api/auth/member/login`, `/api/auth/rancher/login` (F4) | Whitelisted |
| `sendEmail` | Generic wrapper (25+ call sites) | Capped |
| `sendBroadcastEmail` | `/admin/broadcast` + `send-scheduled` cron | Capped |
| `sendMerchEmail` | `/api/admin/send-merch` | Capped |

### 4.8 Suppression rules

1. **Whole-list suppression** — Unsubscribed=TRUE, Bounced=TRUE, or Complained=TRUE on Consumer/Rancher blocks ALL sends. Resend wrapper short-circuits + logs `status='suppressed'`.
2. **Frequency cap** — 3 sends per recipient per 7d (env-tunable).
3. **TRANSACTIONAL_WHITELIST** — 22 templates bypass cap (invoices, intros, approvals, welcomes, magic links).
4. **Pause check** — `/pausemail <template>` adds row to Cron Pauses table; runs BEFORE whitelist (F4 fix — emergency stop wins).
5. **CAN-SPAM** — every email has business address footer + token-based unsubscribe.
6. **Rate-limit guard** — Resend 8 req/sec token bucket + global serialization, 429 → 1s backoff.

---

## 5. Cron schedule

24 crons via `vercel.json`. Every cron wraps with `withCronRun` → logs to Cron Runs table → Telegram-alerts on error or partial (F6 fix, 1h cooldown).

### 5.1 Schedule table (sorted by daily firing time UTC)

| UTC | MT | Name | Purpose |
|---|---|---|---|
| `0 4` | 22:00 (prior) | reclassify-buyers | Recompute Routing Segment for every Consumer |
| `45 5` | 23:45 (prior) | daily-audit | Full state sweep + AI issue list |
| `0 5` | 23:00 (prior) | nightly-rancher-audit | Per-rancher pipeline + capacity drift |
| `0 13` | 07:00 | healthcheck | Ping Airtable/Resend/Telegram/AI, post Telegram |
| `30 13` | 07:30 | rancher-launch-warmup | Drain waitlisted buyers when rancher goes live in state |
| `0 14` | 08:00 | daily-digest | AI-curated morning brief |
| `0 14 1 *` | 08:00 1st-of-month | backer-monthly-letter | Monthly founder letter to all backers (I-4) |
| `0 14 * 6` | 08:00 Saturday | spam-audit | Weekly review of last-7d sends + Telegram digest |
| `15 9` | 03:15 | compliance-reminders | Overdue rancher doc reminders (F6 staggered from 09:00) |
| `0 9` | 03:00 | batch-approve | Auto-approve pending consumers + go-live ready ranchers |
| `0 15` | 09:00 | rancher-followup | Monday-only stale-lead nudge |
| `30 14` | 08:30 | stuck-buyer-recovery | Re-fire matching for YES-clicked stuck-at-READY buyers |
| `45 14` | 08:45 | rancher-trust-promotion | Flip Trust Mode on ≥5 closed-won ranchers |
| `0 16` | 10:00 | email-sequences | Drip emails by segment + days-since-approval |
| `15 16` | 10:15 | onboarding-stuck | Day 3/7/14 nudge for stuck onboarding ranchers |
| `20 16` | 10:20 | commission-invoices | Monthly commission invoices (F6 staggered from 16:00) |
| `30 16` | 10:30 | re-warm-cohort | Reanimate non-engaged warmed buyers |
| `5 17` | 11:05 | referral-chasup | AI re-engagement on stale referrals (G-5 staggered from 17:00) |
| `10 17` | 11:10 | awaiting-payment-nudge | Ranchers stuck >14d on Awaiting Payment |
| `15 17` | 11:15 | close-detector | Telegram one-tap card for 7d+ stuck referrals |
| `30 17` | 11:30 | rancher-onboarding-drip | Day 2/5/14 for self-submit ranchers |
| `0 18` | 12:00 | buyer-pulse | Ask buyer 5d+ Intro Sent if rancher reached out |
| `15 18` | 12:15 | testimonial-collection | Ask 7-90d post-close buyers for testimonial |
| `0 *` | hourly | send-scheduled | Drain scheduled broadcast queue |

### 5.2 Failure surface

Every cron returns one of: `success`, `partial`, `error`, `paused`, `maintenance-blocked`. `withCronRun`:
1. Pre-flight checks Cron Pauses table — if Paused=true, short-circuits with `paused` status (no Telegram alert).
2. Runs handler.
3. Writes Cron Runs row with status + duration + records touched + Skip Reason Breakdown.
4. **If status=error or partial → Telegram alert via direct fetch** (F6 fix). 1h in-memory cooldown per cron.

### 5.3 Skip Reason Breakdown

7 gating crons now populate JSON `{reason: count}` (F6 fix) so `/whatfired` shows WHY records skipped:
- `batch-approve` — unqualified reasons (`first-week-gate`, `missing-fields`, etc.)
- `testimonial-collection` — `already-asked`, `<7d-since-close`, `>90d-since-close`, `no-sale-amount`
- `referral-chasup` — `chase-cap-hit`, `recently-active`, `missing-email`
- `email-sequences` — `segment-mismatch`, `cadence-not-due`, `cap-suppressed`, `unsubscribed`
- `rancher-launch-warmup` — `rancher-not-operational`, `out-of-state`, `already-warmed`
- `stuck-buyer-recovery` — `not-stuck-yet`, `already-recovered`, `unsubscribed`
- `close-detector` — `no-stripe-event`, `referral-not-open`, `terminal-status`, `dedupe`

---

## 6. Telegram bot reference

45+ commands + 37 callback handlers. Admin-chat-gated via `TELEGRAM_ADMIN_CHAT_ID` env var (G-1 hardening — non-matching chats silently dropped). Webhook signature verified via `TELEGRAM_WEBHOOK_SECRET` (G-2 hardening — hard-required in prod).

### 6.1 READ commands (situational awareness)

| Command | What it shows |
|---|---|
| `/help` | Full 45-command reference |
| `/stats` | Top-level counters (consumers, ranchers, referrals) |
| `/today` | Daily numbers + AI top-3 priorities |
| `/morning` | Campaign-aware brief (self-submits, founders, hot leads) |
| `/brief` | AI-curated narrative with drill-down buttons |
| `/cronstatus` (alias `/runs`) | Last-24h status per cron |
| `/whatfired today\|yesterday\|YYYY-MM-DD` | Daily activity summary |
| `/templatestats` | Per-template send count last 30d |
| `/emaillog <email>` | Last 30d email log for one Consumer |
| `/freqcap` | Show current cap (currently 3) |
| `/capacity` | Ranchers near capacity |
| `/pending` (alias `/leads`) | Pending consumers awaiting review |
| `/pipeline` (alias `/refs`) | Referral stage breakdown |
| `/rancherpipeline` (alias `/rp`) | Rancher onboarding pipeline |
| `/lookup <q>` (alias `/find`, `/buyer`) | Search consumers + SMS/call/email buttons |
| `/stuckbuyers` | Waitlisted >14d grouped by state |
| `/stuckranchers` | Signed-not-Live + Live-but-quiet |
| `/ghostranchers` | Ranchers with 2+ ghost reports |
| `/status` | Health-check Airtable/Resend/Telegram/AI |
| `/routingstatus` (alias `/segments`) | Buyer routing-segment breakdown |
| `/revenue` (alias `/money`) | Revenue + commission summary |
| `/casestudy <name|slug>` | Generate social blurb |

### 6.2 WRITE commands (mutate state — confirmation-gated where dangerous)

| Command | Effect | Confirm? |
|---|---|---|
| `/qualify` | AI scores pending leads w/ approve/reject buttons | Button-gated |
| `/chasup` | AI-draft re-engagement for stalled referrals | Preview |
| `/broadcast <segment> <msg>` | Send broadcast | `bcsend_` callback |
| `/blast <STATE> <msg>` | Email blast to state buyers | Preview |
| `/blitz` | Per-rancher personalized updates | `blitz_send` / `blitz_cancel` |
| `/checkin` | Stalled-rancher nudge | `rcheckin_send` |
| `/bulkonboard` | Send onboarding docs to missing-doc ranchers | `bulkonboard_send` |
| `/bulkfire confirm` | Promote all Pending Approval → Intro Sent (max 50) | **Requires literal "confirm"** |
| `/match <buyer> <rancher>` | Fuzzy match + inline confirm | `matchfire` / `matchcancel` |
| `/forcematch <email\|recId>` | Bypass cooldowns, match stuck buyer | No |
| `/pause <slug>` | Stop sending leads to rancher | No |
| `/resume <slug>` | Reactivate paused rancher | No |
| `/routestate <STATE> <slug> [dry\|morning]` | Bulk-route stuck state buyers | `dry` previews |
| `/setuppage <name>` | Interactive rancher-page wizard | Multi-step |
| `/makeaffiliate <email>` | Make consumer an affiliate | No |
| `/comp <email> <tier> <note>` | Comp consumer into Founder tier | No |
| `/capacity <slug> <n>` | Adjust rancher capacity | No |
| `/pausecron <name>` | Pause a cron | No |
| `/resumecron <name>` | Resume a cron | No |
| `/pausemail <template>` | Pause an email template | No |
| `/resumemail <template>` | Resume an email template | No |

### 6.3 Callback handlers (button taps from inline cards)

37 callback prefixes — every mutation callback has idempotency guards (F5 fix). Notable mutation callbacks all use Upstash Redis SETNX (10-min window) or Status guard before mutating:

- `approve_`, `reject_` — pending consumer card → status flip
- `assignto_` — pick rancher → create referral (Redis claim)
- `markpaid_` — mark commission paid → Commission Ledger write
- `closelost_`, `clcheck_` — close referral (terminal-status guard)
- `bcsend_`, `rcheckin_send`, `blitz_send`, `bulkonboard_send` — mass-send callbacks (Redis claim per query ID)
- `rgolive_`, `rverify_` — rancher state flips (F5 — rverify_ now also goes live + warmup)
- `spgolive`, `sppreview`, `spdone` — setup-page wizard finalizers

### 6.4 Operational patterns

- **Admin chat gate** — every inbound message checks `chat.id === TELEGRAM_ADMIN_CHAT_ID`. Non-matching silently dropped.
- **Cross-instance dedup** — Upstash SETNX on `update_id` (5-min TTL) prevents Telegram retry duplicates (H-5 fix).
- **Inbound rate limit** — 30 commands/min per chat (H-6 fix).
- **Cron pause = email pause** — both use same Cron Pauses table, just different Name values.
- **Capacity counters via Redis atomic** — DECR/INCR with clamp-at-0; Airtable is eventually-consistent mirror.
- **Unknown commands fall through to AI** — natural-language routing via Claude.

---

## 7. Infrastructure

### 7.1 Webhooks (inbound — 7 endpoints)

| Endpoint | Source | Signature |
|---|---|---|
| `/api/webhooks/stripe` | Stripe platform events | `STRIPE_WEBHOOK_SECRET` via `stripe.webhooks.constructEvent` |
| `/api/webhooks/stripe-connect` | Stripe Connect (tier_v2 direct charges) | `STRIPE_CONNECT_WEBHOOK_SECRET` (V2 thin events + V1 fallback) |
| `/api/webhooks/telegram` | Telegram Bot | `X-Telegram-Bot-Api-Secret-Token` header |
| `/api/webhooks/resend` | Resend delivery events | Svix sig + `RESEND_WEBHOOK_SECRET` |
| `/api/webhooks/resend-inbound` | Resend Reply-To inbound | Svix sig + `RESEND_INBOUND_WEBHOOK_SECRET` |
| `/api/webhooks/cal` | Cal.com bookings | HMAC-SHA256 + `CAL_WEBHOOK_SECRET` |
| `/api/webhooks/manychat` | ManyChat IG/FB DM | Bearer + `MANYCHAT_WEBHOOK_SECRET` |

### 7.2 Airtable schema (17 tables)

Base: `appgLT4z009iwAfhs`

| Table | Purpose | Key fields |
|---|---|---|
| Ranchers | Producer roster | Slug, Onboarding Status, Active Status, Tier, Pricing Model, Connect Account Id, Quarter/Half/Whole Price + Deposit |
| Consumers | Buyer roster | Status, Buyer Stage, Segment, Routing Segment, Founder Tier, Referred By, Affiliate Code, Backer Letter Sent At |
| Referrals | Match lifecycle | Buyer, Rancher, Status (Intro Sent → Closed Won/Lost), Sale Amount, Commission Due |
| Conversations | Email + DM thread memory | Thread ID, Direction, Body, Subject |
| Payments | Stripe charge ledger | Referral, Type, Amount Cents, Status, Stripe Payment Intent Id |
| Brands | Brand partner subscriptions | Brand Name, Stripe Sub Id, Tier, Status, Last Renewal At |
| Inquiries | Generic inbound (wholesale, partner, founder) | Interest Type, Status, Notes |
| Affiliates | Auto-enrolled affiliates | Code, Stripe Connect Acct, Earnings |
| Funnel Events | Event log | Stage, Source, Event Id, fbp/fbc, UTM |
| Cron Runs | Per-execution log | Name, Started At, Status, Duration, Records Touched, Skip Reason Breakdown |
| Cron Pauses | Kill switches | Name, Paused, Reason |
| Email Sends | Per-message email log | Recipient, Template, Sent At, Status, Suppression Reason |
| AI Audit Log | AI write reversibility | Tool, Target, Args, Result, Reverse Action |
| Audit Log | Operator/system mutations | Actor, Action, Target, Before, After |
| Land Deals | Land deal inventory | Address, Acreage, State |
| Stripe Events | Idempotency log | Event Id, Type, Status |
| Brand Partners | tier_v2 brand subs | Subscription Id, Tier, Status |

### 7.3 External services (12)

| Service | Purpose | SPOF? |
|---|---|---|
| Vercel | Hosting + serverless + Cron + Blob | Yes — every webhook + page |
| Stripe (platform + Connect) | Payments + Connect | Yes — all revenue |
| Resend | Outbound + inbound email | Yes — email |
| Airtable | System of record | Yes — every write |
| Telegram | Bot for admin ops | Partial — ops freeze if down |
| Upstash Redis | Dedup + rate limits | Soft — dedup degrades |
| Twilio | SMS (SMS Opt-In gated) | No — optional |
| Meta (Pixel + CAPI) | Attribution | No — degrades only |
| Cal.com | Onboarding calls | No — manual fallback |
| GitHub | Repo + CI | No — deploy only |
| ManyChat | IG/FB DM automation | No — funnel piece |
| Anthropic/Groq/Tavily | LLM + web search | No — AI degrades |

### 7.4 Env vars (~65 — key ones)

| Var | Purpose | Rotate cadence |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe platform | On exposure |
| `STRIPE_WEBHOOK_SECRET` | Platform webhook sig | On re-register |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Connect webhook sig | On re-register |
| `STRIPE_BRAND_PRICE_SPOTLIGHT/FEATURED/FOUNDING` | Brand-partner tier Price IDs | When Stripe rotates |
| `RESEND_API_KEY` | Resend send | On exposure |
| `TELEGRAM_BOT_TOKEN` | Bot API | On exposure |
| `TELEGRAM_ADMIN_CHAT_ID` | Admin alerts route | Stable |
| `TELEGRAM_WEBHOOK_SECRET` | Inbound webhook sig | On re-register |
| `AIRTABLE_API_KEY` | Airtable PAT | Quarterly |
| `UPSTASH_REDIS_REST_URL/TOKEN` | Redis (dedup, rate limit) | On exposure |
| `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN` | Meta attribution | When Meta requires |
| `CRON_SECRET` | Vercel cron auth | **Rotate now** — leaked via prior client bundle |
| `EMAIL_FREQUENCY_CAP_PER_WEEK` | Per-recipient cap | Tune as needed (currently 3) |
| `JWT_SECRET`, `JWT_SECRET_LEGACY` | Magic-link signing | Quarterly w/ grace |
| `INTERNAL_API_SECRET` | Internal-only routes | Quarterly |
| `ADMIN_PASSWORD` | Admin gate | Quarterly |

### 7.5 Outbound calls

| Service | Where called | Failure mode |
|---|---|---|
| Stripe SDK | `lib/stripe.ts`, `stripeConnect.ts`, checkout routes | Throws → 5xx |
| Resend SDK | `lib/email.ts` | Logs + Email Sends status=failed |
| Airtable JS | `lib/airtable.ts` | 429 → exp backoff |
| Telegram API | `lib/telegram.ts` | Logs + swallowed |
| Upstash Redis | dedup + rate limits | Soft-fail |
| Meta CAPI | `lib/metaCapi.ts` | Logs + swallowed |
| Anthropic API | `lib/ai.ts` | Throws → Groq fallback |
| Groq API | LLM fallback | Throws → AI off |
| Tavily | Web search for AI | Falls back |
| Twilio | SMS | Logs + swallowed |

---

## 8. Playbooks

Run these when a specific situation happens.

### 8.1 New rancher signed up — full onboarding sequence

**What you do:** nothing. The system handles it.

**What happens automatically:**
1. `POST /api/prospects/self-submit` writes Ranchers row + sends `sendRancherSelfSubmitWelcome`
2. Rancher clicks magic link → loads wizard at `/rancher/setup`
3. Rancher completes 4 wizard steps + signs agreement
4. Sign-agreement POST auto-flips `Onboarding=Live`, `Active=Active`, `Page Live=true` (F3)
5. `triggerLaunchWarmup` fires immediately — drains state's waitlisted buyers
6. Within minutes, qualifying buyers receive `sendRancherLaunchWarmup` (YES button)
7. Buyer clicks YES → matching/suggest creates Referral → both sides get intro emails
8. Telegram alerts at every step

**What to check daily:**
- `/rancherpipeline` — confirms new rancher landed in Live status
- `/cronstatus` — confirms launch-warmup fired
- `/whatfired today` — counts buyers warmed

### 8.2 Rancher hasn't gone live in 14d — escalation

```
1. /lookup <rancher name>            → confirm wizard stage
2. /stuckranchers                    → see if they're in stuck list
3. Determine blocker:
   - Wizard incomplete → /resume <slug> + send manual nudge
   - Agreement pending → /checkin to send pipeline-update email
   - Stripe Connect not active → manual outreach (no auto-fix yet)
4. After 14d no progress: /pause <slug> to stop drip + DM rancher directly
```

### 8.3 Buyer signed up but never matched

```
1. /lookup <email>                   → confirm Consumers row exists
2. /emaillog <email>                 → see what emails fired
3. Identify state:
   - State uncovered → buyer is correctly on waitlist
   - State covered + READY → /forcematch <email> bypasses cooldowns
   - Form unqualified → /lookup shows missing fields → manual outreach
4. If matching fires error: bhc-flow-debug skill for full trace
```

### 8.4 Suspicious email volume spike

```
1. /templatestats                    → identify culprit template
2. /emaillog <top recipient>         → see if cap broken
3. If genuine spike (cron over-fired):
   - /pausemail <template>           → emergency stop
   - Investigate cron logs via Vercel
4. If spam-list compromise:
   - Check Suppression list growth
   - Audit /admin/broadcast usage
```

### 8.5 Stripe webhook delivery failures

```
1. Check Stripe Dashboard → Webhooks → Recent deliveries
2. Note failing event IDs
3. Inspect Vercel runtime logs for stripe-connect or stripe path
4. Common causes:
   - Endpoint 404 (stage-3-verticals not merged) → check route exists in main
   - Signature mismatch → STRIPE_WEBHOOK_SECRET or STRIPE_CONNECT_WEBHOOK_SECRET stale
   - 5xx → check route source for the event branch
5. Replay failed events from Stripe Dashboard
```

### 8.6 Cron didn't fire on schedule

```
1. /cronstatus                       → confirm cron not in error/partial list
2. /cronhealth                       → see 7d run history per cron
3. Check Cron Pauses table directly  → operator may have paused
4. Check Vercel Dashboard → Crons → ensure not disabled
5. Manual trigger:
   curl -X POST https://www.buyhalfcow.com/api/cron/<name> \
     -H "Authorization: Bearer $CRON_SECRET"
6. If still no fire: bhc-cron-debug skill
```

### 8.7 Brand partner subscription past_due

```
Automatic: sendBrandPaymentFailed dunning email fires via webhook (I-7)
Brand acts: opens hosted Stripe invoice link, updates card
Webhook flips Subscription Status → 'active'

If manual intervention:
1. Stripe Dashboard → Customers → find brand
2. Send dunning email manually if automated failed
3. After 14d unpaid: /admin/brands → mark inactive + remove from listing
```

### 8.8 Buyer requests refund

```
1. /lookup <email>                                  → find referral
2. Confirm scenario:
   - Rancher already shipped → harder; mediation needed
   - Pre-fulfillment → soft refund via Stripe
3. Stripe Dashboard → Customers → find PaymentIntent → Refund
4. Webhook (charge.refunded) auto-fires markDepositRefunded → updates Payments + Referral
5. Audit log auto-stamped (H-3)
6. Telegram alert confirms
```

---

## 9. Troubleshooting

### 9.1 Diagnostic commands cheat sheet

```
Cron not firing → /cronstatus + /cronhealth + bhc-cron-debug skill
Buyer stuck → /lookup <email> + /emaillog <email> + bhc-flow-debug skill
Rancher invisible → /stuckranchers + /rancherpipeline
Email volume weird → /templatestats + /emaillog <top recipient>
Match engine broken → /forcematch <email> (one-shot test)
Bulk match needed → /routestate <STATE> <slug> dry (preview first)
Payment issue → Stripe Dashboard + audit /admin/payments
Full platform sweep → /scout (AI investigates)
```

### 9.2 Skill cheat sheet (Claude operator skills)

- `bhc-ops` — daily mutations (push records, mark closed, draft emails)
- `bhc-audit` — full platform health audit
- `bhc-cron-debug` — investigate specific cron
- `bhc-flow-debug` — trace buyer/rancher flow end-to-end
- `bhc-mutation-guardrails` — required gate before bulk Airtable mutations
- `bhc-marketing` — generate BHC-voice marketing copy
- `stripe-best-practices` — Stripe integration guidance

### 9.3 Common errors + fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| Vercel deploy fails with TS error | Type-check broken | `npx tsc --noEmit` locally, fix, push |
| Webhook returns 401 | Signature env mismatch | Rotate webhook secret in Stripe/Resend, update Vercel env |
| Buyer never matched despite covered state | Rancher At Capacity OR not operational | `/lookup <rancher>` to confirm + `/capacity <slug> <n>` if at cap |
| Telegram bot doesn't respond | Admin chat ID gate OR webhook secret stale | Confirm TELEGRAM_ADMIN_CHAT_ID matches Telegram chat |
| Cron Runs table empty for a cron | withCronRun wrapper missing OR Cron Pause active | Inspect cron route + Cron Pauses table |
| Email sends silently dropped | Frequency cap hit OR suppression list | `/emaillog <email>` to see suppressions |

---

## 10. Emergency procedures

### 10.1 Halt all email sends immediately

```
Telegram: /pausemail sendEmail
+ /pausemail sendBuyerIntroNotification
+ /pausemail sendInquiryToRancher
+ /pausemail sendRancherLaunchWarmup
+ /pausecron email-sequences
+ /pausecron rancher-launch-warmup
+ /pausecron referral-chasup
```

Resumes individually via `/resumemail` and `/resumecron`.

### 10.2 Rollback bad deploy

```
1. Vercel Dashboard → Deployments → previous deployment
2. Click "..." → "Promote to Production"
3. Instant rollback (~30s)
4. Investigate failed deploy + commit revert if needed
```

### 10.3 Take site offline (maintenance)

```
1. Vercel Dashboard → Settings → Env vars
2. Set MAINTENANCE_MODE=true
3. Redeploy
4. Every API route returns 503; landing page shows maintenance banner
```

### 10.4 Stripe webhook flood / replay storm

```
1. Stripe Dashboard → Developers → Webhooks → endpoint
2. Click "Disable" temporarily
3. Investigate root cause
4. Re-enable when fixed; Stripe will retry queued events
```

### 10.5 Compromised credentials

```
Stripe key:    Rotate in Stripe Dashboard → API keys → roll
Resend key:    Resend Dashboard → API keys → revoke + new
Telegram bot:  BotFather → /token → revoke
Airtable PAT:  Airtable account → Tokens → revoke
Upstash:       Upstash Console → roll token

After rotation:
1. Update Vercel env vars
2. Redeploy
3. Verify webhook signatures still match (Stripe/Resend/Cal may need re-registration)
```

---

## 11. Operator glossary

**Active Status** — Rancher field. Active / Paused / At Capacity. Drives routing eligibility.
**Affiliate Code** — 6-char alphanumeric. Mirrors Affiliates table. Lives on Consumer row for fast lookup.
**Backer** — Founders/Founding Herd subscriber. Recurring $25+/mo OR lifetime $1k+.
**Buyer Stage** — Consumer field. NEW → MATCHED → CLOSED.
**Capacity** — Rancher's `Max Active Referrals`. Routing engine respects 1.2× hard ceiling (hot-lead bypass).
**Closed Won** — Referral state. Deal closed, sale recorded, commission accruing.
**Connect Account** — Stripe Connect account for tier_v2 ranchers. `acct_*`.
**Cron Runs** — Airtable table. Every cron execution writes here.
**Deposit** — Upfront payment from buyer. NEW: rancher sets per-cut, defaults to full price.
**Drip Sequence** — Cron-driven email series. Day 2/5/14 for ranchers; Day 14/30/90 for buyers.
**Founder Tier** — Consumers backing the build. Herd/Outlaw/Steward/Founding 100/Title Founder.
**Frequency Cap** — 3 emails per recipient per 7 days. Transactional whitelist bypasses.
**Hot Lead** — Buyer with intent score ≥ 80. Triggers immediate Telegram alert + capacity bypass.
**Intent Score** — 0-100 computed at signup from interest + tier + budget + timing.
**Magic Link** — JWT-based passwordless login. 60d expiry default; 24h for affiliates.
**MATCH_NOW** — Routing segment. Ready-to-Buy + covered state. Highest priority drip.
**Onboarding Status** — Rancher field. Prospect → Call Scheduled → Docs Sent → Agreement Signed → Live.
**Page Live** — Boolean on Rancher. Controls `/ranchers/[slug]` public visibility.
**Pasture/Ranch/Operator** — Three rancher subscription tiers ($150/$350/$500/mo, 7%/3%/0% per sale).
**Pilot Upsell** — Auto-fires when rancher hits Pilot Closes Goal. Triggers Calendly + auto-pause.
**Pricing Model** — Rancher field. `legacy` (rancher self-collects) or `tier_v2` (Stripe Connect).
**Referral** — Match between buyer and rancher. Status flows Intro Sent → Closed Won/Lost.
**Routing Segment** — Buyer field. Recomputed nightly. MATCH_NOW / WARM_LEAD / OUT_OF_STATE / etc.
**Skip Reason Breakdown** — JSON map on Cron Runs row. Tells operator WHY records skipped this run.
**Telegram Chat ID** — `TELEGRAM_ADMIN_CHAT_ID` env. Admin gate for all bot commands.
**tier_v2** — Stripe Connect rancher. BHC owns Checkout, takes commission via `application_fee_amount`.
**Trust Mode** — Rancher field. Auto-flipped at ≥5 closed-won. Bypasses some onboarding gates.
**Verification Status** — Rancher field. Prospect / Verified / Pending Verification.
**Warmup** — Pre-intro YES-button email. Confirms buyer intent before formal rancher intro fires.

---

## Appendix A — Quick links

- Production site: https://www.buyhalfcow.com
- Vercel project: https://vercel.com (logged in as operator)
- Stripe Dashboard: https://dashboard.stripe.com/acct_1TSn5PGTWWNqassH
- Airtable base: https://airtable.com/appgLT4z009iwAfhs
- Resend Dashboard: https://resend.com/emails
- Telegram bot owner: @BotFather → confirm bot configured
- GitHub repo: https://github.com/benjibushes/bhc

## Appendix B — Operator daily checklist

Print this. Stick on wall.

```
[ ] /cronstatus              (all green?)
[ ] /whatfired today         (sane volume?)
[ ] /morning                 (any hot leads to action?)
[ ] /templatestats           (no spikes?)
[ ] Check Telegram for 🚨 cron alerts
[ ] /stuckbuyers              (any escalations?)
[ ] /stuckranchers            (any need nudge?)
[ ] /pending                  (any to qualify?)
[ ] Saturday: read spam-audit Telegram digest
[ ] 1st of month: confirm backer-monthly-letter fired
[ ] Stripe Dashboard: any failed webhook deliveries?
```

---

## Appendix C — When to escalate to engineering

Operator should NOT touch code for any of these. Telegram message a developer:

- Cron returning error 3+ days in a row
- Webhook signature failures across multiple events
- Stripe Dashboard showing failed PaymentIntents > 10% of total
- TypeScript build failures (Vercel won't deploy)
- Airtable schema change needed (new field on Ranchers/Consumers/Referrals)
- New tier or pricing model to add
- New email template needed
- New Telegram command needed
- Any "I think there's a bug" hunch

Everything else (run a campaign, push a rancher, mark a deal closed, refund a buyer, pause a cron) is operator-side via Telegram + Airtable + admin dashboard.

---

**End of manual. Last updated: 2026-05-27. Maintained by: operator + engineering.**
