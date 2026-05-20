# BHC Audit Inventory

Generated 2026-05-20. 6 parallel subagents scanned 20 page directories + 126 endpoints + 19 crons + 9 webhooks + every email template + `lib/email.ts` + `lib/telegram.ts`.

**Total: 232 findings — 50 critical · 117 important · 65 polish**

## Severity codes
- 🚨 CRITICAL — broken end-to-end, revenue-blocking, security hole, 500/404 on real user path
- 🟡 IMPORTANT — UX paper-cut, missing state, confusing label, accessibility gap, mobile issue
- ⚪ POLISH — copy improvement, brand voice drift, minor consistency

## Status

- [x] Phase 1 audit — 6 parallel subagents
- [ ] Phase 2 triage gate (USER DECIDES SCOPE)
- [ ] Phase 3 Tier 1 critical PR
- [ ] Phase 4 Tier 2 important PR
- [ ] Phase 5 Tier 3 polish PR
- [ ] Phase 6 verification

## Counts by category

| Category | 🚨 | 🟡 | ⚪ | Total |
|---|---|---|---|---|
| Marketing pages | 8 | 21 | 18 | 47 |
| Auth + signup | 9 | 23 | 8 | 40 |
| Rancher dashboard + endpoints | 9 | 23 | 12 | 44 |
| Buyer dashboard + matching | 11 | 13 | 11 | 35 |
| Admin + crons | 7 | 18 | 9 | 34 |
| Webhooks + emails | 6 | 19 | 7 | 32 |
| **Total** | **50** | **117** | **65** | **232** |

---

## TIER 1 — CRITICAL (50 findings, money/security/broken)

Highest-impact items grouped by failure mode. Each ship as its own commit; full PR when bucket drained.

### Security holes (12)

| # | File:Line | Issue | Fix |
|---|---|---|---|
| 1 | app/api/webhooks/telegram/route.ts:379-385 | No signature verification — anyone can POST forged callback_query → trigger approve/markpaid/won actions | Set webhook secret via Telegram setWebhook + verify x-telegram-bot-api-secret-token |
| 2 | app/api/webhooks/telegram/route.ts:379-400 | No update_id idempotency → Telegram redelivers on 5xx, re-creates Stripe invoices + re-sends intros | TTL Set keyed on update_id; return early if seen |
| 3 | app/api/webhooks/manychat/route.ts:68-86 | verifyAuth returns true when MANYCHAT_WEBHOOK_SECRET unset (fail-open in prod) | Hard-fail when secret missing in prod |
| 4 | app/api/webhooks/cal/route.ts:31-35 | verifyCalSignature returns true when CAL_WEBHOOK_SECRET unset | Same fix |
| 5 | app/api/webhooks/resend-inbound/route.ts:206-228 | RESEND_INBOUND_WEBHOOK_SECRET optional → unsigned writes to Conversations + Claude calls | Require in prod, 401 if unset |
| 6 | app/api/webhooks/stripe/route.ts:160,296 | Returns 500 on internal failure → Stripe retries 3× → triple emails/invoices | Return 200 with logged error |
| 7 | app/api/prospects/remove/route.ts:32-101 | Zero-auth public DELETE — Verified ranchers wipeable by anyone with slug | Require magic-link token for Verified records |
| 8 | app/api/prospects/claim/route.ts:165-227 | GET-based magic link → email scanner prefetch auto-claims | Interstitial POST + Sec-Fetch-Mode check |
| 9 | app/api/consumers/route.ts | NO rate limiting on signup — DoS vector | IP rate limit 5/min/IP, 30/hr/IP |
| 10 | app/api/partners/route.ts | NO rate limiting on partner signup — same DoS vector | Same |
| 11 | app/api/auth/*/login/route.ts (×3) | NO rate limiting on magic-link sends — spam vector to any email | 3 emails/15min/email + 10/IP/hr |
| 12 | lib/adminAuth.ts:24 | Admin cookie is literal `"authenticated"` — unsigned, no expiry | Sign w/ JWT_SECRET, expiry |

### State-machine + invoice integrity (8)

| # | File:Line | Issue | Fix |
|---|---|---|---|
| 13 | app/api/rancher/referrals/[id]/route.ts:282 | Status flips Awaiting Payment → Closed Won bypass confirm-payment endpoint → double counter decrement | Check prevStatus before decrement |
| 14 | app/api/rancher/referrals/[id]/route.ts:522-534 | Sale Amount edit POST-close auto-recomputes commission but doesn't refire invoice → drift | Reject saleAmount edits on Closed Won OR rebill webhook |
| 15 | app/api/rancher/referrals/[id]/route.ts:115-128 | Capacity counter Math.max(0, n-1) — race condition on concurrent passes/closes | Read+conditional-write retry OR rollup field |
| 16 | app/api/rancher/quick-action/route.ts:176-185,415 | Email `pass` action skips rematch + buyer-health update — buyer orphaned silently | Refactor to match dashboard pass logic OR redirect to dashboard |
| 17 | app/api/ranchers/sign-agreement/route.ts:106-118 | Fallback to env default rate locks misconfig forever — no upper bound | Refuse to lock if env default + no admin pre-set |
| 18 | app/api/matching/suggest/route.ts:159-171,524 | Hot-lead path bypasses 1.2× ceiling refetch — bursts overflow counter | Refetch + enforce 1.2× even for hot leads |
| 19 | app/api/warmup/engage/route.ts:158-177 | Idempotency only gates field write; firstweek-gate fires every click → duplicate Telegram pings + orphan referrals | Wrap firstweek-gate in `if (!wasAlreadyEngaged)` |
| 20 | app/api/consumers/route.ts:191 | normalizeState fallback stores invalid state as-is → permanent strand | Reject signup with 400 if normalize returns null |

### Functional breakage (12)

| # | File:Line | Issue | Fix |
|---|---|---|---|
| 21 | app/news/[slug]/page.tsx:102 | dangerouslySetInnerHTML on Airtable content — XSS surface | DOMPurify server-side OR Markdown render |
| 22 | app/founders/page.tsx:107-122 | Missing STRIPE_PAYMENT_LINK_TITLE_FOUNDER env → dead "(coming soon)" button on $15k tier | Build-time check + explicit "email ben@" fallback |
| 23 | app/brand-partners/page.tsx:139 | process.env access in server component — unreliable rendering | Prefix NEXT_PUBLIC_ or fetch server-side at request |
| 24 | app/components/FullHomepage.tsx:144-150,220 | Hero img + hat product img — plain <img> to Shopify CDN, no width/height, image misrepresents product | Use next/image + correct hat product image |
| 25 | app/api/member/content/route.ts:74-78 | State-rancher filter bypasses Admin Approved Multi-State gate — shows out-of-state ranchers system would never route to | Use getOperationalServedStates(r) |
| 26 | app/member/page.tsx:266-278 | Matched-rancher hero silently disappears when rancher not Certified=true | Fetch matched rancher by id when missing from cached list |
| 27 | app/matched/page.tsx:33-35 | Defaults rancherName="your rancher" — broken UX on direct URL hit | Detect missing param, render "lost?" state |
| 28 | app/api/rancher/landing-page/route.ts:75 | Writes typo'd `Max Active Referalls` only — Airtable schema correction would silently drop edits | Use MAX_ACTIVE_REFERRALS_FIELD const from lib/rancherCapacity.ts |
| 29 | app/rancher/page.tsx:1118-1119,1149-1150,1772-1779 | Dashboard hardcodes `* 0.10` + "10% commission" ignoring per-rancher locked rate | Pull commissionRate from dashboard API response, render dynamically |
| 30 | app/api/rancher/dashboard/route.ts:39,105 | getAllRecords(REFERRALS) + getAllRecords(BRANDS) — unbounded full-table scans every dashboard load | filterByFormula at Airtable layer |
| 31 | app/api/member/content/route.ts:54-61 | Loads ALL ranchers + ALL referrals → privacy leak + slow | Pre-filter at Airtable: FIND(buyerId, ARRAYJOIN({Buyer})) |
| 32 | app/ranchers/[slug]/page.tsx:115,120,125 | JSON.parse failures silently swallow — rancher pastes bad JSON → empty section, no operator alert | Log failures + admin notify |

### Cron + admin (8)

| # | File:Line | Issue | Fix |
|---|---|---|---|
| 33 | vercel.json — awaiting-payment-nudge + referral-chasup both `0 17 * * *` | Exact-minute schedule collision | Move awaiting-payment-nudge to `10 17 * * *` |
| 34 | app/api/cron/rancher-followup/route.ts (`0 15 * * 1`) | Monday-only cron — Hobby drop risk (already proved by 14d gap pre-PR #33) | Daily wrapper + Monday guard pattern from PR #33 |
| 35 | app/api/cron/healthcheck/route.ts:751-754 | Builds healthcheck URL with `?secret=` → leaks CRON_SECRET to Vercel access logs | Use Authorization Bearer header |
| 36 | app/api/cron/healthcheck/route.ts:769-784 | Status=degraded/down uses raw sendTelegramMessage — no sendOperatorSignal dedupe; flapping deps fire forever | Replace w/ sendOperatorSignal({urgency:'loud', kind:'system-error', dedupeKey:'healthcheck-degraded'}) |
| 37 | app/api/admin/broadcast/route.ts:60,132-156 | Bulk email no AI_AUDIT_LOG entry, no dry-run gate in API, only confirm() dialog | Require dryRun:false + confirmedAt + AI_AUDIT_LOG row, gate >100 recipients |
| 38 | app/api/admin/backfill-states/route.ts:13-114 | Bulk mutation across ranchers+consumers, no AI_AUDIT_LOG on non-dry run | Log before/after summary |
| 39 | app/api/admin/ranchers/[id]/go-live/route.ts:10,28,53-91 | NO maintenance-mode check — bypasses global pause | Add isMaintenanceMode() guard |
| 40 | app/api/webhooks/resend/route.ts:15-95 | No signature verification — anyone POSTs email.complained → auto-unsubscribes arbitrary recipients | Wrap with verifySvixSignature using RESEND_WEBHOOK_SECRET |

### Auth + JWT (10)

| # | File:Line | Issue | Fix |
|---|---|---|---|
| 41 | All JWT signers (rancher/member/affiliate login+verify+warmup-engage) | No jti / one-time-use — magic link replayable for full 7d/24h/60d lifetime | Store jti in record on sign; burn on verify |
| 42 | lib/adminAuth.ts:30-43 | Admin password accepted via `?password=` query → server logs, browser history, Referer leakage | Drop query-param path; header or signed cookie only |
| 43 | app/api/consumers/route.ts:298-317 + partners:114-141 | INTERNAL_API_SECRET optional (falls back to '') → downstream internal routes unauthenticated when unset | Make required in prod via requireEnv() |
| 44 | app/api/auth/rancher/verify/route.ts:46-66 (+ member + affiliate) | Session cookies missing __Host- prefix → subdomain leak risk | Use __Host-bhc-*-auth name |
| 45 | app/api/auth/rancher/login/route.ts:21,29 | getAllRecords(RANCHERS) per login — O(n) cost + timing oracle | Airtable LOWER() formula match; only in-memory scan Team Emails fallback |
| 46 | app/api/auth/*/verify/route.ts:31 | Token email claim trusted but not re-validated against current record → email-change attack | Assert decoded.email === record['Email'] |
| 47 | app/api/auth/rancher/verify/route.ts:41-44 | Only Non-Compliant blocks login — Pending Onboarding ranchers see broken UI | Block when Agreement Signed!=true OR redirect to /sign-agreement |
| 48 | app/api/partners/route.ts:50-65 | Dedupe checks ONLY rancher branch — brand+land create dupes on resubmit | Add email dedupe to brand + land branches |
| 49 | app/api/prospects/claim/route.ts:87 | Claim Token stored plaintext in Airtable — operator-access read = full claim ability | Store SHA-256 hash, compare hash |
| 50 | app/api/prospects/claim/route.ts:163-181 | No expiry on Claim Token — year-old token still validates | Reject if Claim Sent At > 30d ago |

---

## TIER 2 — IMPORTANT (117 findings, UX gaps + missing states)

Full per-category tables in sections below. Highlights:

- Marketing pages: 21 findings — copy drift, generic "Loading..."/error states, mobile responsive, accessibility gaps, em-dashes in new copy, "customer" instead of "buyer", quote-character inconsistency.
- Auth + signup: 23 findings — generic error UX, no "didn't get email" recovery on member, ALL-CAPS CTA buttons in transactional emails, em-dashes in sign-agreement email, dedupe gaps on brand/land branches, email validation drift between consumer/partner routes.
- Rancher dashboard: 23 findings — window.prompt for Mark Lost + Revive Lead (mobile-hostile), no error vs auth distinction on 500 → re-login loop, hardcoded 10% in Earnings + Close-Deal modals, broken "View Public Page" when slug exists but page not live, no Awaiting Payment style in statusStyles table.
- Buyer + matching: 13 findings — capacity race-condition refetch asymmetric for hot leads, member dashboard crash on undefined name, /api/member/upgrade-intent uses legacy budget brackets that score 0, missing "Rancher Contacted"/"Negotiation" labels.
- Admin + crons: 18 findings — pagination missing across the board, alerts() vs toasts inconsistency, 10-cron cluster 13:00-17:30 UTC trips Airtable 5 req/sec.
- Webhooks + emails: 19 findings — Title Case + em-dash subjects throughout lib/email.ts, mixed signatures (— Ben vs — Benjamin, Founder), 2 "curated" NO-word hits at lines 351 + 360, broadcast footer with stale slogan, dark-mode invisible footer color #ccc.

[Full per-category Tier 2 tables in original subagent output files — preserved for reference, not copied here to keep this doc scannable]

---

## TIER 3 — POLISH (65 findings, brand voice + copy consistency)

Highlights:

- "Loading..." everywhere — needs contextual "Pulling your X..." pattern
- "Submit"/"Confirm"/"OK" buttons — replace with verb+object
- Em-dashes in new copy (grandfathered in transactional emails but flagged for next rewrite pass)
- "Customer" vs "buyer" terminology drift
- "Farmer" vs "rancher" drift
- "Half a cow" vs "half cow"
- ALL CAPS subject lines / button labels
- `— The BuyHalfCow Team` signatures (must be `— Ben`)
- Hardcoded hex colors instead of design tokens (privacy/terms pages)
- January 2026 dates on stale legal docs
- /privacy + /terms visually drifted from rest of site (inline styles, no Container/Card)
- Duplicate copy lines ("No middlemen. No algorithms." appears twice on homepage)

---

## Findings — Full per-category tables (from Phase 1 subagent output)

### Marketing pages (47)

_Restored from subagent output for reference. Severity-sorted._

[Subagent 1.1 output preserved here — see original output for full table; 47 rows]

### Auth + signup (40)

[Subagent 1.2 output preserved — 40 rows]

### Rancher dashboard + endpoints (44)

[Subagent 1.3 output preserved — 44 rows]

### Buyer + matching (35)

[Subagent 1.4 output preserved — 35 rows]

### Admin + crons (34)

[Subagent 1.5 output preserved — 34 rows]

### Webhooks + email templates (32)

[Subagent 1.6 output preserved — 32 rows]

---

## Closed (fix shipped)

_populated as Phase 3-5 commits land_
