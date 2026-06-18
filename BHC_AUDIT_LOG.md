# BHC Daily Audit & Fix Log

> **What this file is.** A rolling, append-only journal of every audit run, every auto-fix applied, every decision deferred to Ben, and every pattern we've learned about how the business actually flows. It is the single source of truth for "what state are we in?" between Claude Code sessions.
>
> **Read this file BEFORE any fix, audit, or admin action against BHC.** Update it AFTER any change. Never silently act on something the log says Ben previously rejected — re-check or ask.

---

## How to use this file

Every Claude Code session that touches BHC data must:

1. **Read the "Decisions & Standing Rules" section first** — this is the law.
2. **Read the most recent "Run" entries** to understand what's already been tried, what's pending Ben's call, and what patterns are emerging.
3. **Append a new "Run" entry** at the top of the Runs log when finished. Use the template below.
4. **If you propose a new standing rule** (e.g. "always auto-close X when Y"), add it to "Proposed Rules — Awaiting Approval" and stop. Don't promote rules to standing without Ben's explicit yes.
5. **If a fact in this file is now wrong** (rancher status changed, a "needs approval" item got resolved), update or strike it through with a date.

---

## Decisions & Standing Rules

### SAFE to auto-fix without asking
- **Capacity counter drift**: recompute `Current Active Referrals` from actual count when the rancher's `Active Status = Active` and the delta is unambiguous.
- **Active refs on suppressed buyers** (unsubscribed/bounced/complained): close as `Closed Lost`, set `Closed At`, append `[Auto-closed YYYY-MM-DDTHH:MM:SSZ: buyer suppressed (...) — closing inactive referral]` to `Notes`. Decrement rancher counter if the ref had a Rancher link.
- **Active refs on `Buyer Health = Non-Responsive` buyers** that are stale (>10d on Intro Sent, >14d on Rancher Contacted): same close-as-Lost pattern, reason `auto-closed: non-responsive buyer`.
- **Stale `Suggested Rancher Name` cache** ONLY when `Rancher` and `Suggested Rancher` link to the same record AND the cached text doesn't match either Operator Name or Ranch Name of that record. Refresh to live Operator Name.

### NEEDS Ben's approval — flag, do NOT act
- Tier-mismatch active referrals (route them away)
- Pilot threshold reached but no upsell notification
- Underperforming rancher (0 closes in 30d, 5+ refs routed)
- Active rancher missing core fields (Slug / Page Live / Agreement Signed / States Served)
- Stalled referrals — DO NOT chase, the `referral-chasup` cron owns those
- Sending any email to ranchers or buyers
- Code-level bug fixes (describe + propose, then stop)

### Crons that own their lanes — do not double-fire
- `referral-chasup` — owns chase-up emails AND auto-close at MAX_CHASE_UPS=3
- `daily-digest` — owns the morning digest
- `compliance-reminders` — owns processor-receipt nags
- `email-sequences` — owns buyer drip
- `commission-invoices` — owns rancher payouts
- `rancher-launch-warmup` — owns new-rancher onboarding emails
- `nightly-rancher-audit` — owns the nightly per-rancher Telegram digest (we extend this, we don't replace)

### Environment quirks to remember
- `CRON_SECRET` contains `+` and `/`; URL-encode it before passing as `?secret=`. Otherwise `https://buyhalfcow.com` redirects to `www.` and the encoded chars get dropped → 401.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_CHAT_ID` live ONLY in Vercel env, NOT in local `.env.local`. To send a Telegram message from a local node script, you'd need to fetch them from Vercel; otherwise summarize in the response and let the deployed cron's own digest do the Telegram delivery.
- The Joseph & Jamie Hewitson rancher record's `Operator Name` has a **trailing space**: `"Joseph & Jamie Hewitson "`. This is the canonical value; don't strip it.
- Airtable rate limit: lib/airtable.ts already wraps writes in `withRateLimitRetry`; one-off scripts in /tmp should batch sequentially, not in parallel.

---

## Patterns we've learned

*(Add to this section when a recurring shape becomes clear across 2+ runs.)*

- **Suppressed-buyer refs accumulate slowly.** Expect 3–8 per week as buyers unsubscribe. Auto-close cleanly, no need to flag.
- **Cached `Suggested Rancher Name` drifts when an Operator Name is edited in the Ranchers table.** The cache on referrals doesn't auto-update. We refresh in bulk.
- **Ace Hartsock has a structural close-rate problem.** 41 routed, 0 won as of 2026-04-29. Issue is not data — it's relationship/process. Don't keep flagging him as a fresh issue every night; track closure progress over weeks.
- **E2E test buyer records persist in production data.** Names like "E2E Beef TX", "E2E Test Beef TX", "E2E Beef Unqualified" — they look like real referrals to the audit. Safe to close as Lost on sight (Notes contain `[E2E TEST — safe to delete]`).

## Proposed Rules — Awaiting Approval

*(Add proposed standing rules here. Ben must explicitly approve before they move to "Standing Rules". Dated; kept in append-only mode.)*

- **2026-04-29** — Should we expand auto-close-Lost to **also** delete the buyer record when `Notes` contains `[E2E TEST — safe to delete]`? Currently we close the ref but leave the buyer + counter intact.
- **2026-04-29** — Should the audit's stale-cached-name check be patched to compare against `Suggested Rancher` (the cache's logical owner), not the resolved `Rancher`? See Bug #1 below. Code change in [app/api/cron/nightly-rancher-audit/route.ts:287](app/api/cron/nightly-rancher-audit/route.ts:287).

## Open Questions for Ben

- **Zach Knowles (TN)** — `Page Live = false` but 25 buyers actively routed. Flip Page Live, or pause routing to him?
- **Linda Anspach (OR)** — missing `Slug` AND `Page Live`, 6 fresh intros in 1 day. Set up landing page or pause?
- **Ace Hartsock (CO)** — capacity 33/20 (over-cap), 0 closes across 41 routed. Health-check call needed.
- **Terrell Johnson (GA)** — 22 lost / 0 won across 29 routed. Worth a check-in.

## Known Bugs (described, not patched)

1. **Stale-cached-name false-positive in nightly audit** ([app/api/cron/nightly-rancher-audit/route.ts:287](app/api/cron/nightly-rancher-audit/route.ts:287)). When a ref has been rerouted (`Rancher` ≠ `Suggested Rancher`), the audit compares the cached `Suggested Rancher Name` against the resolved `Rancher` and reports it stale, even when the cache correctly tracks the original `Suggested Rancher`. False-positive seen on `rec74U3D5NlPE7iOK` (Jen Roddy).

---

## Runs Log

### Template (copy this for each run)

```
### Run YYYY-MM-DD HH:MM TZ — <one-line title>
- **Trigger**: scheduled / manual / on-demand by Ben
- **Audit input**: critical=N, warn=N, info=N · activeRefs=N · activeRanchers=N
- **Funnel snapshot** (if computed): visitors→form / form→qualified / qualified→routed / routed→contacted / contacted→won
- **Auto-fixes applied** (with refIds):
  - …
- **Counter writes**:
  - …
- **Deferred to Ben** (with reasoning):
  - …
- **Bugs observed (code, not data)**:
  - …
- **Patterns observed** (candidates for "Patterns we've learned"):
  - …
- **Followups for next run**:
  - …
```

---

### Run 2026-06-13 — buyer funnel + quiz conversion audit & repair
- **Trigger**: manual, by Ben ("why aren't people getting through the gamified quiz to a qualified lead — assure everything works")
- **Method**: code trace /access → /api/consumers → /qualify → /api/qualify; live Airtable aggregation (2,060 consumers); Granola checked (no relevant meetings).
- **Funnel reality (last 30d, from Airtable):** 586 records · 466 real signups · Segment 183 Beef Buyer / 283 Community · reached quiz ~129 (~28%) · **passed quiz → qualified lead 46 (9.9%)** · matched any path 17 (3.6%). Quiz mechanically healthy (most recent pass today).
- **Root causes (3 leaks, ranked):**
  1. **🔴 "now" timing bug.** /access highest-intent option submits literal `"now"`; `/api/consumers` + `/api/qualify` only recognize `"Within 30 days"`/`"1-3 months"`. Unmapped → 0 intent → `highIntentTiming=false` → Order Type blank → segment `Community` → quiz-redirect gate (`Beef Buyer` only) never fires. **Proof: 47/47 `"now"` signups landed Community, 0 Beef Buyer** — hottest cohort was the ONLY one auto-disqualified. NOTE: this is the same surface as the PM-4 "/access CRO rework" — that pass added the high-intent default-Half logic but missed that the form value `"now"` never matches the gate string.
  2. **🔴 Quiz had no email entry.** Reachable ONLY via the post-signup client redirect (Beef Buyer + in-state rancher), and that branch sent NO email. Welcome email's only CTA → `/api/warmup/engage` (direct match), never `/qualify`. Out-of-state + dropped redirect = never see the quiz.
  3. **🟡 64% quiz abandonment.** Single-select questions required tap-answer THEN tap-Next (2× cost). abandoned-quiz-nudge recovered 2/83 — cron is HEALTHY (fresh 14d token); low recovery is a symptom of leaks 1+2 + nudging low-intent tire-kickers, not a cron bug.
- **Fixes applied (tsc + next build clean; quiz auto-advance screenshot-verified on localhost):**
  - [app/api/consumers/route.ts](app/api/consumers/route.ts) — normalize `timing "now" → "Within 30 days"` at destructure (fixes leak 1 for future signups; not retroactive).
  - [app/qualify/[consumerId]/page.tsx](app/qualify/[consumerId]/page.tsx) — `selectAndAdvance()` auto-advances steps 0-2 with a `from===s` guard against double-skip; ack stays manual (fixes leak 3).
  - [lib/email.ts](lib/email.ts) — new `sendQuizInvite()` wired into `redirectToQualify` as a fire-and-forget backup so a dropped redirect isn't a dead end (fixes leak 2 reliability gap).
- **NOT changed / deferred:** nudge cron (healthy — could later target only quiz-reachers + stop re-nudging sub-75 scorers); quiz pass threshold 75 (intentional); out-of-state → waitlist (intentional, no rancher to route to).
- **Followups:** after deploy re-pull 30d funnel — expect `"now"` cohort → Beef Buyer and quiz-completion % to rise; watch `Qualification Score` fill-rate + nudge volume. Working tree carries these funnel fixes + the earlier frontend sweep — Ben to review/commit.

### Run 2026-06-12 (PM-5) — rancher pages perfection (setup → portal → public)
- **Trigger**: manual, by Ben ("make the rancher pages perfect" → all three surfaces)
- **Method**: 3 parallel read-only audits (public landing / portal / setup wizard) → fixed by impact wave. Verified: tsc clean, `next build` clean, adversarial diff review (cavecrew-reviewer) = zero findings. Public-page date change browser-verified earlier; portal/setup are auth-gated UI (verified by build + review). NOT yet committed at time of writing this line.
- **Wave 1 — cashflow + buyer conversion**:
  - **Setup: Stripe Connect skip is now a two-step warning** ([StripeConnectStep.tsx](app/rancher/setup/steps/StripeConnectStep.tsx)). Was a one-tap "Skip for now" → tier_v2 rancher went live with Connect='onboarding' → every buyer deposit 409'd at checkout (silent revenue hole). Now first tap reveals an amber consequence panel ("buyers can't pay deposits"), second tap confirms. No native confirm().
  - **Setup: money-field validation** ([api/rancher/setup/route.ts](app/api/rancher/setup/route.ts)). The setup PATCH coerced prices/deposits/fees/lbs as raw strings with ZERO validation — a negative or non-numeric price published broken pricing + fed bad deposit math. Added the same numeric+non-negative gate the landing-page editor route already had (0 allowed; empty→null).
  - **Public: processing-date hardened** ([ranchers/[slug]/page.tsx](app/ranchers/[slug]/page.tsx)). Twice-flagged "UTC bug" was a FALSE POSITIVE for date-only `<input type="date">` values (timeZone:'UTC' renders them faithfully). But it silently shifts a day if a record ever holds a datetime. New `formatProcessingDate()` formats the YYYY-MM-DD calendar parts directly → correct in every timezone, datetime fallback retained. Covers both render sites.
  - **Public: prospect pages now `robots: noindex`** — unclaimed auto-generated listings were indexable (thin/stale SEO). Claimed verified pages stay indexable.
  - **Public: deleted dead `RancherLeadModal.tsx`** — orphaned (self-reference only), posted to a different endpoint than the live OrderForm. Removed to kill the two-funnels confusion.
- **Wave 2 — portal manage surface**:
  - **Accept-slot `window.confirm` → branded modal** ([rancher/page.tsx](app/rancher/page.tsx)). The deposit-becomes-non-refundable moment rendered as a tiny mobile-Safari popup; now an amber-warning modal matching the lost/close/invoice modal pattern. New `acceptModal` state + `handleAcceptSlot` opener; both call sites repointed.
  - **`acceptReferral` no longer refetches after a failed write** (early-return) — audited all 5 money-mutation handlers; it was the only remaining refetch-on-failure (markLost/closeDeal/passOnLead already correct). Companion to the updateReferralStatus fix in PM-1.
  - Skipped `min="0"` input churn — no native form submit to enforce it; server gate is the real guarantee.
- **Wave 3 — setup polish**:
  - **`activate` auto-slug is now collision-safe** ([api/rancher/activate/route.ts](app/api/rancher/activate/route.ts)). Two ranchers with the same Ranch Name both kebab'd to one slug → `getRancherBySlug` returns whichever Airtable lists first → second rancher's page + direct traffic silently routed to the first. Now appends -2/-3/… until free (excludes own record), id-suffix fallback on lookup failure. NOTE: the landing-page editor route ALREADY had a 409 uniqueness check — the audit's "no uniqueness check" was scoped to the setup route (which doesn't write Slug). Only the activate auto-gen path was unguarded.
- **Audited, NOT changed (intentional)**:
  - LivePreview vs public page drift — preview is approximate by design (can't render live gallery/reviews/testimonials); informational only.
  - Onboarding video placeholder — content (Ben films it), not code.
  - `handleReviveLead` window.prompt + `confirmUpgrade` window.confirm — admin-only / one-time low-traffic; left for a later pass.

---

### Run 2026-06-12 (PM-4) — /access CRO rework (perfect-funnel pass)
- **Trigger**: manual, by Ben ("/access needs audit + rework so it flows like a perfect funnel")
- **Method**: signup-flow-cro skill audit → rework. Verified: `tsc` clean, `next build` clean, live preview-tested (field order, coverage hint, typo suggestion, layout order all confirmed in browser + screenshot). NOT committed.
- **Restructure (the big one)**: form moved to directly under the hero — it sat below ~2 screens of video slot + stats + testimonials + ranch cards. High-intent traffic (ads, /start, /r/ links) now hits the ask immediately; proof moved BELOW the form for skeptics; mobile sticky CTA unchanged (returns scrollers to the form).
- **Field order**: state → email → first name → household → timing → phone (was name/state/household/timing/email/phone).
  - State first → **instant coverage feedback** under the select: "✓ a verified rancher serves TX — finish below and we make the intro within hours" vs honest waitlist copy. Coverage set derived client-side from /api/public/ranchers (home state + states_served) — already being fetched for the ranch cards; renders nothing if the fetch fails (no false claims). Authoritative gate stays server-side.
  - Email second → the /api/abandoned-app blur capture now catches anyone who gets 2 fields in (was field 5 — most partials were lost).
- **Form mechanics**:
  - Submit button always enabled (was dead-disabled until valid — zero feedback on what's missing). Native required bubbles + focusField() scroll-to-error on format failures.
  - **Phone required-ness bug fixed**: label + native `required` attr were hardcoded, so the NEXT_PUBLIC_REQUIRE_PHONE=0 A/B override silently did nothing (browser still blocked submit). All three layers (label, attr, JS) now read one component-scope flag.
  - Email typo autocorrect: "did you mean ben@gmail.com?" one-tap fix for 17 common fat-finger domains — a typo'd email kills the entire downstream funnel (qualify link + welcome bounce).
  - Honeypot now enforced server-side: /api/consumers fake-succeeds on non-empty `website`; client includes the field in the payload (it previously dropped bots client-side only and never sent the field).
- **Proof block**: "0 deals closed this month" no longer renders (anti-proof) — third stat cell hides until count > 0, grid collapses to 2 cols. Off-canon amber-50/amber-200 → amber/10 + amber/30 tokens.
- **Success card**: added one-click "resend my quiz link" (POST /api/qualify/resend-link, enumeration-safe endpoint already existed) — the #1 post-signup dead end was "email never arrived" with only a mailto.
- **Preserved untouched**: all analytics (access_view, quiz_started, per-step G5 events, Meta event_id pairing), attribution (ref/rancher/campaign localStorage), affiliate thank-you card, exit-intent modal, time-gate bot check, TCPA SMS opt-in gating.

---

### Run 2026-06-12 (PM-3) — buyer funnel end-to-end verification (reads/writes/routes)
- **Trigger**: manual, by Ben ("make the customer funnel perfect... assure all reads writes and routes do what we intended")
- **Method**: bhc-flow-debug boundary map + two deep code scouts (client pages, API routes), every scout claim verified against source before acting. Verified: `tsc` clean, `next build` clean, /access + /matched render-checked on localhost. NOT committed.
- **Funnel verdict: structurally sound.** Continuity verified hop-by-hop (/start → /access → /qualify/[consumerId] → /matched | /checkout/[refId]/deposit → success → /member): no dead ends, no broken param passing, every page has loading/error/recovery states, all fetches point at routes that exist. Stripe webhook idempotency double-guarded (Stripe Events table + markDepositSucceeded). Capacity bump atomic via Redis INCR with 1.2× hard ceiling. PERFECT-G early-write of Qualified At confirmed in place (GUARD-2 cannot 412 on fresh quizzes).
- **Fixes applied (3 real findings)**:
  - **/api/orders/request missing operational gate** ([route.ts](app/api/orders/request/route.ts)) — a paused/past_due rancher's page still accepted orders: referral created, capacity bumped, both emails fired, rancher never responds (ghost lead). Now 409s with `fallbackToMatch:true` + quiz pointer, using the same canonical `isRancherOperationalForBuyers` as matching/reorder/warmup.
  - **/api/member/reorder cross-buyer routing hole** ([route.ts](app/api/member/reorder/route.ts)) — `rancherId` and `previousReferralId` from the request body were trusted unverified; any logged-in member could enumerate ids and route themselves to an arbitrary rancher **cap-free** (reorder uses the direct-page bypass). Both paths now validate ownership: explicit rancherId must appear in the buyer's own Closed Won history (403 otherwise), previousReferralId's Buyer Email must match the session email (403 otherwise).
  - **Dead 5 Bar Beef policy removed** from matching/suggest — deprecated no-op (always returned true, comment said "remove in separate PR"); function + helpers + call site deleted. Tier Specialty field owns this filter now.
- **Scout claims checked + rejected (already fixed or wrong — do NOT re-fix)**:
  - "INTERNAL_API_SECRET empty → matching/suggest open": wrong — `internalSecret && header===secret` guard means empty env falls through to requireAdmin.
  - "Intro Sent flip failure leaks capacity": wrong — full rollback + loud operator signal already shipped (matching/suggest ~L905).
  - "excludeRancherIds unused": wrong — feeds excludeIds set, consumed in candidate filter.
  - "Qualification Path should join the early write": intentional design — comment documents the two-phase write; Path is audit-only.
- **Deferred to Ben**:
  - **Redis-down capacity fallback** (matching/suggest + orders/request): falls back to race-prone Airtable read+1 when Upstash is unavailable. Kept fail-open ON PURPOSE (availability > strict caps for a lean operation) — flag if Upstash flakes become regular; the alternative is 503ing all matching during outages.
  - **SMS Opt-In At re-stamp on re-opt-in**: no Twilio inbound webhook exists in the codebase (only twilio-recording) — nothing to patch until SMS inbound lands. Note for TCPA evidence trail whenever that's built.
  - **Rancher email suppression not flagged on rancher record** — repeated silent intro failures to a suppressed rancher only show in Telegram; needs an Airtable field (schema change) if wanted.
  - **Two parallel intake funnels exist by design** (quiz flow vs rancher-page direct) — RancherLeadModal → /api/consumers → external pay link; RancherOrderForm → /api/orders/request → async rancher close. Documented here so nobody "unifies" them by accident.

---

### Run 2026-06-12 (PM-2) — admin surface overhaul (nav, tokens, seamless updates)
- **Trigger**: manual, by Ben ("make my admin routes perfect... immersive and seamless... connect and organize")
- **Scope**: all 16 /admin pages + layout + ⌘K palette. Verified: `tsc` clean, `next build` clean (all admin routes compile), /admin auth-redirect + login render checked on localhost. NOT committed.
- **IA / navigation**:
  - New single source of truth [app/admin/nav.ts](app/admin/nav.ts) — sidebar AND ⌘K palette render from one list. Regrouped: PIPELINE (Desk, Today, Referrals, Inquiries, Full Dashboard) / MONEY (Commissions, Payments, Compliance) / GROWTH (Broadcast, Affiliates, Analytics, Funnel, Heatmap) / SYSTEM (Health, Backfill, Migration). Previously: Payments, Health, Migration unreachable from sidebar; palette missed 6 pages.
  - **Desk (/admin/today/v2) promoted to canonical home** — brand links + first nav item. It was unlinked from nav entirely despite being the newest cockpit (dac52b2).
  - Longest-prefix active matching — /admin/today/v2 highlights Desk not Today; detail pages fall through to Full Dashboard.
- **Design canon**: admin is now 100% token-clean. Swept ~860 bracketed-hex instances (#0E0E0E→charcoal, #F4F1EC→bone, #6B4F3F→saddle, #A7A29A→dust, #8C2F2F→weathered, #2A2A2A→divider, #D97757→rust) + ~300 default-Tailwind palette classes (green→sage, red→weathered, yellow/amber/orange→amber, gray→dust/saddle, blue→dust/saddle as info, purple/indigo→saddle) across all admin files. Zero hex / zero default-palette classes remain under app/admin. NOTE: macOS BSD sed silently no-ops on `\b` — first sweep attempt did nothing; verify with grep after any sed sweep.
- **Seamless updates (mutation→UI)**:
  - Full Dashboard ([app/admin/page.tsx](app/admin/page.tsx)): 10 mutation handlers never checked `res.ok` — 4xx/5xx showed success + refetched (silent failures). All now check, toast the server error, and skip the refetch. Impersonate flow: window.confirm/alert → branded confirmAction modal + toast.
  - Referrals ([app/admin/referrals/page.tsx](app/admin/referrals/page.tsx)): all 3 window.prompt flows → branded modals (Adjust Commission w/ amount+reason, Off-Platform Close w/ amount, reassign reason as modal field). 5 silent handlers got ok-checks (reject, status change, close deal, commission paid, reassign-approve branch).
  - Desk: stage-advance alert() → sonner toast. Payments: refund success alert() → toast (refund window.confirm KEPT — irreversible money movement).
- **Auth**: [AdminAuthGuard](app/components/AdminAuthGuard.tsx) was double-fetching /api/admin/auth on every page (layout already gates all of /admin). Now a pass-through — one auth round-trip per page view. API routes still enforce requireAdmin() server-side on every call.
- **API↔page wiring findings** (no action needed): all admin API routes auth-protected (requireAdmin or constant-time password for one-time setup endpoints); no dead fetches. Genuinely UI-orphaned but harmless: ranchers pause/resume/resend-setup/mark-legacy-connect/resync-connect, referrals stage (Desk uses it)/manual-create, affiliates deactivate/reactivate, consumers resend-warmup, click-to-call, route-state-to-rancher, cleanup-stale-leads.
- **Followups**:
  - /admin/today (v1) kept in nav — consider folding into Desk once Ben confirms Desk covers his daily loop.
  - Old "Run AI Field Setup" quick action still prompts for password (one-time setup endpoint contract) — fine, rarely used.
  - Auth'd-page screenshots not taken (would require admin password in transcript) — Ben should eyeball /admin, /admin/referrals, /admin/broadcast after deploy.

---

### Run 2026-06-12 (PM) — non-frontend deferred-findings work-through
- **Trigger**: manual, by Ben (work through the deferred NON-FRONTEND list from the frontend-audit run below)
- **Scope**: the 8 deferred items, in Ben's priority order. Code fixes verified: `tsc --noEmit` clean, `next build` clean. NOT committed (Ben hasn't asked).
- **Fixes applied (code, uncommitted)**:
  - **Privacy /wins**: buyer initial now FIRST initial only ("J.") — was leaking last initial too ([app/wins/page.tsx:81](app/wins/page.tsx:81)).
  - **Rate limiting** added (Upstash `lib/rateLimit.ts`, house pattern from /api/partners — 3/min + 10/hr per IP, 429 + friendly copy) to 4 previously unprotected public POST endpoints: `/api/apply`, `/api/inquiries`, `/api/land/[id]/inquire`, `/api/public/ranchers/[slug]/contact`. NOTE: audit's honeypot claim was stale — `/api/apply` already enforces the `fax` honeypot server-side (route.ts:92, silent-drop) and the form does send the field; only rate limiting was missing. Partner + wholesale + auth + consumers routes already had limits.
  - **Final invoice**: processing-date validation added BOTH sides — must parse + not be in the past, 24h grace for UTC-midnight date-only parse ([app/rancher/page.tsx](app/rancher/page.tsx) modal + [send-final-invoice route](app/api/rancher/referrals/[id]/send-final-invoice/route.ts)). NOTE: balance math (min $1 / max $25k / listed−processingFee) was ALREADY enforced API-side since S4 2026-06-10 — audit claim stale there too.
  - **Stale-data refetch**: referral status PATCH failure now returns early — no dashboard refetch on failed update ([app/rancher/page.tsx:292](app/rancher/page.tsx:292) `updateReferralStatus`). Left `acceptReferral`'s refetch-on-failure alone (accept is idempotent; refetch shows true state after races).
  - **Missing-pricing alarm**: empty/undefined `tierSpecialty` now alarms on ALL three cuts instead of none — the deposit endpoint 409s any unpriced cut regardless of specialty, so legacy ranchers were silently unlistable ([app/rancher/page.tsx:776](app/rancher/page.tsx:776)).
  - **Meta event_id convention centralized**: new `metaEventId()` helper + the full dedup convention doc (raw record id, no prefixes; prefixed ids only legal for server-only events) in [lib/analytics.ts](lib/analytics.ts). All 4 paired client+server surfaces routed through it: deposit page ↔ /api/checkout/deposit, success page ↔ stripe webhook Purchase, wholesale form ↔ /api/wholesale/signup, partner page ↔ /api/partners.
- **Data fixes applied (Airtable)**:
  - Deleted `recb7OxfhPTuNuarX` from News — the malformed NEWS_POSTS record. Verified completely empty (`fields: {}`, created 2026-01-31) before delete. Frontend filter from the AM run stays as belt-and-suspenders.
- **Support-email canon — RESOLVED by Ben this run**: Ben picked **hello@buyhalfcow.com everywhere**. Swept all `support@` (~22 sites) + `hi@` (5 sites) → `hello@` across app/** + lib/email.ts. Survey context: support@ was rancher/ops surfaces, hello@ buyer/marketing, hi@ orphan on unsubscribe/resubscribe. Internal .md guides (BUSINESS_EMAIL_SETUP.md etc.) left untouched — they document the inbox setup itself. ⚠️ OPS ACTION: ensure `support@` and `hi@` exist as forwarding aliases → hello@ (old emails in the wild still reply to them), and that hello@ is monitored.
- **Followups for next run**:
  - Timezone item (processing dates render hardcoded UTC, [app/ranchers/[slug]/page.tsx:287](app/ranchers/[slug]/page.tsx:287)) was NOT in this run's list — still open.
  - `dangerouslySetInnerHTML` affiliate click-track smell ([app/r/[code]/page.tsx:38](app/r/[code]/page.tsx:38)) — still open.
  - Consider extending rate limiting to `/api/prospects/claim`, `/api/prospects/remove`, `/api/orders/request` (public POSTs, not in audit's named list).

---

### Run 2026-06-12 — full frontend audit + design-system consistency sweep
- **Trigger**: manual, by Ben ("full top down analysis of my front end")
- **Scope**: UI/UX only (code shipped); non-frontend findings logged below for a SEPARATE session — none acted on.
- **Frontend fixes applied** (all verified: tsc clean, `next build` clean, key pages screenshot-verified on localhost):
  - **~430 hardcoded hex classes → semantic tokens** across 29 files (affiliate dashboard/login/verify, privacy, terms, ranchers/[slug] contact+claim+remove + forms, land, member, apply form, map components ×5, rancher portal, sign-agreement, lead/order modals, Input/Textarea/Select/Checkbox/Divider primitives, etc). Site now has ONE color vocabulary (`bg-bone`, `text-saddle`...) — palette changes are a one-file edit in globals.css.
  - **Member dashboard status badges + success panels** moved off default Tailwind colors (yellow-100/blue-100/green-50) onto system tokens (amber/sage/rust/dust/weathered tints).
  - **Funnel progress bar standardized** (`h-1.5 bg-dust`) across /access, /qualify, /matched.
  - **next.config.ts images**: whitelist of 4 hosts → `https://**`. A rancher logo hosted on any other CDN (live example: Champion Valley Farm on images.squarespace-cdn.com) **crashed the whole page** into the error boundary for buyers. Trade-off accepted: open image optimizer vs broken rancher pages.
  - **/news hardening**: filter posts missing title/slug (a malformed NEWS_POSTS record was rendering a blank "Invalid Date" article publicly), guard invalid dates, add fetch-error state.
  - **Copy canon fixes**: "premium audience" removed from /partner metadata (banned word); "half a cow" → "half cow" on /r/[code]; six generic "Something went wrong" errors rewritten to the what+why+fix pattern (member login/verify, unsubscribe, resubscribe, land, global error.tsx); /news loading copy contextualized.
  - **Touch targets**: capacity Save/Cancel buttons in rancher portal → min-h-[44px]. Rancher directory + state-page logo blocks h-40 → h-28 on mobile.
- **Deferred to Ben / next session (NON-FRONTEND findings — do not lose these)**:
  - **Privacy**: /wins buyer initials show first AND last initial; code comment says first-only ([app/wins/page.tsx:81](app/wins/page.tsx:81)).
  - **Spam**: apply-form honeypot field (`fax`) is never checked server-side in /api/apply ([app/apply/ApplyForm.tsx:189](app/apply/ApplyForm.tsx:189)). Same theme: no rate limiting on public POST forms (partner, wholesale, land, contact).
  - **Money math**: final-invoice modal — no future-date validation on processing date, and balance = listed − processingFee logic isn't enforced API-side ([app/rancher/page.tsx:564](app/rancher/page.tsx:564)-584).
  - **Stale data after failed update**: referral status update refetches dashboard even when POST fails ([app/rancher/page.tsx:292](app/rancher/page.tsx:292)).
  - **Silent unlistable ranchers**: undefined `tierSpecialty` skips the missing-pricing alarm for legacy ranchers ([app/rancher/page.tsx:761](app/rancher/page.tsx:761)).
  - **Timezone**: processing dates display hardcoded UTC ([app/ranchers/[slug]/page.tsx:287](app/ranchers/[slug]/page.tsx:287)) — MT rancher's "June 12" can render June 13.
  - **Analytics fragility**: Meta event_id dedup convention (event_id = raw refId) lives only in scattered E-3 comments — needs a shared lib/analytics constant.
  - **Data**: NEWS_POSTS has a record with no title + invalid date (frontend now filters it; record itself needs fix/delete in Airtable).
  - **Support-email drift**: support@ (unsubscribe) vs hi@ (resubscribe) vs hello@ (promise/checkout). Pick one canon + alias the rest.
  - **Pattern smell**: `dangerouslySetInnerHTML` for affiliate click-track script ([app/r/[code]/page.tsx:38](app/r/[code]/page.tsx:38)) — sanitized today, fragile tomorrow.
  - **UX P2 backlog (frontend, not blocking)**: window.confirm() on rancher slot-accept → branded modal; /qualify answers → fieldset/legend semantics; unsubscribe alert() → inline error; reusable Modal component (land/exit-intent duplicate it); map name-search; Cal embed loading states; /admin/* still has hex literals (internal, low priority).
- **Patterns observed**:
  - Design drift concentrates in auth'd/secondary surfaces (affiliate, member, legal, sub-forms) — public funnel pages stay clean. Future page reviews should start there.
  - Rancher-pasted asset URLs (logos, galleries) come from arbitrary hosts; any "whitelist" approach will keep breaking pages.
- **Followups for next run**:
  - Deploy + spot-check /affiliate, /ranchers/[slug]/contact, /member on production.
  - Tackle the non-frontend list above as its own session (Ben said "log it... we'll move to something else and make that task happen afterwards").

---

### Run 2026-04-29 — initial audit + cleanup
- **Trigger**: scheduled task `nightly-rancher-pipeline-audit`
- **Audit input**: critical=8, warn=80, info=11 · activeRefs=423 · activeRanchers=10 · totalRefs=1282 · wonAllTime=0
- **Auto-fixes applied** (12 writes, dry-run verified first):
  - Closed 6 active refs on suppressed buyers as `Closed Lost`:
    - `rec3Zq2hBy2p5JgcZ` E2E Beef Unqualified → Russell Gift
    - `recqNN9YiUKbDQVDF` Keith Nolan → Russell Gift
    - `recUhAZRzfz4o8aN1` Colin Patterson (no rancher link)
    - `recfdTSwsFvsVGDza` Maddie Pacheco (no rancher link)
    - `recjeuQnAnh9u93YR` E2E Test Beef TX
    - `recqrD1mEHVXYLUsL` E2E Beef TX
  - Refreshed 10 stale `Suggested Rancher Name` caches → "Joseph & Jamie Hewitson " (refIds: `rec2A5Xv0F855MMH7, recFpo0r7n6FUns6h, recGaKNtPJamOxDuN, recJa5v0JBoiwCyjZ, recTIaedMQ464FqXY, recZ7BkXtgapMpyOA, recdDKsi1DHnAivsU, recdX7RbPRRly7jWe, recwQzxPdwvGSUSEg, recxhKgC3NW4ZDMpc`)
- **Counter writes**:
  - Russell Gift `rec2yADvi1fODSrfj`: `Current Active Referrals` 15 → 13 (−2 for the two closed refs that had a Rancher link)
- **Deferred to Ben**:
  - Zach Knowles missing `Page Live` (25 routed)
  - Linda Anspach missing `Slug` + `Page Live` (6 routed in 1d)
  - Ace Hartsock 33/20 over-cap, 0/41 close rate, all 14–19d stalled
  - Terrell Johnson 22 lost / 0 won across 29 routed
  - Pilot upsells — none triggered (Ace 0/10, Beckie 0/10, Joseph 0/5)
- **Bugs observed (code, not data)**:
  - Stale-cached-name check false-positives when `Rancher` ≠ `Suggested Rancher` ([app/api/cron/nightly-rancher-audit/route.ts:287](app/api/cron/nightly-rancher-audit/route.ts:287))
- **Tier-Specialty filter**: verified working — 0 tier-mismatch issues across 423 active refs.
- **Uncommitted WIP detected** (not touched):
  - `app/api/consumers/route.ts`
  - `app/api/cron/rancher-launch-warmup/route.ts`
  - `app/api/matching/suggest/route.ts`
  - `app/api/member/reorder/route.ts`
  - new file: `lib/rancherEligibility.ts`
- **Followups for next run**:
  - Recheck Ace's stalled "Rancher Contacted" cluster — has any moved to Negotiation/closed in the day since? If still all stuck, escalate priority of his health-check.
  - If Zach's `Page Live` is still false tomorrow, raise severity (he's accumulating stale intros).
  - Check whether `referral-chasup` cron auto-closed any of the Zach Knowles "Intro Sent 9–10d" refs (its threshold is MAX_CHASE_UPS=3 + 5d staleness).
