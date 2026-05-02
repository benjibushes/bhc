# Stage 1 Pipeline Rebuild — Full Changelog

> **Purpose**: handoff document for AI agents and humans coming into the
> BuyHalfCow codebase mid-rebuild. Captures every change in the
> `pipeline-rebuild` branch, the strategic context that produced them, and
> the ship plan. Read this top to bottom before touching any customer-facing
> code in this repo.

**Branch**: `pipeline-rebuild` (local-only, not pushed to main)
**Timeline**: rebuild started 2026-04-30, awaiting ship gate
**Status**: code complete, typecheck + build clean, awaiting user review + merge command
**Author voice**: Benjamin (founder), lowercase, direct — anchor emails are `sendMerchEmail` + `sendBrimstone*` + `sendReadyToBuyPrompt` (the last one was deleted in the strip but its style is preserved in `sendWelcomeAndReadyToBuy`)

---

## 1. Strategic context

### The problem we rebuilt around
Pre-rebuild the customer-side experience was a "Frankenstein" — three parallel
state-machine fields driving emails independently of each other:

1. `Sequence Stage` (drove `email-sequences` cron's nurture branches)
2. `Warmup Stage` + `Warmup Sent At` (drove `rancher-launch-warmup` cron)
3. `Referral Status` + `Intro Sent At` on the Referral record (drove intro
   check-in + chase emails)

Each cron read its own field, ignored the other two. Result: buyers received
multiple emails on the same day from different pipes, OR got orphaned in
state-machine dead-ends. Audit found ~84% of buyers were stuck in stale
states, 5 customer-facing email functions never fired (including the highest-
rated founder-voice copy), and 24+ instances of a "Private Network for
American Ranch Beef" footer that the brand had outgrown.

### The strategic goal
**Force cashflow from leads already in the system.** ~1,200 approved buyers
were already in the Airtable, with operational ranchers serving 16 states.
The bottleneck wasn't acquisition — it was the broken pipeline preventing
existing leads from converting. Migration shows **441 buyers in READY state
right now** (approved, in-state rancher available, never matched). Each one
is a YES click away from being a transaction.

Secondary goal: this rebuild becomes the proof artifact for recruiting more
ranchers. "Look at this customer machine — sign up and you get plugged in
to it tomorrow."

### What's deferred (explicitly NOT in Stage 1)
- **Stage 2 — Founding Herd capital raise**: 5-tier paid backer campaign at
  `/founders` with Stripe checkout. Plan lives at
  `/Users/benji.bushes/.claude/plans/groovy-scribbling-sky.md`. Starts after
  Stage 1 runs clean for 48-72h.
- **Stage 3 — Rancher onboarding tier-page rebuild**: 3-tier marketing service
  ($0+10% / $499/mo / $1,499/mo) with Calendly + intro video on `/partner`.
  Deferred until real-world case studies (Brimstone, Homestead, etc.) prove
  the marketing service drives results.
- **60-second rancher intro videos**: defer to phase B. Placeholders work for
  ship.
- **Tag-a-rancher referral mechanic** (Robinhood waitlist pattern): defer.
- **Homepage redesign**: current one is buyer-focused enough for ship.
- **Podcast outreach pipeline** (Force of Nature playbook): separate
  workstream, no code involvement.

---

## 2. The state machine — `Buyer Stage`

Single source of truth replacing the 3 parallel fields. **Five values, one
field, all transitions instrumented.**

```
NEW          → just signed up, awaiting approval
                (handled by abandoned-recovery flow, no Buyer Stage write)
WAITING      → approved, no rancher in their state
                (receives monthly founder letters via cron)
READY        → approved, rancher exists in state, hasn't clicked YES yet
                (received welcome email with YES button, Day 7 nudge if no click)
MATCHED      → clicked YES, rancher emailed them, deal in flight
                (Day 4 check-in via cron)
CLOSED       → terminal — purchased OR ghosted/suppressed/non-responsive
                (purchased branch gets Day 0/14/60+/M5 post-purchase sequence)
```

### Transitions wired into 5 entry points

| Event | File | Old state → new state |
|-------|------|---------------------|
| Signup form, status=Approved + rancher available + qualified + auto-routed | `app/api/consumers/route.ts` | n/a → MATCHED |
| Signup form, status=Approved + rancher available + not auto-routed | `app/api/consumers/route.ts` | n/a → READY |
| Signup form, status=Approved + no rancher in state | `app/api/consumers/route.ts` | n/a → WAITING |
| Signup form, status=Pending | `app/api/consumers/route.ts` | n/a (sends sendConsumerConfirmation only) |
| Batch-approve cron (Pending → Approved) | `app/api/cron/batch-approve/route.ts` | empty → WAITING (default; matching/suggest may override to MATCHED) |
| YES click on warmup email | `app/api/warmup/engage/route.ts` | WAITING/READY → MATCHED |
| matching/suggest finds a match | `app/api/matching/suggest/route.ts` | * → MATCHED |
| matching/suggest finds no match | `app/api/matching/suggest/route.ts` | * → WAITING |
| Rancher marks Closed Won (rancher dashboard) | `app/api/rancher/referrals/[id]/route.ts` | MATCHED → CLOSED + fires `sendPostPurchaseWelcome` |
| Admin marks Closed Won | `app/api/referrals/[id]/route.ts` | MATCHED → CLOSED + fires `sendPostPurchaseWelcome` |

### Cron-driven stage-relative milestones

The consolidated cron in `app/api/cron/email-sequences/route.ts` reads
`Buyer Stage Updated At` to compute days-in-stage and fires the next
milestone email. `Sequence Stage` is reused as a per-stage progress marker
with stage-prefixed values (e.g., `WAITING_L1`, `MATCHED_D4`, `CLOSED_CUTS`)
to prevent duplicate sends.

| Stage | Days | Email | Sequence Stage marker |
|-------|------|-------|----------------------|
| WAITING | 7 | `sendFounderLetterWaiting({letterNumber: 1})` | `WAITING_L1` |
| WAITING | 30 | `sendFounderLetterWaiting({letterNumber: 2})` | `WAITING_L2` |
| WAITING | 60+, monthly | `sendFounderLetterWaiting({letterNumber: N})` | `WAITING_L3`, `_L4`, ... |
| READY | 7 | last-call nudge (inline `sendEmail`, single CTA YES button) | `READY_NUDGE` |
| MATCHED | 4 | `sendMatchedDay4CheckIn` | `MATCHED_D4` |
| CLOSED (purchased) | 0 (event) | `sendPostPurchaseWelcome` | (fires from close handler, not cron) |
| CLOSED (purchased) | 14 | `sendCutsEducation` | `CLOSED_CUTS` |
| CLOSED (purchased) | 60 | `sendClosedMonthlyLetter({monthNumber: 2})` | `CLOSED_M2` |
| CLOSED (purchased) | 90 | `sendClosedMonthlyLetter({monthNumber: 3})` | `CLOSED_M3` |
| CLOSED (purchased) | 120 | `sendClosedMonthlyLetter({monthNumber: 4})` | `CLOSED_M4` |
| CLOSED (purchased) | 150 | `sendRepeatPurchaseAsk` | `CLOSED_REPEAT` |
| CLOSED (suppressed/ghosted) | n/a | (no further outreach) | — |

24-hour frequency gate prevents two automated emails to the same buyer in
one calendar day.

---

## 3. Airtable schema changes

### New fields on `Consumers` table (`tblAbjQDnLrOtjpoE`)
| Field name | Field ID | Type | Description |
|-----------|----------|------|-------------|
| `Buyer Stage` | `fld8j9SRKgel89QaM` | singleSelect | NEW/WAITING/READY/MATCHED/CLOSED — single source of truth for buyer pipeline state |
| `Buyer Stage Updated At` | `fldKJBNxrgk3Am9pH` | dateTime (UTC ISO) | Timestamp of last stage transition. Used by cron for days-in-stage math. |

### Fields NOT changed (kept as-is for migration safety + audit trail)
- `Sequence Stage` — repurposed as per-stage progress marker with stage-prefixed values
- `Warmup Stage` + `Warmup Sent At` — used by `rancher-launch-warmup` cron (untouched in this rebuild)
- `Referral Status` — used by various crons + UI (untouched)
- `Buyer Health` — used by `isQualifiedForRouting` (untouched)
- All other fields untouched

### Base info
- Base ID: `appgLT4z009iwAfhs`
- Tables: `Consumers` (`tblAbjQDnLrOtjpoE`), `Ranchers` (`tbl08y9Be45zNG0OG`), `Referrals` (`tblBfimb4Gt8C0fu4`)

---

## 4. Strip pass — what was deleted

### Email functions deleted (17 total: 15 dead-code + 2 newly orphaned by refactor)

#### First wave (15 dead-code, no callers found anywhere)
| Function | Removed from | Reason |
|----------|-------------|--------|
| `sendChaseUpEmail` | `lib/email.ts` | 0 callers — generic AI-drafted body, never wired |
| `sendNurtureDay3` | `lib/email.ts` | 0 callers — **strongest founder-voice copy in codebase** (rescued to `lib/_rescued-copy.md`) |
| `sendNurtureDay10` | `lib/email.ts` | 0 callers — also strongest copy (rescued) |
| `sendNurtureAffiliate` | `lib/email.ts` | 0 callers — vague reward, would rewrite from scratch for tag-a-rancher mechanic |
| `sendRancherNowAvailable` | `lib/email.ts` | 0 callers — duplicate of `sendRancherLaunchWarmup` |
| `sendBrimstoneArizonaWarmup` | `lib/email.ts` | 0 callers — Brimstone launch script inlines its own templates |
| `sendBrimstoneNevadaWarmup` | `lib/email.ts` | 0 callers — same as above |
| `sendSequenceEmail_BeefDay3` | `lib/email.ts` | 0 callers after cron strip |
| `sendSequenceEmail_BeefDay7` | `lib/email.ts` | 0 callers after cron strip |
| `sendSequenceEmail_CommunityDay7` | `lib/email.ts` | 0 callers after cron strip — Community segment killed |
| `sendSequenceEmail_CommunityDay14` | `lib/email.ts` | same as above |
| `sendNurtureWhy` | `lib/email.ts` | 0 callers after cron strip — generic claim "10,000 families" was unverified |
| `sendNurtureHow` | `lib/email.ts` | 0 callers after cron strip — content moves to homepage / FAQ |
| `sendNurtureUrgency` | `lib/email.ts` | 0 callers after cron strip — manufactured urgency |
| `sendNurtureReferral` | `lib/email.ts` | 0 callers after cron strip — generic referral copy |

#### Second wave (2 newly orphaned by `/api/consumers` refactor)
| Function | Reason |
|----------|--------|
| `sendReadyToBuyPrompt` | Replaced by `sendWelcomeAndReadyToBuy` (which collapses 3 emails into 1) |
| `sendIntroCheckInEmail` | Replaced by `sendMatchedDay4CheckIn` (cleaner founder voice, single CTA) |

### Cron branches deleted from `app/api/cron/email-sequences/route.ts`
6 dead branches removed:
1. Phase 1 5-step "no rancher" nurture path (`sendNurtureWhy/How/Urgency/Merch/Referral`)
2. Beef Buyer segment Day 3 branch
3. Beef Buyer segment Day 7 branch
4. Community segment Day 7 branch
5. Community segment Day 14 branch
6. Standalone intro check-in section (referral-driven, replaced by `MATCHED` Day 4 in state-machine driver)

### Pages deleted
- `app/update-profile/page.tsx` (zero inbound links, stale form options that contradicted `/access`)
- `app/components/WaitlistLanding.tsx` (the maintenance-mode alternate homepage that said nothing about beef)
- Maintenance-mode branch in `app/page.tsx` removed (no longer renders WaitlistLanding when `MAINTENANCE_MODE=true`)

### Copy debris purged
- `"BuyHalfCow — Private Network for American Ranch Beef"` footer: 24+ instances across 6 files
  - Files affected: `app/api/auth/member/login/route.ts`, `app/api/auth/rancher/login/route.ts`, `app/api/backfill/send-campaign/route.ts`, `app/api/ranchers/sign-agreement/route.ts`, `app/api/ranchers/[id]/send-onboarding/route.ts`, `lib/email.ts`
  - Replacement: simple address line `BuyHalfCow · 1001 S. Main St. Ste 600, Kalispell, MT 59901`
- `"The HERD"` / `"BHC Network"` / `"Welcome to The HERD"`: 13 instances across 4 files
  - Files affected: `app/access/layout.tsx`, `app/components/Header.tsx`, `lib/email.ts`, `app/faq/page.tsx`
  - Replacements: "Get Access" CTA, "BuyHalfCow" brand, "the network" generic, etc.

### Homepage demotion
`app/components/FullHomepage.tsx` previously had a 4-card "Pick Your Path" grid forcing visitors to self-segment between buyer / rancher / land seller / brand. The buyer (highest-volume audience) was 1 of 4 equal-weight cards. Replaced with a single buyer-focused CTA + small "are you a rancher, brand, or have land?" footer link to `/partner`.

`/land` and `/brand` pages preserved (Stage 2 Founding Herd plan reuses Brand checkout pattern as a code template), just demoted from homepage CTAs to footer-only links.

### Net line counts
- `lib/email.ts`: 3218 → 2750 (-468 lines net, accounting for 7 new functions added)
- `email-sequences` cron: 510 → ~470 lines (kept abandoned-recovery + rancher-reminder sections)
- 38 send functions remaining (down from 47)

---

## 5. New code — what was built

### 7 new founder-voice email functions in `lib/email.ts`

All follow the lowercase-founder voice pattern. Anchor style: `sendMerchEmail`,
`sendBrimstone*`, the deleted `sendReadyToBuyPrompt`. No marketing-style
headers, no "Private Network" footer, signed `— Benjamin` or `— Ben`.

#### `sendWelcomeAndReadyToBuy({ firstName, email, state, rancherAvailable, engageUrl? })`
Single email replacing the 3-email signup flow (sendConsumerConfirmation → sendConsumerApproval → sendReadyToBuyPrompt OR sendWaitlistEmail). State-aware:
- `rancherAvailable=true`: includes the YES button (engageUrl) and "Are you ready to buy in the next 1–2 months?" prompt
- `rancherAvailable=false`: explains the wait + monthly letter cadence

Subject line: `${first}, you're in — quick question to lock in your match` OR `${first}, you're in — what's happening in ${stateLabel}`

#### `sendFounderLetterWaiting({ firstName, email, state, letterNumber })`
Rolling monthly check-in for WAITING buyers. Three letter variants:
- Letter 1 (Day 7): "what's actually happening — month one update" (rescued from `sendNurtureDay3` voice)
- Letter 2 (Day 30): "the ranchers I'm meeting are the real deal" (rescued from `sendNurtureDay10` — includes the mission line *"We're gonna take back American ranching and agriculture"*)
- Letter 3+ (monthly): "month {N} update — {state} status"

Asks for help: forward to a rancher, reply with cut/timing.

#### `sendMatchedDay4CheckIn({ firstName, email, rancherName })`
Replaces 2 duplicate Day-7 follow-ups (`sendIntroCheckInEmail` + `sendSequenceEmail_BeefDay7` had nearly-identical copy 4 days apart). Single ask: "did you connect with {rancher}?" Reply expected.

Subject: `did you connect with ${rancherName}?`

#### `sendPostPurchaseWelcome({ firstName, email, rancherName, orderType })`
Day 0 handshake (fires from close handlers, not cron). Sets expectations for the 4-week processing gap. Tier-aware: shows correct lbs (~85/170/340) and freezer cu ft (~3-4 / 6-8 / 12-16).

Subject: `welcome to your first ranch order — what to expect`

#### `sendCutsEducation({ firstName, email, orderType })`
Day 14 cuts cheat sheet. Cooks-first list (chuck roast, short ribs, oxtail, tongue), reliable everyday cuts (ground/stew/sirloin/ribeye), two rules (thaw in fridge, stack flat). Premium DTC-food retention move per research (ButcherBox + Wild Idea pattern).

Subject: `your ${tier} cheat sheet — what to cook first`

#### `sendClosedMonthlyLetter({ firstName, email, monthNumber })`
Day 60+ rolling content during the long-quiet window (months 2-5 post-purchase). Patagonia Provisions pattern. New ranchers, new states, what's hard.

Subject: `month ${monthNumber} — what's happening in the network`

#### `sendRepeatPurchaseAsk({ firstName, email, rancherName })`
Month 5 re-engagement. Anticipates the buyer instead of reacting. 3-option reply: "yes" / "different" / "not yet".

Subject: `running low? want me to ping ${rancherName}?`

### New page: `app/matched/page.tsx`
Ceremonial handoff page that renders after a successful YES click. Reads `?rancher={name}&state={ST}` query params. Shows:
- Big handshake emoji
- "You're being matched with {rancherName}"
- "Within 24-48 hours" expectation-setting box
- "Heads up: {state} area code" so buyer doesn't miss the rancher's call

`/api/warmup/engage` redirects here with rancher info from the matching/suggest response. Falls back to `/member?warmup=engaged` if no match.

### New cron driver in `app/api/cron/email-sequences/route.ts`
Replaces the stripped-out 8-branch sprawl. Single loop over approved consumers, branches by `Buyer Stage`, computes days-in-stage from `Buyer Stage Updated At`, fires the right milestone email. Pre-computes maps of buyer→active referral and buyer→Closed Won referral for `MATCHED` and `CLOSED` branches.

### New scripts
- `scripts/buyer-stage-migration.mjs` — dry-runnable migration for the 1,345 existing Consumers. Maps to Buyer Stage based on observable facts (Status, suppression flags, Buyer Health, active referral, rancher availability). Idempotent.
- `scripts/relaunch-broadcast.mjs` — fires once on ship-day to ~922 existing buyers in WAITING or READY. State-aware copy. MATCHED/CLOSED untouched.

### New documentation
- `lib/_rescued-copy.md` — rescued founder-voice copy from deleted `sendNurtureDay3` + `sendNurtureDay10` (the audit's strongest-rated copy). Voice-anchor reference for future rewrites.
- `REBUILD-RUNBOOK.md` — ship-day execution sequence + rollback plan + smoke tests + post-ship metrics.
- `STAGE-1-REBUILD-CHANGELOG.md` — this file.

---

## 6. Modified files (refactored, not rewritten)

### `app/api/consumers/route.ts` (signup endpoint)
- Replaced 3-email signup flow (`sendConsumerConfirmation` + `sendConsumerApproval` + `sendReadyToBuyPrompt` OR `sendWaitlistEmail`) with single `sendWelcomeAndReadyToBuy` call when status === Approved
- `sendConsumerConfirmation` retained for the rare status !== Approved (Pending) path
- Added Buyer Stage transition logic: WAITING (no rancher) / READY (rancher, not auto-routed) / MATCHED (auto-routed successfully)
- Form qualification gate kept (intent score + budget bracket + phone + timing)
- Auto-route via matching/suggest preserved with `warmupEngaged: false`

### `app/api/cron/batch-approve/route.ts`
- One-line addition: sets `Buyer Stage: 'WAITING'` + `Buyer Stage Updated At` on every approval
- matching/suggest may override to MATCHED if it routes successfully
- Still uses legacy `sendConsumerApproval` + `sendBackfillEmail` + `sendWaitlistEmail` (these remain because they're the safety-net emails for the rare Pending → Approved cron path; primary signup uses the new combined email)

### `app/api/warmup/engage/route.ts`
- YES click now sets Buyer Stage = MATCHED + Buyer Stage Updated At
- Captures rancher name + state from matching/suggest response
- Redirects to new `/matched?rancher=&state=` ceremonial handoff page (was redirecting to `/member?warmup=engaged`)

### `app/api/matching/suggest/route.ts`
- Match found → sets Buyer Stage = MATCHED on the consumer
- No match found → sets Buyer Stage = WAITING + Referral Status = Waitlisted

### `app/api/rancher/referrals/[id]/route.ts` (rancher dashboard close handler)
- Closed Won path now: sets `Buyer Stage = CLOSED` + `Buyer Stage Updated At` + `Sequence Stage = ''` (clears for clean post-purchase track)
- Fires `sendPostPurchaseWelcome` immediately (Day 0 handshake)

### `app/api/referrals/[id]/route.ts` (admin close handler)
- Mirrors the rancher-dashboard close handler — same Closed Won transition + same Day 0 welcome email send

### `app/page.tsx`
- Removed maintenance-mode fork (`isMaintenanceMode()` no longer switches between two homepages)
- Imports `FullHomepage` only

### `app/components/FullHomepage.tsx`
- 4-audience grid replaced with single buyer-focused CTA
- Small footer link to `/partner` for rancher/brand/land

### `app/components/Header.tsx`
- Mobile nav CTA "Join The HERD" → "Get Access"

### `app/access/layout.tsx`
- Page metadata title "Join The HERD" → "Get Access — BuyHalfCow"

### `app/faq/page.tsx`
- "The HERD" → "the network" everywhere it appeared

### `lib/email.ts`
- 7 new founder-voice functions (see Section 5)
- Various copy strips: removed "Private Network" footer line, replaced "The HERD" / "BHC Network" with neutral language in `sendConsumerApproval` body + subject + `sendPartnerConfirmation` body

---

## 7. Files NOT modified (preserved as-is)

These are untouched in Stage 1 — flagged for reviewers so you don't think there's a missing diff:

- `app/api/cron/rancher-launch-warmup/route.ts` — handles "rancher just activated" event, fires warmup emails to Waitlisted buyers in their state. Filter still uses `Referral Status = "Waitlisted"`. Migration preserved Referral Status, so it continues to work. **Known gap**: this cron's filter doesn't know about Buyer Stage — buyers without a Referral Status (rare edge case) wouldn't be picked up. Acceptable for ship; tracked for future tightening.
- `app/api/cron/referral-chasup/route.ts` — rancher-side chase emails for stale referrals. Untouched. Continues to work via legacy fields.
- `lib/email.ts: sendBuyerIntroNotification` — the highest-stakes email (matched buyer gets rancher contact info). Audit flagged 5 competing CTAs — NOT cleaned in this ship to keep risk low. Future iteration.
- `lib/email.ts: sendRancherLaunchWarmup` + `sendRancherLaunchWarmupNudge` — already in founder voice, working well. Untouched.
- `lib/email.ts: sendConsumerApproval` — kept (4 callers remain in batch-approve, admin consumers, telegram webhook). Will be deprecated in a future iteration once those callers migrate.
- `lib/email.ts: sendWaitlistEmail` — kept (1 caller in batch-approve). Will be deprecated.
- `lib/email.ts: sendRepeatPurchaseEmail` — kept (1 caller in referral-chasup). Replaced by `sendRepeatPurchaseAsk` in cron-driven flow but old function still has a legacy caller.
- All rancher-side / admin-side / brand-side / land-deals / affiliate-side endpoints — untouched.
- `app/components/WaitlistLanding.tsx` — DELETED (was 1 of the 2 homepages).
- `vercel.json` — cron schedule unchanged.

---

## 8. Ship sequence (from `REBUILD-RUNBOOK.md`)

Once user gives the "ship it" command:

1. **Pre-flight** (~2 min): `git checkout pipeline-rebuild`, `npx tsc --noEmit`, `npm run build`, dry-run migration
2. **Pause crons** (~1 min): set `MAINTENANCE_MODE=true` on Vercel + redeploy
3. **Run migration** (~2-5 min): `node scripts/buyer-stage-migration.mjs --execute`
4. **Merge to main** (~1 min): `git merge pipeline-rebuild --no-ff` + `git push`
5. **Unpause crons** (~30s): unset `MAINTENANCE_MODE` + redeploy
6. **Re-relaunch broadcast** (~5 min): `node scripts/relaunch-broadcast.mjs --execute`
7. **Watch first 24h**: Telegram alerts on YES clicks, closes, nightly audit

### Rollback plan
- Code rollback: `git revert <merge-commit>` + push (Vercel auto-deploys)
- Data rollback: not needed — migration only adds new fields, doesn't modify or delete prior fields. Old cron logic resumes reading legacy `Sequence Stage` cleanly under reverted code.

---

## 9. Migration distribution (dry-run output)

```
Consumers in Airtable: 1345
Ranchers (operational): 16 states served — CA, CO, GA, ID, KS, MT, NC, NE, NM, OK, OR, TN, TX, UT, WA, WY

Distribution after migration:
  NEW:                     0   (signups not yet approved)
  WAITING:                 480 (approved, no rancher in state)
  READY:                   441 (approved, rancher available — re-engagement targets)
  MATCHED:                 358 (active referral in flight)
  CLOSED:                  22  (all suppressed/unsubscribed; 0 purchased — Closed Won data was missing pre-rebuild)
  SKIPPED (not approved):  44

READY breakdown by state (the cashflow targets):
  TX: 108 · CA: 100 · NC: 38 · WA: 31 · TN: 30 · ID: 23 · OR: 19 · GA: 18 ·
  CO: 18 · OK: 13 · UT: 11 · KS: 10 · NM: 8 · NE: 8 · WY: 7
```

The re-relaunch broadcast on ship-day will send:
- ~441 READY buyers: founder-voice email with YES button → instant matching
- ~480 WAITING buyers: founder-voice letter ("what's happening in {state}")
- 0 to MATCHED or CLOSED (in-flight deals untouched)

---

## 10. Voice + copy guidelines (for any AI agent writing more emails)

Match the founder voice anchored by:
- `lib/email.ts: sendMerchEmail` (subject: `quick story behind the hat`)
- `lib/email.ts: sendWelcomeAndReadyToBuy`
- `lib/email.ts: sendFounderLetterWaiting`
- `scripts/brimstone-course-correct.mjs`

### Voice rules
- Lowercase opener: `Hey {firstName},` or `Hi {firstName},` (no "Dear")
- Lowercase, conversational subject lines: `quick story behind the hat`, `did you connect with {rancher}?`, `running low? want me to ping...`
- "Quick update —" or "Quick check-in —" defuses sales pressure
- First-person founder presence: "I'm on the road", "I introduced you to..."
- Single primary CTA per email, no menus
- No corporate footer ("Private Network for American Ranch Beef" was the worst offender — never use)
- Sign off: `— Ben` or `— Benjamin` or `— Benjamin, Founder`
- Address line in footer: `BuyHalfCow · 1001 S. Main St. Ste 600, Kalispell, MT 59901`
- Mission line for occasional anchor: *"We're gonna take back American ranching and agriculture."* (italics or pullquote, sparingly)

### Asks
- Reply over click when possible (gives qualitative signal)
- Forward to a rancher (turns waiting buyer into a recruiter)
- Tell me what state + cut they want

### Don'ts
- No emoji prefixes on subjects (audit flagged "🔥 READY TO BUY · Meet your rancher" as jarring)
- No "10,000 families" or unverified scale claims
- No fake scarcity ("only 3 spots left")
- No gamification with points/badges
- No "Welcome to The HERD" / "BHC Network" / "Private Network" branding
- No competing CTAs in one email

---

## 11. Open questions / known issues

### Pending decisions for Stage 2 / Stage 3
- **Tag-a-rancher reward structure** (Stage 3): still TBD — commission-free first share / discount / merch / skip-the-line / cash?
- **60-second video filming approach** (Stage 3): user films during ranch visits OR ranchers self-film with iPhone instructions? Decision: user films during ranch visits.
- **Marketing service tiers** (Stage 3): 3-tier draft locked (Starter $0+10% / Plus $499 / White-Glove $1,499). Will deploy AFTER case studies prove the marketing service.

### Known small gaps in Stage 1 (acceptable for ship)
- `sendBuyerIntroNotification` audit-flagged for 5 competing CTAs — kept as-is; future iteration
- `rancher-launch-warmup` cron filter still uses `Referral Status = "Waitlisted"` not `Buyer Stage = "WAITING"` — both work because migration preserved Referral Status; tighten in next iteration
- `relaunch-broadcast.mjs` not idempotent — if it crashes part-way and restarts, it'll re-email previously-sent buyers. Add `Relaunch Broadcast Sent At` field check before next use
- 3 legacy email functions (`sendConsumerApproval`, `sendWaitlistEmail`, `sendRepeatPurchaseEmail`) still exist with 1-4 callers each. Will be deprecated after caller migrations.

### Known large gaps deferred to phase B
- No homepage rewrite (current one is buyer-focused enough; full design overhaul later)
- No rancher profile page upgrade with photos + 60s video (placeholders work)
- No tag-a-rancher referral mechanic
- No regenerative cert (Savory Institute EOV) — year-long process, doesn't move next 60 days
- No podcast outreach pipeline (acquisition, not retention)

---

## 12. File-by-file change manifest

### Created
| File | Purpose |
|------|---------|
| `app/matched/page.tsx` | Ceremonial handoff page (post-YES-click) |
| `scripts/buyer-stage-migration.mjs` | Dry-runnable migration for 1,345 existing buyers |
| `scripts/relaunch-broadcast.mjs` | Ship-day broadcast to ~922 existing buyers |
| `lib/_rescued-copy.md` | Founder-voice copy reference |
| `REBUILD-RUNBOOK.md` | Ship-day execution + rollback plan |
| `STAGE-1-REBUILD-CHANGELOG.md` | This file |

### Modified
| File | Changes |
|------|---------|
| `lib/email.ts` | -17 functions, +7 new functions, copy debris purged. 3218 → 2750 lines |
| `app/api/cron/email-sequences/route.ts` | -6 dead branches, +1 state-machine driver loop. 510 → ~470 lines |
| `app/api/consumers/route.ts` | 3-email flow → 1-email flow + Buyer Stage transitions |
| `app/api/cron/batch-approve/route.ts` | Sets Buyer Stage = WAITING on approval |
| `app/api/warmup/engage/route.ts` | YES click → MATCHED + redirects to `/matched` |
| `app/api/matching/suggest/route.ts` | Match → MATCHED, no-match → WAITING |
| `app/api/rancher/referrals/[id]/route.ts` | Closed Won → CLOSED + fires Day 0 welcome |
| `app/api/referrals/[id]/route.ts` | Closed Won → CLOSED + fires Day 0 welcome |
| `app/page.tsx` | Removed maintenance-mode homepage fork |
| `app/components/FullHomepage.tsx` | 4-audience grid → 1 buyer CTA + footer link |
| `app/components/Header.tsx` | "Join The HERD" → "Get Access" |
| `app/access/layout.tsx` | Page metadata "Join The HERD" → "Get Access" |
| `app/faq/page.tsx` | "The HERD" → "the network" |
| `app/api/auth/member/login/route.ts` | "Private Network..." footer purged |
| `app/api/auth/rancher/login/route.ts` | "Private Network..." footer purged |
| `app/api/backfill/send-campaign/route.ts` | "Private Network..." footer purged |
| `app/api/ranchers/sign-agreement/route.ts` | "Private Network..." footer purged |
| `app/api/ranchers/[id]/send-onboarding/route.ts` | "Private Network..." footer purged + "The HERD" replaced |

### Deleted
| File | Reason |
|------|--------|
| `app/update-profile/page.tsx` | 0 inbound links, stale form options |
| `app/components/WaitlistLanding.tsx` | 2nd homepage that said nothing about beef |

### Untouched (kept exactly as-is)
- All `app/api/admin/*` routes
- All `app/api/rancher/*` routes (except referrals/[id])
- All `app/api/brands/*` routes (preserved as code template for Stage 2 Founding Herd)
- `app/api/cron/rancher-launch-warmup/route.ts`
- `app/api/cron/referral-chasup/route.ts`
- `app/api/cron/nightly-rancher-audit/route.ts`
- `app/api/cron/batch-approve/route.ts` (only one-line Buyer Stage addition)
- `app/api/webhooks/stripe/route.ts` (Stage 2 will extend this)
- `app/ranchers/[slug]/page.tsx` (rancher landing pages — Stage 3 will polish)
- `vercel.json`
- `.env.local` and Vercel env vars

---

## 13. For AI agents joining mid-rebuild

### What to read first
1. This file (you're reading it)
2. `REBUILD-RUNBOOK.md` (ship sequence)
3. `lib/_rescued-copy.md` (voice anchor)
4. `lib/email.ts` lines 422-700 (the 7 new founder-voice functions — voice reference)
5. `app/api/cron/email-sequences/route.ts` (the state-machine driver)
6. `app/api/consumers/route.ts` (the signup flow)

### Common tasks
- **Adding a new customer-facing email**: write it in `lib/email.ts` matching the founder-voice anchors, wire into either `email-sequences` cron (cron-driven) or an event handler (event-driven). Update Sequence Stage marker if cron-driven so it doesn't re-fire.
- **Adding a new Buyer Stage transition**: identify the event/file, set both `Buyer Stage` AND `Buyer Stage Updated At` in the same `updateRecord` call. Don't forget the timestamp — the cron's days-in-stage math depends on it.
- **Investigating why a buyer isn't getting an email**: check (1) `Buyer Stage` value, (2) `Buyer Stage Updated At` timestamp, (3) `Sequence Stage` marker (should match expected progress for that stage), (4) `Sequence Sent At` (24h frequency gate), (5) suppression flags (`Unsubscribed`/`Bounced`/`Complained`), (6) `Buyer Health = Non-Responsive`.

### Coding conventions
- Use `Edit` tool over `Write` for modifications
- Use `sed` only for multi-block multi-hundred-line deletions
- Always run `npx tsc --noEmit` after structural changes
- Use Airtable MCP for schema mutations (Airtable's UI is fine for one-offs)
- Commit only on user request, never auto-commit during a rebuild branch
- Never push to `main` from a rebuild branch without user "ship it" command

### Voice rules
See Section 10. Most-violated rule: don't write "BuyHalfCow — Private Network for American Ranch Beef" anywhere ever again.

---

## 14. Status check (as of last update)

**Branch**: `pipeline-rebuild` clean, all changes uncommitted (per user instruction "no commits until brand new product is ready to ship as one")

**Final smoke-test results**:
- ✅ `npx tsc --noEmit` clean
- ✅ `npm run build` clean
- ✅ Migration dry-run produces sane distribution (441 READY / 480 WAITING / 358 MATCHED / 22 CLOSED)
- ✅ Re-relaunch broadcast dry-run reads cleanly
- ✅ All Buyer Stage transitions wired across 5 entry points
- ✅ All copy debris purged (zero "Private Network" / "The HERD" / "BHC Network" remaining)

**Awaiting**: user "ship it" command. Once given, execute the 7-step ship sequence in `REBUILD-RUNBOOK.md`.

**After Stage 1 ships and runs clean for 48-72h**: open `founding-herd` branch and start Stage 2 (Founding Herd capital raise) per the queued plan at `/Users/benji.bushes/.claude/plans/groovy-scribbling-sky.md`.
