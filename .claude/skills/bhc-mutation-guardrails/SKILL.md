---
name: bhc-mutation-guardrails
description: Use BEFORE any bulk Airtable mutation, mass email send, or scripted call to /api/matching/suggest, /api/orders/request, /api/consumers, or webhook triggers. Hard gate to prevent the chaos pattern from 2026-05-06 (109 stale-lead pushes to ranchers, TX→OK misroutes, fields silently stripped, etc).
---

# BHC Mutation Guardrails

## Why this exists

On 2026-05-06 a series of bulk mutation scripts caused real customer pain:

- 109 stale leads pushed to ranchers without verifying buyer opt-in
- 20 TX buyers routed to OK rancher (matching engine bug + no per-record verification)
- 100+ malformed staged referrals from `createRecord` silently stripping fields
- Stripe webhook missing `invoice.paid` subscription → silent commission tracking failure
- Counter drift assumed (it wasn't) → blown investigation cycles
- Mass scripts bypassed user-facing flow gates (timing check, intent score, warmup engagement)

**The pattern:** I executed bulk writes without per-record validation that mirrored the production flow's gates. Every shortcut bit a customer.

## Hard rules (no exceptions without explicit user OK per rule)

### Rule 1 — Mirror the production flow's gates

**WHEN:** running ANY script that calls `/api/matching/suggest`, fires intro emails to ranchers, creates Referrals, or sends bulk emails.

**REQUIRED CHECK BEFORE EACH RECORD:**
1. Does the buyer have `Status='Approved'`? (verified)
2. Is `Bounced` / `Unsubscribed` / `Complained` all false?
3. For matching: does the buyer have `Warmup Engaged At` set within last 30d? OR is this a brand-new signup (within last 24h)?
4. For matching: timing field NOT in `[just exploring, 3-6 months]` set?
5. For matching: order type NOT in `[unsure, not sure]` set?
6. For matching: server-computed Intent Score >= 60?

**If ANY check fails:** skip that record, log to a dropped[] array, surface to user at end.

**Don't bypass gates "because the data needs cleaning up." Cleaning up = sending stale leads to ranchers in production.**

### Rule 2 — Side-effect inventory required BEFORE running

**WHEN:** any bulk operation (>5 records).

**MUST present BEFORE executing:**
1. Number of records affected
2. Number of EMAILS that will fire (rancher intros + buyer notifications + admin Telegram)
3. Number of WEBHOOK side-effects (Stripe invoices generated, Cal bookings, etc.)
4. Number of COUNTER mutations (Active Referrals increments, Buyer Stage flips)
5. **REVERSIBILITY PLAN** — exactly which records to flip back to which status if user says "undo"
6. Sample of 3-5 records that will be affected (so user can spot wrong ones)

**Wait for explicit user "go" with full understanding of blast radius. "Yes" or "run it" without context isn't enough.**

Example output before running:
```
About to:
  - Update 109 Referral records: Status=Closed Lost, append note
  - Update 109 Consumer records: Buyer Stage=READY, Referral Status=Unmatched
  - Send 109 re-engagement emails (Resend, ~30s pace)
  - Decrement 11 rancher Current Active Referrals counters

Sample affected:
  Sarah Cooan (CO) → was at Hartsock; reverting + re-engaging
  Jeff Coss (CA) → was at Fitzpatrick; reverting + re-engaging
  ... [3 more]

Reversibility:
  Save Referral IDs + buyer IDs to /tmp/revert-{timestamp}.json
  To undo: re-flip Status to prior value + restore Buyer Stage from log

Reply "go" to execute. "Show all" to see full list. "Cancel" to abort.
```

### Rule 3 — Schema validation BEFORE createRecord

**WHEN:** any call to `createRecord(TABLES.X, fields)` from a script.

**REQUIRED:**
1. Pre-validate every field name against the actual Airtable schema (use `meta/bases/{baseId}/tables`)
2. Pre-validate every singleSelect / multipleSelects value is in the field's options
3. Pre-validate every multipleRecordLinks value is an array of valid record IDs
4. If any field invalid: HARD FAIL the script. Do NOT use the lib's silent-strip retry.

**Why:** the silent-strip retry in `lib/airtable.ts` is FOR THE WEB APP HANDLING USER INPUT (where Airtable schema may drift). For SCRIPTS, silent stripping creates malformed records that cause downstream bugs (the 100+ orphan staged referrals were created this way).

**Better:** always typecast=true and let Airtable error out. Catch the error, fix the script, retry. Don't strip.

### Rule 4 — Dry-run first, ALWAYS, no exceptions

**WHEN:** any script that mutates production data.

**REQUIRED:**
- First run with `--dry-run` flag default
- Output exactly what WOULD be changed (sample of 3-5 records + total count)
- Side-effect inventory (Rule 2)
- Reversibility plan (Rule 2)
- Only execute on explicit `--execute` flag AND user "go"

**Don't infer "user approved." Infer ONLY when they explicitly typed "go" or "run it" after seeing the side-effect inventory.**

### Rule 5 — Idempotency check before writes

**WHEN:** any update to a record that triggers side effects (matching, emails, counters).

**REQUIRED:**
1. Before update, read current state
2. If new state == current state → skip the write (no-op)
3. If first transition to a terminal state → fire side effects
4. If repeat transition → skip side effects (Stripe invoice already generated, etc.)

**Why:** running the same script twice was bricking counters earlier. Idempotency by default.

### Rule 6 — Empirically verify root cause BEFORE proposing fix

**WHEN:** a bug is reported.

**REQUIRED:**
1. Reproduce the bug with a synthetic test (don't trust user's description without verification)
2. Add diagnostic logging at component boundaries
3. Confirm the failing layer with evidence
4. ONLY then propose fix
5. Pattern recognition is NOT root cause investigation. ("This looks like X anti-pattern" is a hypothesis, not proof.)

**The 2026-05-06 useSearchParams loop fix worked, but I didn't first prove useSearchParams returns a fresh ref each render. Got lucky. Don't rely on luck.**

### Rule 7 — Test E2E in browser BEFORE claiming fix verified

**WHEN:** any client-side or full-stack fix.

**REQUIRED:**
1. After deploy, hit prod in real browser via Claude-in-Chrome
2. Verify: page loads, JS executes (Runtime.evaluate < 1s), form submits, Airtable record created
3. Curl-only verification is NOT enough — `/access` HTML returned 200 but the form was unhittable. Curl can't tell.

### Rule 8 — Three-strike rule for failed fixes

**WHEN:** a fix didn't resolve the issue.

**REQUIRED:**
- Fix #1 fails → Phase 1 again with new evidence
- Fix #2 fails → check architectural assumptions
- Fix #3 fails → STOP. Surface to user. Don't try Fix #4.

**Today I retried matching/suggest after the first failure (counter drift hypothesis) and would have wasted user time if I'd kept guessing. Surface the dead-end fast.**

## Pre-flight checklist (run mentally before EVERY bulk action)

```
[ ] Have I read the production flow's gate logic for this operation?
[ ] Am I replicating ALL of those gates per record (not skipping any)?
[ ] Did I run --dry-run first?
[ ] Did I show user the side-effect inventory?
[ ] Did I show user a 3-5 record sample?
[ ] Did user say "go" AFTER seeing the inventory?
[ ] Do I have a reversibility plan written down?
[ ] Are my writes idempotent?
[ ] Are my createRecord field names + values validated against schema?
[ ] If side effects fire (emails, webhooks): can I undo if user changes mind in 5 minutes?
```

**If any box unchecked: STOP. Fix it. Don't run.**

## Specific gates per BHC operation

### `/api/matching/suggest` — calling from script
- Buyer must have: Status=Approved, no Bounced/Unsub/Complained
- For mass-fire: Warmup Engaged At within 30d (the opt-in gate)
- Buyer's State must have a Live rancher (else don't fire — leave waitlisted)
- If buyer already has active Referral with the rancher → skip (idempotent)
- Track which buyers were skipped + why

### `createRecord(REFERRALS, ...)`
- Required fields: `Buyer` link, `Status`, `Buyer Email`, `Buyer State`
- For Pending Approval: also `Suggested Rancher` link, `Approval Status='pending-approval'`, `Match Type` (must be in `['Local','Nationwide','Direct (Rancher Page)']`)
- Validate ALL singleSelect values against schema
- Use `typecast: true` AND fail-loud on Airtable errors

### Bulk email send via Resend
- Filter recipients: `not Bounced AND not Unsubscribed AND not Complained AND has Email`
- Pace: 0.5-1s per email (deliverability + Resend rate limits)
- Subject + reply-to MUST be set explicitly
- Subject MUST NOT contain spam triggers ("FREE", excessive caps, etc.)
- Include unsubscribe link in body
- Log Resend message ID per send for traceability

### Mass cap bumps on ranchers
- Confirm with user the new cap per rancher (not a blanket bump)
- Consider whether the rancher actually wants more leads (biz decision)
- Don't bump beyond what they've consented to — better to stay constrained + recruit more ranchers

### Mass marking referrals Closed Lost
- Always include reason note in `Notes` field
- Always decrement rancher `Current Active Referrals` if was previously active
- Never close referrals where buyer has truly engaged (rancher reached out, buyer responded — those need rancher decision, not script)

## When you screw up

If a bulk mutation creates a problem:
1. STOP further mutations immediately
2. Write a revert script that restores prior state
3. Run revert with --dry-run, show user side-effect inventory of REVERSAL
4. User OKs, run revert with --execute
5. Document the failure mode in this skill so it doesn't repeat
6. Never just "leave it" — half-applied bulk mutations rot

## Trigger phrases that activate this skill

- "Run it" / "Go" on any bulk operation context
- "Push these through matching"
- "Send this email blast"
- "Mark all X as Closed Lost"
- "Bump caps"
- "Heal stranded buyers"
- "Re-engage buyers"
- "Reset N records"

If user types any of these, run the pre-flight checklist before action.
