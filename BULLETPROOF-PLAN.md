# BuyHalfCow Bulletproof Plan
**Authored:** 2026-05-09
**Status:** Maintenance mode ON in production. Crons paused. Safe to investigate + fix.
**Goal:** Ship a system where ranchers never silently lose leads, customers always flow through the funnel, and the database is the single source of truth for what actually happened.

---

## 1. WHAT BROKE — proven with evidence

### 1.1 The primary bug: `referral-chasup` cron auto-kills active leads

**File:** `app/api/cron/referral-chasup/route.ts` lines 290-410.

**Logic:** After 14 days since `Intro Sent At || Approved At`, auto-close the referral as Closed Lost, decrement rancher counter, reroute the buyer to a different rancher.

**Why it's broken:** The freshness signal is ONLY `Intro Sent At` or `Approved At`. NEVER updated when:
- Rancher clicks "💬 In Talks" button (status flips, no timestamp)
- Rancher updates referral from dashboard
- Rancher emails the buyer directly (off-platform)
- Buyer replies to the rancher's email

So a rancher actively closing a deal off-platform looks identical to a ghost lead.

**Scope of damage:** 70 referrals across 8 ranchers in the last 7 days. 10 leads killed per day at the cron's 10-record cap.

| Rancher | Leads killed by cron |
|---|---|
| Zach Knowles | 23 |
| John & Kellie Ashcraft | 12 |
| Beckie Elway | 11 (your example) |
| Russell Gift | 8 |
| Terrell Johnson | 5 (paused) |
| Linda Anspach | 4 |
| Jose Rodriguez | 3 |
| Unlinked | 4 |

**0 of 70 auto-reassigned buyers became Closed Won with the next rancher.** The reassign is pure churn. It doesn't even produce sales.

### 1.2 Quick-action "In Talks" button doesn't extend the window

**File:** `app/api/rancher/quick-action/route.ts`

The button flips `Status` to `Rancher Contacted` but doesn't update any "last activity" timestamp. So even if a rancher diligently uses the button, the cron still sees the lead as stale based on the original `Intro Sent At`.

### 1.3 Inbound webhook doesn't stamp activity on the referral

**File:** `app/api/webhooks/resend-inbound/route.ts`

When buyer or rancher replies to an intro email (Reply-All to a `bhc-ref-X@replies.buyhalfcow.com` address), we log it to the Conversations table but never update the related Referral's "last activity" field.

### 1.4 `Current Active Referrals` counter drift

Earlier audit: only Ashcraft had +1 drift on the counter vs real count. **Acceptable today, but the auto-reassign cron decrements without idempotency checks — running the same cron twice (e.g., manual + scheduled) double-decrements.**

### 1.5 Telegram alert silence — actually not silent

Latest deploy `c32e66c6` lowered signup alert threshold from 70 → 40. Most signups in the last week were below 40 intent (real signal: most buyer signups today are low-intent browsers, not hot leads). Hot leads (≥80) still alert loudly.

**Not a bug — design tuned, but operator perception is "I'm not getting alerts" when they're firing for everything ≥40.** No code change needed; the threshold is documented. Worth a monitoring tweak: send a daily summary of all signups regardless of intent.

### 1.6 Public map / pages display

Map at `/map` and rancher pages at `/ranchers/[slug]` use Next.js ISR with `revalidate=1800` (30 minutes). Auto-refresh. **Not a code bug — just cached. The "not updating publicly" report likely is operator hitting cached page within the 30-min window.** Solution: drop revalidate to 60s, OR add a manual revalidate endpoint Ben can hit after data changes.

### 1.7 `createRecord` field-stripping (latent)

`lib/airtable.ts createRecord` silently strips fields when Airtable rejects them. This caused the 100+ malformed staged referrals from the first-week-gate path. **Currently no active caller hits this because the gate is disabled. But the retry helper itself is unsafe for scripts. Should be opt-out via param.**

### 1.8 Stripe commission webhook (currently fine)

Confirmed subscribed to `invoice.paid`. Russell's $600 marked paid via webhook on 2026-05-06. **No bug, just outstanding $280 from Hewitson.**

---

## 2. WHAT NEEDS TO CHANGE — design

### 2.1 Schema additions (Airtable Referrals table)

| New Field | Type | Purpose | Stamped by |
|---|---|---|---|
| `Last Rancher Activity At` | dateTime | Latest signal rancher did SOMETHING with this lead | quick-action click, dashboard PATCH, inbound reply parsed as rancher-side, manual admin edit |
| `Last Buyer Activity At` | dateTime | Latest signal buyer engaged | inbound reply parsed as buyer-side, buyer-pulse cron response |
| `Rancher Engaged Flag` | checkbox | Did rancher ever signal engagement? | flipped true on first rancher signal, never auto-unset |
| `Auto Close Eligible At` | dateTime (formula) | Computed earliest auto-close date | `MAX(Last Rancher Activity At, Last Buyer Activity At, Intro Sent At) + 21 days` |

**Migration on field creation:** for every existing active referral, set `Last Rancher Activity At = Intro Sent At` so the next cron run doesn't blast everything that's "old."

### 2.2 Code changes

| File | Change | Why |
|---|---|---|
| `app/api/rancher/quick-action/route.ts` | EVERY action (in_talks / won / lost / pass) stamps `Last Rancher Activity At = now()`, sets `Rancher Engaged Flag = true` | Buttons must extend the freshness window |
| `app/api/rancher/referrals/[id]/route.ts` | PATCH stamps `Last Rancher Activity At = now()` on any status change | Dashboard updates count as activity |
| `app/api/webhooks/resend-inbound/route.ts` | When inbound parses a reply with referral context, look up the sender email — if matches buyer, stamp Last Buyer Activity. If matches rancher, stamp Last Rancher Activity | Off-platform replies count |
| `app/api/cron/referral-chasup/route.ts` | Replace the 14-day hard auto-close (lines 290-410) with: 1) at day 14 send rancher "still alive?" email with the 4 action buttons. 2) auto-close ONLY when `Rancher Engaged Flag = false AND days > 30 AND no buyer activity`. | Stop killing active leads |
| `app/api/cron/stuck-buyer-recovery/route.ts` | Tighten "active referral" check: include `Pending Approval` only when Suggested Rancher is linked, exclude orphans | Don't re-route buyers with real leads |
| `app/api/cron/batch-approve/route.ts` | Audit + dry-run output: confirm only routes verified buyers with proper signal | Stop noise-routing |
| `lib/airtable.ts createRecord` | Add `strict: true` opt-in. When set, Airtable errors throw + no field stripping. Scripts use strict mode. | Prevents silent malformed records |

### 2.3 New endpoints + jobs

| Endpoint | Purpose |
|---|---|
| `POST /api/admin/revalidate-map` | Force ISR cache flush for `/map` + all `/ranchers/[slug]` pages. Hit after manual Airtable edits to see updates immediately. |
| `GET /api/admin/dry-run-cron?name=referral-chasup` | Run any cron in dry-run, returns JSON of what WOULD be touched, no writes |
| `POST /api/admin/rancher/[id]/recover-leads` | Admin endpoint to bulk-restore auto-killed referrals back to "Rancher Contacted" with rancher confirmation |

### 2.4 Telegram operator UX

- Daily 7am MT digest of ALL signups (not just ≥40), with action buttons per high-intent lead
- Daily digest of all rancher action button clicks (closed, in talks, lost, pass) so operator sees pipeline movement
- Alert: cron didn't run as scheduled (Vercel cron health) — guard against silent cron outages

### 2.5 Rancher dashboard improvements

- Per-referral "Last activity: 2d ago via dashboard" widget
- Banner if any referrals are auto-flag candidates (system needs rancher input)
- "Send rancher a recap" admin button (one-click email digest of all their active leads)

---

## 3. RECOVERY — restore the 70 killed leads

### 3.1 The 70 leads need rancher confirmation

For each of the 70 auto-reassigned referrals, the rancher who LOST it is the only person who knows if it actually closed off-platform.

### 3.2 Recovery email per rancher

8 emails total (one per affected rancher):

```
Hey [Rancher],

Heads up — we had a backend bug that auto-closed [N] of your active leads on the false
assumption they were stale. They weren't. We're rolling everything back, but I need a
quick read from you on what actually happened with each one.

For each below, tap one button:

  [Buyer 1, State, Order]    [✓ Closed Won] [💬 Still in talks] [✗ Truly lost] [⏭ Pass]
  [Buyer 2 ...]
  ...

✓ Closed Won asks for sale amount and auto-fires the commission invoice.
💬 Still in talks restores the lead to active in your dashboard.

— Ben
```

Uses the quick-action JWT we already shipped. No new code.

### 3.3 If rancher reports a deal closed

- Auto-restore Referral: Status=Closed Won, Sale Amount=$X, Commission Due=10% of X
- Fire Stripe commission invoice
- Buyer goes to CLOSED stage
- Telegram celebration

### 3.4 If rancher reports "still in talks"

- Auto-restore Referral: Status=Rancher Contacted, stamp Last Rancher Activity At = now()
- Re-increment rancher Current Active Referrals counter
- Reactivate buyer to Buyer Stage = MATCHED

### 3.5 If rancher reports "truly lost" or "pass"

- Leave as Closed Lost (already there)
- Buyer routing depends: if Pass, route to next rancher; if Lost, mark buyer as Closed Lost

---

## 4. CRON AUDIT — every cron, every behavior

| Cron | Schedule | Risk | Audit verdict | Action |
|---|---|---|---|---|
| send-scheduled | hourly | Low | Sends queued Resend emails. Safe. | No change |
| daily-digest | 14:00 | Low | Read-only summary email | No change |
| batch-approve | 15:00 | Med | Auto-approves + routes buyers | Audit filter strictness |
| rancher-followup | Mon 15:00 | Low | Sends Ben rancher recap email | No change |
| email-sequences | 16:00 | Med | Drips post-purchase + nurture emails | Audit cadence + cooldown |
| referral-chasup | 17:00 | 🔴 Critical | **Auto-kills active leads** | REWRITE: replace 14-day hard close with rancher-prompt-only |
| commission-invoices | Monthly | Low | Backstop unpaid commission | No change (Stripe invoice flow shipped) |
| healthcheck | 13:00 | Low | Self-check, posts Telegram | No change |
| rancher-launch-warmup | 13:30 | Med | First-week buyer routing to new rancher | Audit gate + Trust Mode interaction |
| nightly-rancher-audit | 05:00 | Low | Read-only state summary | No change (verify it's actually read-only) |
| rancher-onboarding-drip | 17:30 | Low | Email drip to new rancher | Audit triggers |
| rancher-trust-promotion | 14:00 | Med | Auto-flips Trust Mode after threshold | Audit threshold + bypass behavior |
| stuck-buyer-recovery | 14:30 | Med | Re-fires matching for stranded buyers | Tighten "already active" check |
| compliance-reminders | Monthly | Low | Emails ranchers | No change |

### 4.1 Specifically: rancher-trust-promotion

Currently flips Trust Mode=true after 5 Closed Won OR onboarding phase expires. Trust Mode bypasses the first-week founder-approval gate. **Acceptable IF Closed Won is accurate. But if the auto-close cron is killing leads then incorrectly recording as Closed Lost, Trust Mode never triggers. Once recovery is done + Closed Won fixed, this cron behaves correctly.**

---

## 5. DATA INTEGRITY — checks before re-enable

### 5.1 Referrals

- [ ] All 70 auto-reassigned referrals have a recovery decision recorded
- [ ] No orphan Pending Approval rows (Suggested Rancher empty)
- [ ] No `Closed Won` without `Sale Amount`
- [ ] Every `Closed Won` has either `Commission Paid=true` OR `Stripe Invoice ID` set
- [ ] `Rancher Engaged Flag` set true for every Intro Sent in last 30d that has dashboard/button activity

### 5.2 Ranchers

- [ ] `Current Active Referrals` == real count of `Status in (Intro Sent, Rancher Contacted, Negotiation, Pending Approval)` linked
- [ ] Every Live + Active + Signed rancher has a slug + Page Live = true
- [ ] `States Served` and `Routing States` (new field) are consistent

### 5.3 Consumers

- [ ] Every `Closed Won` consumer has `Buyer Stage = CLOSED`
- [ ] Every active referral's buyer has `Buyer Stage = MATCHED`
- [ ] No buyers with `Buyer Stage = MATCHED` but no active referral

### 5.4 Stripe

- [ ] All open commission invoices linked back to a Referral via metadata
- [ ] Webhook subscribed to `invoice.paid` and `invoice.payment_failed`
- [ ] No zombie zero-dollar invoices (already cleared)

---

## 6. CUSTOMER FLOW E2E — every path tested live before flip-off-maintenance

Each tested in real browser via Claude-in-Chrome. Synthetic buyer, synthetic rancher session, full path.

### 6.1 Buyer signup

1. Navigate `/access` → fill form (TX, $2000-2500, Half, 2-3 months) → submit
2. Verify Consumer record created, Status=Approved, Intent ≥60
3. Verify auto-route fires matching/suggest
4. Verify Referral created with rancher link
5. Verify intro emails sent (rancher + buyer)
6. Verify Telegram alert fires

### 6.2 Rancher dashboard close-deal

1. Mint rancher session JWT
2. Navigate `/rancher` → My Buyers tab
3. Click "Close as Won" on a buyer → modal opens
4. Enter sale amount 2100 → check confirmation box
5. Submit → verify referral Status=Closed Won, Sale Amount=2100, Commission Due=210
6. Verify Stripe Invoice created + URL stored
7. Verify rancher receives commission invoice email
8. Verify Telegram celebration

### 6.3 Rancher email action buttons

1. Open rancher email with 4 buttons (use existing referral)
2. Click "💬 In Talks" → confirms + flips status
3. Verify Last Rancher Activity At stamped
4. Click "✓ Closed Won" → form asks for amount → submit
5. Verify Stripe invoice flow same as 6.2

### 6.4 Inbound reply

1. Send synthetic email to `bhc-ref-X@replies.buyhalfcow.com` from buyer's address
2. Verify Conversations row created
3. Verify Last Buyer Activity At stamped on referral

### 6.5 Rancher landing page order

1. Navigate `/ranchers/ashcraftbeef`
2. Click "Request Half →"
3. Fill name + email + state → submit
4. Verify Referral created Direct (Rancher Page)
5. Verify both emails sent

---

## 7. EXECUTION SEQUENCE — order of operations

### Phase 0: Verify maintenance on (DONE)

- ✅ 7/8 crons report "MAINTENANCE_MODE is ON"
- ✅ Healthcheck still runs (intentional)

### Phase 1: Investigate (READ-ONLY, no writes)

- [x] Audit referral-chasup cron — proven
- [ ] Audit batch-approve, stuck-buyer-recovery, rancher-trust-promotion (read code, no writes)
- [ ] Audit Conversations table — confirm inbound webhook stamps work
- [ ] Audit one of each rancher's pipeline (sample 3 ranchers) — find missing closed deals like Beckie

### Phase 2: Recovery emails (8 emails, no data writes from script)

- [ ] Build digest script per rancher: pull their auto-killed leads + render with 4 action buttons
- [ ] Dry-run output: show user the 8 emails before sending
- [ ] User approves → send 8 emails
- [ ] Wait 24-72h for rancher responses

### Phase 3: Code changes (feature branch, NOT main)

- [ ] Schema additions on Airtable (3 fields + 1 formula)
- [ ] Migration: backfill `Last Rancher Activity At = Intro Sent At` for active referrals
- [ ] Code changes (5 files) per Section 2.2
- [ ] Push to feature branch → Vercel preview deploy

### Phase 4: Dry-run cron in preview

- [ ] Hit `?dryRun=1` on referral-chasup, stuck-buyer-recovery, batch-approve on preview
- [ ] Output: list of records that WOULD be touched, no writes
- [ ] User reviews + approves output
- [ ] Inspect: no false auto-closes, no double-routes

### Phase 5: Merge + maintain maintenance

- [ ] Merge feature branch to main
- [ ] Latest deploy on prod still respects MAINTENANCE_MODE=true
- [ ] Verify deployed code has new schema reads + cron logic

### Phase 6: E2E test in browser

- [ ] Run Section 6 tests against prod (maintenance still on — endpoints will short-circuit some)
- [ ] OR: temporarily flip maintenance off, run tests, flip back on
- [ ] Verify all 5 customer flows work end-to-end

### Phase 7: Flip maintenance off + day-1 watch

- [ ] Flip MAINTENANCE_MODE=false (or empty) → redeploy if needed
- [ ] Watch first cron runs (next morning) — Telegram digest summarizes what each did
- [ ] Operator (Ben) confirms no false-positive auto-closes
- [ ] Hot-fix if any anomaly

### Phase 8: Continuous monitoring

- [ ] Daily Telegram digest: cron run summary + any auto-close prompts to ranchers
- [ ] Weekly: counter-drift sanity check between Current Active Referrals and real count
- [ ] Monthly: full data integrity audit per Section 5

---

## 8. AGREEMENTS + ONBOARDING (parallel track, after Phase 7)

### 8.1 Five working-with-Ben tiers

| Tier | Monthly fee | Commission | Includes |
|---|---|---|---|
| Base | $0 | 10% | Listing on map, matched buyers, dashboard |
| Tier 1 | $250 | 5% | + monthly content support, ManyChat optimization, channel features |
| Tier 2 | $500 | 3.5% | + dedicated content production, email campaigns to buyer list |
| Tier 3 | $1,500 | 2% | + white-glove network of creators, full marketing system upside |
| Pilot | $0 | 10% | First 3 customers free, then move to chosen retainer tier |

### 8.2 Schema

- New Ranchers field: `Agreement Tier` (singleSelect: Base / Tier 1 / Tier 2 / Tier 3 / Pilot)
- New Ranchers field: `Monthly Retainer Active` (checkbox)
- Existing `Agreement Signed` stays as the base signature flag

### 8.3 Sign-agreement page renders per tier

- `/rancher/sign-agreement?tier=X` reads tier → renders correct contract variant
- Signature flow stamps `Agreement Tier`, `Agreement Tier Signed`, `Agreement Tier Signed At`

### 8.4 Stripe Connect (future, Phase 9)

- Stripe Connect Express for direct splits
- Rancher's Stripe account receives 90% / 95% / 96.5% / 98% per tier auto-split
- BHC keeps the rest

### 8.5 Team onboarding

- `docs/TEAM-ONBOARDING.md` — access matrix, skill list, customer flow diagram, agreement templates
- Per-role: VA / sales rep / content / admin
- Each role gets specific Vercel/Airtable/Resend/ManyChat/Stripe access scoped to need

---

## 9. WHAT I NEED FROM YOU TO START

**Phase 1 (investigation) is read-only. I'm doing it now. No approval needed.**

**Phase 2 (recovery emails) requires your approval:**
- Send 8 rancher recovery digests? OR you handle rancher communication another way?
- If approved: I write digest script, show dry-run, you approve → send

**Phase 3 (code changes) requires your approval:**
- Schema additions to Airtable OK?
- Code change diff acceptable?
- Want anything different in the design above?

**Phase 4-7 happen after Phase 3 approval.**

**Phase 8 (agreements) — defer until cashflow loop is bulletproof. Bundle the 5 tier templates into a single PR later.**

---

## 10. ROLLBACK PLAN

Every phase reversible:

- Phase 2 (emails): once sent, can't unsend, but rancher clicks are individually idempotent
- Phase 3 (code): revert merge commit, MAINTENANCE_MODE still ON, no live damage
- Phase 7 (maintenance off): flip back to ON if anything anomalous within first 24h
- Schema: new fields are additive, no breaking change. Can leave them empty if rollback needed.

---

## END OF PLAN

Last verification step before any execution: you confirm you've read this + sign off on Phase 2.
