# BHC System Map

**Last updated:** 2026-05-26
**Purpose:** Single-page reference for every page, endpoint, cron, email template, Airtable table, Telegram command, and routing path. New-contractor-onboarding-grade.

---

## 1. Public Pages

All routes are Next.js App Router pages. "Revenue tier" reflects the page's direct contribution to a revenue event. Admin pages are listed separately (they aren't public-facing).

| URL | Purpose | Who lands here | Where they go next | Revenue tier | Status |
|---|---|---|---|---|---|
| `/` | Homepage — hero, live stats counter, CTA to sign up or browse ranchers | Cold traffic, ads, social | `/access` or `/ranchers` | high | live |
| `/access` | Buyer signup form — name, email, state, order type, budget, how-you-heard | New buyers | Confirmation email → `/member` | high | live |
| `/partner` | Rancher partnership inquiry form — mirrors `/access` UX for ranchers wanting to join | Prospective ranchers | Confirmation email → admin review | high | live |
| `/ranchers` | Public rancher directory — grid of all Page Live ranchers | Buyers browsing, SEO | Individual rancher profile `/ranchers/[slug]` | medium | live |
| `/ranchers/[slug]` | Individual rancher landing page — bio, cuts, certifications, contact CTA | Direct links, SEO | `/ranchers/[slug]/contact` | medium | live |
| `/ranchers/[slug]/contact` | Contact form for a specific rancher (inquiry without being a member) | Organic leads | Inquiry email sent to rancher + admin | medium | live |
| `/ranchers/[slug]/claim` | Rancher self-claim flow — verifies identity for an existing directory listing | Ranchers finding their unclaimed profile | Setup wizard | medium | live |
| `/ranchers/[slug]/remove` | Remove a rancher listing — restricted to unverified records | Ranchers wanting off the map | Confirmation page | zero | live |
| `/founders` | Founding Herd capital-raise page — tier table, Stripe payment links, live counter | Supporters, investors, email list | Stripe checkout or waitlist | high | live |
| `/brand-partners` | Brand partner tiers — logo, posts, marketing bundle pricing w/ Stripe links | Brands wanting exposure | Stripe checkout (manual fulfillment) | medium | live |
| `/map` | Discover Map — interactive map of all listed ranchers, filter by state | Buyers, ranchers, curiosity | `/ranchers/[slug]` or `/access` | medium | live |
| `/map/add-a-rancher` | Self-submit form — rancher lists themselves on the map without a BHC intro call | Ranchers arriving via referral/social | Welcome email → onboarding drip | medium | live |
| `/matched` | Handoff ceremony — confirms buyer's YES click, shows matched rancher bio | Buyers who clicked YES on warmup email | Member dashboard | high | live |
| `/member` | Buyer dashboard — matched rancher info, order details, Ready-to-Buy button | Logged-in buyers | `/api/member/ready-to-buy` | high | live |
| `/member/login` | Buyer magic-link login entry | Buyers accessing dashboard | `/member/verify` → `/member` | zero | live |
| `/member/verify` | Verifies buyer magic-link token from email | Buyers clicking login email | `/member` | zero | live |
| `/rancher` | Rancher dashboard — pipeline, referrals, landing page editor | Logged-in ranchers | Referral detail actions | high | live |
| `/rancher/login` | Rancher magic-link login entry | Ranchers accessing dashboard | `/rancher/verify` → `/rancher` | zero | live |
| `/rancher/verify` | Verifies rancher magic-link token | Ranchers clicking login email | `/rancher` | zero | live |
| `/rancher/setup` | Rancher onboarding wizard — pricing, bio, photos, states, agreement | New ranchers from setup email | `/rancher/sign-agreement` | high | live |
| `/rancher/sign-agreement` | Agreement signing page — token-gated e-sign | Ranchers finishing onboarding | Dashboard | high | live |
| `/affiliate` | Affiliate dashboard — clicks, signups, commissions | Affiliate partners | n/a | medium | live |
| `/affiliate/login` | Affiliate magic-link login | Affiliates | `/affiliate/verify` → `/affiliate` | zero | live |
| `/affiliate/verify` | Verifies affiliate magic-link token | Affiliates | `/affiliate` | zero | live |
| `/land` | Land deals browse page — raw land listings for sale | Buyers, farmers, ranchers | `/land/[id]/inquire` (API) | low | live |
| `/wins` | Public case-study wall — closed-won referrals, aggregate stats | SEO, social proof | `/access` | medium | live |
| `/news` | News/blog index — published posts from Airtable | SEO traffic | `/news/[slug]` | low | live |
| `/news/[slug]` | Individual news/blog post | SEO traffic | Social share, `/access` | low | live |
| `/about` | Mission + team page | New visitors | `/access` or `/ranchers` | low | live |
| `/faq` | FAQ | Pre-signup curious buyers | `/access` | low | live |
| `/brand/payment` | Brand payment processing page | Brands after choosing a tier | `/brand/payment/success` | medium | live |
| `/brand/payment/success` | Brand payment success confirmation | Brands post-checkout | n/a | zero | live |
| `/unsubscribe` | One-click unsubscribe page | Email recipients | Confirmation | negative | live |
| `/privacy` | Privacy policy | Legal, compliance | n/a | zero | live |
| `/terms` | Terms of service | Legal, compliance | n/a | zero | live |
| `/admin` | Admin dashboard home | Admin (Ben) | Sub-pages | zero | live |
| `/admin/today` | Today's action items — highest-value next actions | Admin | Act on items | zero | live |
| `/admin/health` | Platform health snapshot | Admin | Fix issues | zero | live |
| `/admin/analytics` | Buyer funnel analytics | Admin | Decisions | zero | live |
| `/admin/consumers` | Full consumer list + status | Admin | Consumer detail | zero | live |
| `/admin/consumers/[id]` | Individual consumer detail + actions | Admin | Edit, resend emails | zero | live |
| `/admin/ranchers/[id]` | Individual rancher detail + actions | Admin | Edit, go-live, pause | zero | live |
| `/admin/referrals` | Referral pipeline overview | Admin | Approve, reassign, revive | zero | live |
| `/admin/broadcast` | Manual broadcast email tool | Admin | Send broadcast | zero | live |
| `/admin/affiliates` | Affiliate management | Admin | Invite, activate, deactivate | zero | live |
| `/admin/inquiries` | Land deal inquiry tracking | Admin | Follow up | zero | live |
| `/admin/commissions` | Commission tracking | Admin | Invoice, adjust | zero | live |
| `/admin/compliance` | Compliance reminder tracker | Admin | Trigger reminders | zero | live |
| `/admin/heatmap` | Geographic buyer density heatmap | Admin | Decide rancher recruitment | zero | live |
| `/admin/backfill` | Backfill campaign tool — re-engage old leads | Admin | Run campaigns | zero | live |
| `/admin/login` | Admin login | Admin | `/admin` | zero | live |

---

## 2. API Endpoints

Methods shown as exported handler names. Auth types: `JWT-cookie` = session cookie with JWT; `JWT-param` = token in URL/header; `CRON_SECRET` = Authorization Bearer env var; `admin-cookie` = signed admin session cookie; `none` = public.

### 2a. Consumer / Buyer Endpoints

| METHOD + Path | Purpose | Auth | Status |
|---|---|---|---|
| `POST /api/consumers` | Buyer signup — creates Consumer record, sends confirmation + admin alert, triggers warmup if state covered | none | live |
| `POST /api/abandoned-app` | Captures partial signup (email-only) on form blur | none | live |
| `POST /api/waitlist` | Lightweight waitlist capture (no crons, no emails) during platform pauses | none | live |
| `POST /api/matching/suggest` | Core matching engine — finds best rancher for buyer, creates referral, sends intro emails | JWT-cookie | live |
| `GET /api/member/content` | Returns matched rancher details for buyer dashboard | JWT-cookie | live |
| `POST /api/member/ready-to-buy` | Records buyer's R2B click — highest-intent signal, triggers matching | JWT-cookie | live |
| `POST /api/member/upgrade-intent` | Records buyer's order-type + budget preference update | JWT-cookie | live |
| `POST /api/member/reorder` | Repeat-purchase reorder flow — links buyer to rancher for second order | JWT-cookie | live |
| `GET /api/buyer-pulse` | Records buyer's one-tap answer on "did your rancher reach out?" email | JWT-param | live |
| `GET/POST /api/unsubscribe` | One-click unsubscribe — marks Consumer/Rancher as Unsubscribed | none (token in URL) | live |
| `POST /api/orders/request` | Buyer submits specific order request (cuts, weight, delivery) | JWT-cookie | live |

### 2b. Rancher Endpoints

| METHOD + Path | Purpose | Auth | Status |
|---|---|---|---|
| `GET /api/rancher/dashboard` | Returns rancher's full pipeline + referrals for dashboard | JWT-cookie | live |
| `GET/PATCH /api/rancher/setup` | Rancher onboarding wizard — read current fields / save wizard progress | JWT-param | live |
| `PATCH /api/rancher/landing-page` | Rancher updates their own public landing page fields | JWT-cookie | live |
| `POST /api/rancher/upload` | Image upload to Vercel Blob for rancher profile photos | JWT-cookie | live |
| `GET /api/rancher/activate` | Rancher clicks "Accept" on pilot invite email (JWT link) | JWT-param | live |
| `GET /api/rancher/decline` | Rancher clicks "Decline" on pilot invite email | JWT-param | live |
| `GET /api/rancher/checkin-response` | Rancher responds to calendar check-in link | JWT-param | live |
| `POST /api/rancher/remove` | Rancher removes themselves from the platform | JWT-cookie | live |
| `GET/PATCH /api/rancher/referrals/[id]` | Rancher views referral detail / updates status (pass, Closed Won, etc.) | JWT-cookie | live |
| `POST /api/rancher/referrals/[id]/confirm-payment` | Rancher confirms buyer payment received | JWT-cookie | live |
| `POST /api/rancher/quick-action` | Email-based quick-action handler (pass/close buttons in rancher emails) | JWT-param | live |
| `PATCH /api/rancher/setup/auto-about` | AI auto-generates rancher "About" copy during setup | JWT-param | live |
| `POST /api/rancher/setup/request-agreement` | Rancher requests agreement during setup wizard | JWT-param | live |
| `POST /api/ranchers/sign-agreement` | Rancher e-signs the commission agreement | JWT-param | live |
| `POST /api/ranchers/resend-agreement` | Admin resends agreement signing link | admin-cookie | live |
| `POST /api/ranchers/capacity-check` | Updates rancher capacity after referral state changes; triggers warmup if newly available | CRON_SECRET | live |
| `POST /api/ranchers/[id]/send-onboarding` | Admin triggers rancher onboarding setup email | admin-cookie | live |
| `POST /api/prospects/self-submit` | Rancher self-submits to the map (public form) | none | live |
| `POST /api/prospects/claim` | Rancher claims an existing directory listing via magic link | JWT-param | live |
| `DELETE /api/prospects/remove` | Removes an unclaimed rancher listing | JWT-param | live |
| `GET /api/public/ranchers` | Public rancher list (Page Live only, no PII) | none | live |
| `GET /api/public/ranchers/[slug]` | Public rancher profile by slug | none | live |
| `POST /api/public/ranchers/[slug]/contact` | Public contact form for a specific rancher | none | live |

### 2c. Matching / Routing Endpoints

| METHOD + Path | Purpose | Auth | Status |
|---|---|---|---|
| `POST /api/matching/suggest` | Main matching engine — see §2a | JWT-cookie | live |
| `GET /api/warmup/engage` | Records buyer's YES click on warmup email, attempts first-week gate | JWT-param | live |
| `POST /api/referrals/route` | (Internal) Routes a consumer to a specific rancher by state/slug | admin-cookie | live |
| `PATCH /api/referrals/[id]/approve` | Admin approves a pending referral | admin-cookie | live |
| `PATCH /api/referrals/[id]` | Admin edits a referral record | admin-cookie | live |
| `GET /api/referrals` | Admin query of referrals by status | admin-cookie | live |
| `POST /api/admin/route-state-to-rancher` | Bulk-routes all stuck buyers in a state to a target rancher | admin-cookie | live |

### 2d. Webhooks (External)

| METHOD + Path | Purpose | Auth | Status |
|---|---|---|---|
| `POST /api/webhooks/telegram` | Receives Telegram updates — commands + callback_query from admin | Telegram token header | live |
| `POST /api/webhooks/telegram/setup` | One-time setup to register BHC's webhook URL with Telegram | CRON_SECRET | live |
| `POST /api/webhooks/stripe` | Stripe payment events — `checkout.session.completed` for Founders Herd + brand listings | Stripe signature | live |
| `POST /api/webhooks/resend` | Resend delivery events — bounce, complaint, delivery_delayed → marks consumer/rancher | Resend signature | live |
| `POST /api/webhooks/resend-inbound` | Resend inbound email — captures replies, AI-classifies, logs to Conversations, Telegrams Ben | RESEND_INBOUND_WEBHOOK_SECRET | live |
| `POST /api/webhooks/cal` | Cal.com booking webhook — updates rancher Onboarding Status on call completion | CAL_WEBHOOK_SECRET | live |
| `POST /api/webhooks/manychat` | ManyChat IG/Messenger DM leads — creates Consumer record from DM flow | MANYCHAT_WEBHOOK_SECRET | live |

### 2e. Admin Endpoints

| METHOD + Path | Purpose | Auth | Status |
|---|---|---|---|
| `POST /api/admin/auth` | Admin login | password | live |
| `GET /api/admin/today` | Action-item aggregator for today's dashboard | admin-cookie | live |
| `GET /api/admin/health` | Platform health snapshot | admin-cookie | live |
| `GET /api/admin/analytics` | Buyer funnel analytics | admin-cookie | live |
| `GET /api/admin/consumers` | Consumer list | admin-cookie | live |
| `GET/PATCH /api/admin/consumers/[id]` | Consumer detail + edit | admin-cookie | live |
| `POST /api/admin/consumers/[id]/resend-warmup` | Resend warmup email to a buyer | admin-cookie | live |
| `GET /api/admin/ranchers` | Rancher list | admin-cookie | live |
| `GET/PATCH /api/admin/ranchers/[id]` | Rancher detail + edit | admin-cookie | live |
| `POST /api/admin/ranchers/[id]/go-live` | Flips rancher to Live, triggers launch warmup | admin-cookie | live |
| `POST /api/admin/ranchers/[id]/pause` | Pauses a rancher (stops new leads) | admin-cookie | live |
| `POST /api/admin/ranchers/[id]/resume` | Resumes a paused rancher | admin-cookie | live |
| `POST /api/admin/ranchers/[id]/impersonate` | Admin impersonates rancher session for debugging | admin-cookie | live |
| `POST /api/admin/ranchers/[id]/resend-setup` | Resends rancher setup wizard email | admin-cookie | live |
| `GET /api/admin/referrals/stats` | Referral pipeline stats | admin-cookie | live |
| `POST /api/admin/referrals/[id]/resend-intro` | Resend buyer intro email for a referral | admin-cookie | live |
| `POST /api/admin/referrals/[id]/revive` | Revives a closed/lost referral | admin-cookie | live |
| `PATCH /api/admin/referrals/[id]/adjust-commission` | Adjusts commission rate on a referral | admin-cookie | live |
| `POST /api/admin/referrals/[id]/reassign` | Reassigns referral to a different rancher | admin-cookie | live |
| `POST /api/admin/referrals/manual-create` | Manually creates a referral record | admin-cookie | live |
| `GET/POST /api/admin/broadcast` | Manual broadcast send + preview | admin-cookie | live |
| `GET /api/admin/broadcast/stats` | Broadcast delivery stats | admin-cookie | live |
| `GET /api/admin/affiliates` | Affiliate list | admin-cookie | live |
| `POST /api/admin/affiliates/[id]/send-invite` | Sends affiliate invite email | admin-cookie | live |
| `POST /api/admin/affiliates/[id]/deactivate` | Deactivates an affiliate | admin-cookie | live |
| `POST /api/admin/affiliates/[id]/reactivate` | Reactivates an affiliate | admin-cookie | live |
| `GET/PATCH /api/admin/brands/[id]` | Brand detail + edit | admin-cookie | live |
| `GET/POST /api/admin/brands` | Brand list + create | admin-cookie | live |
| `GET/POST /api/admin/landDeals` | Land deal list + create | admin-cookie | live |
| `GET/PATCH/DELETE /api/admin/landDeals/[id]` | Land deal detail + edit + delete | admin-cookie | live |
| `POST /api/admin/send-merch` | Sends merch fulfillment email to a buyer | admin-cookie | live |
| `GET /api/admin/search` | Global search across consumers + ranchers | admin-cookie | live |
| `POST /api/admin/founders/comp` | Creates complimentary Founding Herd membership | admin-cookie | live |
| `GET /api/admin/backfill-states` | One-time migration: normalize state fields | password | deprecated |
| `GET /api/admin/setup-ai-fields` | One-time setup: create AI fields in Airtable schema | password | deprecated |
| `GET /api/admin/setup-rancher-page-fields` | One-time setup: create rancher page fields in Airtable schema | password | deprecated |

### 2f. Other / Utility Endpoints

| METHOD + Path | Purpose | Auth | Status |
|---|---|---|---|
| `GET /api/health` | Dependency health check — Airtable, Resend, Stripe, Telegram | Bearer CRON_SECRET | live |
| `GET/POST /api/stats/public` | Public stats — rancher count, buyer count, closes (homepage counter) | none | live |
| `GET /api/stats/buyers-by-state` | Buyer density by state — used in rancher onboarding wizard widget | none | live |
| `GET /api/public/land` | Public land deals list | none | live |
| `POST /api/land/[id]/inquire` | Public land inquiry form submission | none | live |
| `GET/POST /api/inquiries` | Inquiry list / create (admin) | admin-cookie | live |
| `GET/PATCH /api/inquiries/[id]` | Inquiry detail + status update | admin-cookie | live |
| `POST /api/partners` | Rancher partnership inquiry form submission | none | live |
| `GET/POST /api/news` | News post list + create (admin) | mixed | live |
| `GET/PATCH /api/news/[slug]` | News post detail + update | mixed | live |
| `POST /api/founders/checkout` | Creates Stripe checkout session for Founding Herd tiers | none | live |
| `POST /api/brands/checkout` | Creates Stripe checkout session for brand listing | JWT-param | live |
| `POST /api/affiliates/track-click` | Fire-and-forget affiliate click tracking | none | live |
| `GET /api/affiliate/dashboard` | Affiliate dashboard data | JWT-cookie | live |
| `GET/POST /api/auth/member/login` | Member magic-link request | none | live |
| `GET /api/auth/member/session` | Member session check | JWT-cookie | live |
| `GET /api/auth/member/verify` | Member magic-link verify | JWT-param | live |
| `GET/POST /api/auth/rancher/login` | Rancher magic-link request | none | live |
| `GET /api/auth/rancher/session` | Rancher session check | JWT-cookie | live |
| `GET /api/auth/rancher/verify` | Rancher magic-link verify | JWT-param | live |
| `GET/POST /api/auth/affiliate/login` | Affiliate magic-link request | none | live |
| `GET /api/auth/affiliate/session` | Affiliate session check | JWT-cookie | live |
| `GET /api/auth/affiliate/verify` | Affiliate magic-link verify | JWT-param | live |
| `POST /api/backfill/generate-links` | Generates JWT backfill links for old leads | admin-cookie | live |
| `POST /api/backfill/send-campaign` | Sends backfill email campaign | admin-cookie | live |
| `PATCH /api/backfill/update-profile` | Backfill: updates buyer profile from link-click | JWT-param | live |
| `GET /api/backfill/validate-token` | Validates backfill JWT token | none | live |
| `GET /api/maintenance-backfill-segment` | One-time: populates Segment field for old consumers | password | deprecated |
| `POST /api/maintenance-resurrect-orphans` | One-time: resets 438+ stuck Pending Approval referrals | password | deprecated |

---

## 3. Crons

All crons run on Vercel. Source of truth: `vercel.json`. All routes are under `/api/cron/`. Every cron is wrapped in `withCronRun()` (logs a row to Cron Runs table). Auth: `Authorization: Bearer CRON_SECRET` header.

Sorted by frequency: hourly first, then daily (by UTC hour), then weekly.

| Schedule (UTC) | Path | What it does | Touches | Revenue tier | Status |
|---|---|---|---|---|---|
| `0 * * * *` (hourly) | `/api/cron/send-scheduled` | Sends any Campaigns rows whose `Send At` has passed. Batches 10/sec to protect sender reputation. | Campaigns, Consumers, Ranchers | high | live |
| `0 4 * * *` | `/api/cron/reclassify-buyers` | Nightly: recomputes Routing Segment for every Consumer based on current rancher coverage + buyer intent. Downstream email-sequences branches on this. | Consumers, Ranchers | high | live |
| `0 5 * * *` | `/api/cron/nightly-rancher-audit` | Per-rancher pipeline status + system-wide bug list → Telegram digest. Includes capacity drift, ghosting ranchers, days since last close. | Ranchers, Referrals | zero | live |
| `45 5 * * *` | `/api/cron/daily-audit` | AI-powered morning sweep via Claude tool-use. Surfaces stale referrals, capacity drift, stuck buyers, error spikes → prioritized Telegram issue list. Read-only. | All tables (read) | zero | live |
| `0 9 * * *` | `/api/cron/compliance-reminders` | Monthly (date-1 guard): sends compliance reminder emails to ranchers whose renewal date is due. Daily no-op except on target date. | Ranchers | negative | live |
| `0 9 * * *` | `/api/cron/batch-approve` | Approves pending consumers, routes qualified buyers to ranchers, fires waitlist letters, goes-live on pending ranchers, triggers launch warmup for new ranchers. | Consumers, Ranchers, Referrals | high | live |
| `0 13 * * *` | `/api/cron/healthcheck` | Calls `/api/health`, posts pass/fail Telegram summary so Ben sees system status before the business-hours crons fire. | External deps | zero | live |
| `30 13 * * *` | `/api/cron/rancher-launch-warmup` | Emails buyers in newly-covered states to warm them up for matching. Two phases: initial warmup + day-7 nudge. Trust Mode gate controls which ranchers get full drain vs throttled drain. | Consumers, Ranchers | high | live |
| `0 14 * * *` | `/api/cron/daily-digest` | AI-generated daily summary via Claude → Telegram. Yesterday's signups, closes, revenue, pending actions. | All tables (read) | zero | live |
| `30 14 * * *` | `/api/cron/stuck-buyer-recovery` | Retries matching for buyers who clicked YES but never got a referral (capacity was full, state uncovered, or error mid-flight). | Consumers, Referrals | high | live |
| `45 14 * * *` | `/api/cron/rancher-trust-promotion` | Flips Trust Mode ON for ranchers who hit 5+ Closed Won or whose onboarding window has closed. Trust Mode enables full-volume warmup drain. | Ranchers | medium | live |
| `0 15 * * *` | `/api/cron/rancher-followup` | Monday-only (day guard): sends weekly lead-nudge email to ranchers with open referrals they haven't touched. | Ranchers, Referrals | high | live |
| `15 16 * * *` | `/api/cron/onboarding-stuck` | Detects ranchers stuck in onboarding (Call Complete, Docs Sent, or Signed but not Page Live) and sends day-3/7/14 nudge emails. After day 14: Telegram ping to admin for manual outreach. | Ranchers | high | live |
| `30 16 * * *` | `/api/cron/re-warm-cohort` | Resets buyers who received warmup but never clicked YES back into the warmup sequence so they can be re-engaged. | Consumers | high | live |
| `0 16 * * *` | `/api/cron/email-sequences` | Main buyer email engine — branches on Routing Segment, sends segment-appropriate email to each buyer (MATCH_NOW rescue, warmup nudge, founder pitch, state waitlist letter, closed letter, repeat-ask). | Consumers, Ranchers | high | live |
| `0 16 * * *` | `/api/cron/commission-invoices` | 1st-of-month guard: sends monthly commission invoices to ranchers with unpaid commissions. Daily no-op otherwise. | Ranchers, Referrals | high | live |
| `30 17 * * *` | `/api/cron/rancher-onboarding-drip` | 3-touch drip for self-submitted ranchers: Day 2, Day 5, Day 14 since welcome email. Stops after Day 14. | Ranchers | medium | live |
| `10 17 * * *` | `/api/cron/awaiting-payment-nudge` | Pings ranchers with referrals stuck >14 days in Awaiting Payment — prompts confirm or mark lost. | Ranchers, Referrals | high | live |
| `15 17 * * *` | `/api/cron/close-detector` | Scans referrals stuck 7+ days in active statuses, posts one-tap "Did this close?" card to Telegram for Ben to confirm | Referrals | high | live |
| `0 17 * * *` | `/api/cron/referral-chasup` | Chase-up on open referrals: nudge ranchers at 3/7/14 days, AI-drafts follow-up language, sends repeat-purchase asks to recent closed buyers. | Referrals, Consumers | high | live |
| `0 18 * * *` | `/api/cron/buyer-pulse` | Emails buyers in Intro Sent >5 days with 3-button "did your rancher contact you?" check-in. Buyer's answer is recorded + Telegrams Ben to rescue ghosted leads. | Referrals, Consumers | high | live |
| `0 14 * * 6` (weekly Sat) | `/api/cron/spam-audit` | Weekly (Saturday): pulls 7 days of Email Sends, counts per-recipient volume, surfaces anyone who got >10 emails in the window → Telegram report for Ben to investigate. | Email Sends | negative | live |

---

## 4. Email Templates

Source: `lib/email.ts`. ~50 named `sendX()` helpers. "Bypasses cap?" = listed in `TRANSACTIONAL_WHITELIST` in `lib/emailFrequencyGuard.ts`.

| Function | Trigger | Recipient | Frequency | Revenue tier | Bypasses cap? |
|---|---|---|---|---|---|
| `sendConsumerConfirmation` | Buyer signup via `/api/consumers` | Buyer | Once | medium | no |
| `sendConsumerApproval` | batch-approve cron or admin manual | Buyer | Once | high | yes |
| `sendWelcomeAndReadyToBuy` | batch-approve (hot lead path) | Buyer | Once | high | no |
| `sendFounderLetterWaiting` | email-sequences (COMMUNITY_NURTURE) | Buyer | Monthly | medium | no |
| `sendMatchedDay4CheckIn` | email-sequences (MATCHED stage) | Buyer | Once per match | high | yes |
| `sendPostPurchaseWelcome` | email-sequences (CLOSED stage) | Buyer | Once per close | high | no |
| `sendCutsEducation` | email-sequences (post-approval nurture) | Buyer | Once | medium | no |
| `sendClosedMonthlyLetter` | email-sequences (TERMINAL/CLOSED) | Buyer | Monthly | low | no |
| `sendRepeatPurchaseAsk` | referral-chasup (post-close) | Buyer | Once per close | high | no |
| `sendBuyerIntroNotification` | matching/suggest — buyer intro to rancher | Buyer | Once per referral | high | yes |
| `sendRancherApproval` | batch-approve cron | Rancher | Once | high | yes |
| `sendRancherGoLiveEmail` | admin go-live or batch-approve | Rancher | Once | high | yes |
| `sendPilotUpsellEmail` | rancher closes pilot goal or admin trigger | Rancher | Once | high | yes |
| `sendPartnerConfirmation` | `/api/partners` signup | Rancher prospect | Once | medium | no |
| `sendBrandApprovalWithPayment` | admin brand approval | Brand | Once | medium | no |
| `sendBrandListingConfirmation` | Stripe checkout.session.completed (brand) | Brand | Once | medium | no |
| `sendFoundingHerdWelcome` | Stripe checkout.session.completed (founders) | Founder backer | Once | high | yes |
| `sendAffiliateLoginLink` | `/api/auth/affiliate/login` | Affiliate | Per login | zero | no |
| `sendAffiliateInvite` | admin send-invite | Affiliate | Once | medium | no |
| `sendAffiliateWelcome` | admin onboard affiliate | Affiliate | Once | medium | no |
| `sendAdminAlert` | signup, hot-lead, error events | Ben (admin) | Triggered | zero | no |
| `sendInquiryToRancher` | `/api/land/[id]/inquire` — land inquiry | Rancher | Per inquiry | medium | yes |
| `sendInquiryAlertToAdmin` | `/api/land/[id]/inquire` | Ben (admin) | Per inquiry | zero | no |
| `sendBroadcastEmail` | broadcast cron / admin tool | Any segment | Per campaign | high | no |
| `sendMerchEmail` | admin `send-merch` | Buyer | Once | low | no |
| `sendWaitlistEmail` | batch-approve (state not covered) | Buyer | Once | low | no |
| `sendRancherLeadNudge` | rancher-followup cron (Monday) | Rancher | Weekly | high | no |
| `sendRepeatPurchaseEmail` | referral-chasup (closed buyers) | Buyer | Cadenced | high | no |
| `sendBackfillEmail` | backfill campaign tool | Old lead | Per campaign | medium | no |
| `sendRancherCheckIn` | `/rancher/checkin-response` flow | Rancher | Triggered | medium | no |
| `sendPipelineUpdateEmail` | referral status change | Rancher | Per update | high | no |
| `sendTrackedContactEmail` | `/ranchers/[slug]/contact` form | Rancher | Per inquiry | medium | no |
| `sendInstantCommissionInvoice` | referral Closed Won | Rancher | Per close | high | yes |
| `sendMonthlyCommissionInvoice` | commission-invoices cron (1st of month) | Rancher | Monthly | high | no |
| `sendRancherLaunchWarmup` | rancher-launch-warmup cron (phase 1) | Buyer | Once per warmup | high | no |
| `sendRancherLaunchWarmupNudge` | rancher-launch-warmup cron (day-7 nudge) | Buyer | Once | high | no |
| `sendRancherLeadReminder` | referral-chasup (open referral reminder) | Rancher | Cadenced | high | no |
| `sendAbandonedRecoveryEmail` | email-sequences (abandoned signup) | Partial signup | Cadenced | medium | no |
| `sendRerouteNotification` | referral reassignment | Rancher | Per reroute | medium | no |
| `sendProspectClaimMagicLink` | `/ranchers/[slug]/claim` | Rancher prospect | Once | medium | yes |
| `sendRancherSelfSubmitWelcome` | `/api/prospects/self-submit` | Rancher | Once | medium | yes |
| `sendRancherCommunityIntro` | `/api/prospects/self-submit` (community path) | Rancher | Once | low | no |
| `sendRancherOnboardingDripDay2` | rancher-onboarding-drip cron | Rancher | Once | medium | no |
| `sendRancherOnboardingDripDay5` | rancher-onboarding-drip cron | Rancher | Once | medium | no |
| `sendRancherOnboardingDripDay14` | rancher-onboarding-drip cron | Rancher | Once | medium | no |
| `sendMatchNowRescue` | email-sequences (MATCH_NOW segment) | Buyer | Per cycle | high | no |
| `sendNudgeToEngage` | email-sequences (NUDGE_TO_ENGAGE) | Buyer | Per cycle | high | no |
| `sendWarmLeadReadyCheck` | email-sequences (WARM_LEAD) | Buyer | Bi-weekly | high | no |
| `sendIncompleteProfileAsk` | email-sequences (INCOMPLETE_PROFILE) | Buyer | Per cycle | medium | no |
| `sendNoBudgetFounderPitch` | email-sequences (NO_BUDGET_FOUNDER_PITCH) | Buyer | Per cycle | medium | no |
| `sendStateWaitlistLetter` | email-sequences (STATE_WAITLIST) | Buyer | Monthly | low | no |

---

## 5. Airtable Tables

Source: `TABLES` const in `lib/airtable.ts`. Single Airtable base (`AIRTABLE_BASE_ID`).

| Table | Purpose | Key fields | Read by | Written by | Retention |
|---|---|---|---|---|---|
| `Consumers` | All buyer records — signups, status, routing segment, suppression flags | Email, State, Buyer Stage, Routing Segment, Ready to Buy, Warmup Sent At, Unsubscribed, Bounced, Sequence Stage | matching/suggest, email-sequences, batch-approve, admin dashboard, Telegram | /api/consumers, batch-approve, member/ready-to-buy, Telegram commands | Permanent |
| `Ranchers` | All rancher records — onboarding state, capacity, served states, page content | Email, Onboarding Status, Page Live, Served States, Max Active Referrals, Current Active Referrals, Trust Mode, Agreement Signed | matching/suggest, rancher dashboard, admin dashboard | rancher/setup, rancher/landing-page, admin/ranchers, batch-approve, Telegram | Permanent |
| `Referrals` | Buyer-rancher intro records — the core revenue unit | Consumer (linked), Rancher (linked), Status, Sale Amount, Commission, Commission Paid | rancher dashboard, close-detector, referral-chasup, admin/referrals | matching/suggest, rancher/referrals/[id], admin/referrals, Telegram | Permanent |
| `Brands` | Brand partner listings | Brand Name, Tier, Payment Status, Logo URL, Active | admin/brands, public brand pages | /api/webhooks/stripe, admin/brands/[id] | Permanent |
| `Land Deals` | Land-for-sale listings | Seller Name, Acres, Price, State, Status, Approved | /api/public/land, /land page | admin/landDeals, | Permanent |
| `News` | Blog / news posts | Title, Slug, Content (HTML), Status, Published At | /news page, /api/news | admin (news POST) | Permanent |
| `Inquiries` | Land deal inquiries | Consumer linked, Rancher linked, Message, Interest Type, Status | admin/inquiries | /api/land/[id]/inquire, /api/inquiries | Permanent |
| `Campaigns` | Scheduled and sent broadcast email campaigns | Audience Type, Subject, Body, Send At, Status, Sent Count | send-scheduled cron, admin/broadcast | admin/broadcast, Telegram /blast | Permanent |
| `Referrals` / `Affiliates` | Affiliate program records — codes, clicks, conversions | Email, Referral Code, Clicks, Signups, Commission Rate, Active | affiliate/dashboard, admin/affiliates | admin/affiliates, /api/affiliates/track-click | Permanent |
| `Conversations` | Inbound email reply log — AI-classified, sentiment-tagged | Thread ID, Referral linked, Body, Classification, Sentiment, Proposed Action | resend-inbound webhook, admin (future) | /api/webhooks/resend-inbound | Permanent |
| `Cron Runs` | Audit trail of every cron execution — status, records touched, notes | Cron Path, Status, Records Touched, Notes, Created At | /admin/health, Telegram /cronstatus | `withCronRun()` wrapper (all crons) | 90 days suggested |
| `Cron Pauses` | List of cron paths/template names that are currently paused | Name, Paused At, Paused By | email-sequences, `checkFrequencyCap` | Telegram /pausecron, /resumecron, /pausemail, /resumemail | Active only |
| `Email Sends` | Log of every email sent through the guarded send path | Recipient Email, Template Name, Sent At | spam-audit cron, `checkFrequencyCap` | `guardedSend()` wrapper (all email helpers) | Rolling 30 days |

---

## 6. Routing Logic Summary

### Buyer Journey: Signup → Match → Close

```
[/access form]
    → POST /api/consumers
    → sendConsumerConfirmation (buyer)
    → sendAdminAlert (Ben)
    ↓
[batch-approve cron, 09:00 UTC]
    → isQualifiedForRouting? (has order type + budget)
    → hasOperationalRancherForState?
        YES → sendConsumerApproval → Buyer Stage = APPROVED → triggerLaunchWarmup
        NO  → sendWaitlistEmail → Buyer Stage = WAITING
    ↓
[rancher-launch-warmup cron, 13:30 UTC]
    → buyer in newly-covered state + Warmup Sent At is null
    → sendRancherLaunchWarmup
    → buyer clicks YES → GET /api/warmup/engage
    → firstweek gate check → if passes: POST /api/matching/suggest
    ↓
[matching/suggest]
    → find best operational rancher in buyer's state (capacity-aware)
    → create Referral record (Intro Sent)
    → sendBuyerIntroNotification (buyer intro email)
    → sendEmail to rancher
    → redirect buyer to /matched
    ↓
[referral-chasup + close-detector + buyer-pulse crons]
    → chase rancher if no movement 3/7/14 days
    → one-tap close card to Ben in Telegram
    → buyer pulse: "did rancher contact you?"
    ↓
[rancher confirms close in dashboard or via /api/rancher/quick-action]
    → Referral Status = Closed Won
    → sendInstantCommissionInvoice (rancher)
    → update capacity counter
    → commission-invoices cron on 1st bills monthly invoice
```

### Routing Segment Classifier (`lib/routingSegment.ts`)

The `reclassify-buyers` cron runs at 04:00 UTC nightly and writes one of 9 segment values to each Consumer. The `email-sequences` cron (16:00 UTC) branches on this field.

| Segment | Condition | Email sent by email-sequences |
|---|---|---|
| `TERMINAL` | Buyer Stage = CLOSED | Closed monthly letter |
| `UNQUALIFIED_NURTURE` | Unsubscribed, Bounced, Complained, or Non-Responsive | No email (suppressed) |
| `INCOMPLETE_PROFILE` | Missing Order Type or Budget | `sendIncompleteProfileAsk` |
| `COMMUNITY_NURTURE` | Budget = "Just exploring" | `sendFounderLetterWaiting` (monthly) |
| `NO_BUDGET_FOUNDER_PITCH` | Budget = `<$500` or `>$500` | `sendNoBudgetFounderPitch` |
| `MATCH_NOW` | Covered state + Ready to Buy = true | `sendMatchNowRescue` (triggers `/api/matching/suggest`) |
| `WARM_LEAD` | Covered state + Warmup Engaged At set | `sendWarmLeadReadyCheck` (bi-weekly) |
| `NUDGE_TO_ENGAGE` | Covered state, qualified, no engagement | `sendNudgeToEngage` |
| `STATE_WAITLIST` | Uncovered state, qualified budget | `sendStateWaitlistLetter` (monthly) |

**Key constraint:** Rancher time is scarce. Only `MATCH_NOW` buyers (explicit R2B = true) get an intro. This protects close rate and prevents low-quality lead noise for ranchers.

---

## 7. Telegram Commands

All commands handled in `app/api/webhooks/telegram/route.ts`. Sent to the admin chat (`TELEGRAM_ADMIN_CHAT_ID`).

### Read commands (no mutation)

| Command | What it does |
|---|---|
| `/start` | Welcome message + command list |
| `/pending` | Lists consumers awaiting approval |
| `/stats` | Platform KPI snapshot — buyers, ranchers, closes, revenue |
| `/revenue` | Revenue summary — commissions, Founding Herd, brands |
| `/pipeline` | Open referral pipeline — status breakdown |
| `/today` | Today's action items (same as `/admin/today`) |
| `/morning` | Morning brief — digest of overnight activity + AI summary |
| `/scout` | Lists buyers in states with no active rancher (expansion targets) |
| `/stuckbuyers` | Buyers stuck in READY/MATCHED with no recent movement |
| `/stuckranchers` | Ranchers who haven't responded to a lead in N days |
| `/ghostranchers` | Ranchers with no close in 30+ days |
| `/rancherpipeline` / `/rp` | Per-rancher referral status summary |
| `/status` | Cron + system health status |
| `/cronstatus` / `/runs` | Last Cron Runs entries per cron path |
| `/routingstatus` / `/segments` | Routing Segment distribution across all buyers |
| `/brief` | AI-generated tactical brief for the day |
| `/qualify` | Lists buyers who need qualification follow-up |
| `/capacity [slug]` | Shows rancher capacity (current / max) |
| `/lookup` / `/find` / `/buyer [query]` | Fuzzy search across consumers + ranchers |
| `/ask [question]` | AI Q&A against live platform data |
| `/freqcap show` / `/freqcap` | Shows current email frequency cap setting |
| `/templatestats` | Email send counts by template for past 7 days |
| `/whatfired [email]` | Shows last N emails sent to a given address |
| `/emaillog [email]` | Full email send history for an address |

### Do commands (mutation)

| Command | What it does |
|---|---|
| `/chasup` | Manually fires referral chase-up sequence now |
| `/blitz` | Sends pipeline update email to all ranchers with open referrals |
| `/bulkonboard` | Triggers onboarding email for all ranchers with Onboarding Status = pending |
| `/bulkfire` | Clears Pending Approval backlog — bulk-approves and routes |
| `/checkin` | Sends check-in messages to ranchers who haven't responded |
| `/match [buyer]` | Fuzzy-match a buyer to the best available rancher, with inline confirm card |
| `/forcematch [buyer] [rancher]` | Direct match: routes buyer to a specific rancher (bypasses ranking) |
| `/routestate [state] [rancher-slug]` | Bulk-routes all stuck buyers in a state to a specific rancher |
| `/comp [email]` | Creates complimentary Founding Herd membership for a given email |
| `/makeaffiliate [email]` | Creates an affiliate account for a given email |
| `/setuppage [rancher-slug]` | Sends rancher setup wizard email to a rancher by slug |
| `/casestudy [referral-id]` | AI-drafts a case study from a closed referral |
| `/broadcast [query]` | Starts a broadcast email draft flow |
| `/pause [cron]` | Pauses a specific cron (records in Cron Pauses table) |
| `/resume [cron]` | Resumes a paused cron |
| `/blast [audience]` | Sends a quick one-line blast to a buyer/rancher segment |

### Email commands (observability + control)

| Command | What it does |
|---|---|
| `/pausemail [template]` | Pauses a named email template via Cron Pauses |
| `/resumemail [template]` | Resumes a paused email template |
| `/pausecron [path]` | Pauses an entire cron path |
| `/resumecron [path]` | Resumes a paused cron path |
| `/draft [email]` | AI-drafts a custom follow-up to a specific recipient |

### System commands

| Command | What it does |
|---|---|
| `/help` | Full command reference list |

---

## 8. Revenue Engines + Streams

### Active Engines (Stage 3+)

| Engine | Status | Implementation | Notes | Tier |
|---|---|---|---|---|
| **Engine 1: Marketplace Commission** | LIVE | `lib/stripe-commission.ts`, `sendInstantCommissionInvoice` | 10% of closed deal. Rancher pays. ~$120 avg per close. Legacy model for pre-Stage-3 ranchers. | high |
| **Engine 2: Subscription Tiers** | LIVE | `lib/tiers.ts`, `app/api/rancher/tier/*` | Pasture/Ranch/Operator tiers. High-monthly / low-commission model incentivizes rancher commitment. Stage 3 new ranchers. | high |
| **Engine 3: Founding Herd** | LIVE | `app/api/founders/checkout`, Stripe Payment Links | 5-tier backer program ($9-$15k). Cap: 100 × $1k + 10 × $15k = $250k. | high |
| **Engine 4: Payments Platform** | LIVE (gated) | `lib/stripeConnect.ts`, `STRIPE_CONNECT_ENABLED` | Stripe Connect auto-split: rancher 90%, BHC 10%. Disabled on prod until first tier_v2 rancher onboards. | high |
| **Marketing Services** | **DEFERRED** | None | Documented in BUSINESS-MODEL.md (Engine 4 there, before renumbering). No API endpoint, no Stripe product, no Airtable contract table. Decision: launch first 100 paying ranchers on Engines 1-4 only. Reassess Q3 2026 once tier_v2 stable. | medium |

### Secondary Streams (Bundled / Lower Priority)

| Stream | Status | Mechanics | Surfaces | Tier |
|---|---|---|---|---|
| **Brand Partners** | LIVE | Brands pay for logo placement + marketing bundle. Manual fulfillment. | `/brand-partners` page, Stripe checkout, `sendBrandListingConfirmation` | medium |
| **Content Sponsorships** | Future | Sponsored placements in newsletter + platform. Currently bundled with Brand Partner tiers. | Brand partner tiers, email list | low |
| **Course / Info Product** | Future | Educational beef-buying content. No live surface. Buyer list is the asset. | `/member` (future module) | low |

---

## 9. Known Issues + Deprecated Surfaces

These are issues identified in `docs/AUDIT-INVENTORY.md` (generated 2026-05-20, 232 findings). Select critical items relevant to contractor onboarding:

### Security (unresolved as of 2026-05-24)

| Issue | File | Severity |
|---|---|---|
| Telegram webhook has no signature verification — anyone can POST forged callback_query | `app/api/webhooks/telegram/route.ts:379` | critical |
| No update_id idempotency → Telegram redelivers on 5xx → double invoices / double intros | `app/api/webhooks/telegram/route.ts:379-400` | critical |
| ManyChat webhook fails open when `MANYCHAT_WEBHOOK_SECRET` unset | `app/api/webhooks/manychat/route.ts:68-86` | critical |
| Cal.com webhook fails open when `CAL_WEBHOOK_SECRET` unset | `app/api/webhooks/cal/route.ts:31-35` | critical |
| `prospects/remove` is a zero-auth public DELETE — any slug can be wiped | `app/api/prospects/remove/route.ts:32-101` | critical |
| `prospects/claim` magic link is GET-based → email scanner prefetch auto-claims | `app/api/prospects/claim/route.ts:165-227` | critical |
| Admin cookie is literal `"authenticated"` string — unsigned, no expiry | `lib/adminAuth.ts:24` | critical |

### Functional (unresolved)

| Issue | File | Severity |
|---|---|---|
| `dangerouslySetInnerHTML` on Airtable content on news post pages — XSS surface | `app/news/[slug]/page.tsx:102` | critical |
| Capacity counter race condition on concurrent pass/close actions | `app/api/rancher/referrals/[id]/route.ts:115-128` | critical |
| Member dashboard: matched rancher silently disappears if rancher not `Certified=true` | `app/member/page.tsx:266-278` | important |
| `/matched` defaults to "your rancher" on direct URL hit (no rancher param) | `app/matched/page.tsx:33-35` | important |

### Deprecated / One-Time Endpoints (safe to ignore)

These were one-time migration scripts. They're still deployed but only run once manually:
- `GET /api/admin/backfill-states` — state normalization migration (already ran)
- `GET /api/admin/setup-ai-fields` — Airtable schema setup (already ran)
- `GET /api/admin/setup-rancher-page-fields` — Airtable schema setup (already ran)
- `GET /api/maintenance-backfill-segment` — Consumer segment backfill (already ran)
- `POST /api/maintenance-resurrect-orphans` — Orphaned referral reset (already ran)

These can be removed in a cleanup PR without breaking anything.

### Cron Scheduling Note

Vercel Hobby tier silently dropped day-of-week cron schedules (`0 9 * * 1`). All crons that previously used day-of-week schedules were converted to daily schedules with a date/day-of-week guard inside the handler. Do not add `DayOfWeek` syntax to cron schedules in `vercel.json` unless you are on a paid Vercel plan.
