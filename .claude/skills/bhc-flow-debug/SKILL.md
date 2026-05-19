---
name: bhc-flow-debug
description: Trace a BHC buyer or rancher flow end-to-end to find silent failures. Maps the data flow across boundaries (signup → match → intro → reply → close), identifies where it broke, surfaces file:line. Use when "why didn't X happen for Y", "rancher Z never got their lead", "buyer A clicked YES but no intro", "system silent on B", or any "should-have-fired-but-didn't" question. Read-only.
---

# BHC Flow Debug

Trace one specific buyer-or-rancher's journey through the platform.
Identify the boundary where the flow died. Read-only — propose fix
separately.

## When to invoke

- "Buyer X signed up but never got matched"
- "Rancher Y didn't receive the lead"
- "Z clicked YES but no intro fired"
- "Closed Won fired but no Stripe invoice"
- "Login email never arrived for W"
- "Warmup didn't fire when V went live"
- "/bhc-flow-debug <name>"

## Core principle

Failures in BHC are usually SILENT — a cron skipped a record, an
endpoint 401'd, an email got suppressed, a field had whitespace, a JWT
mismatched. The user-visible symptom is "nothing happened." Trace
backward from the symptom to find which boundary swallowed the event.

Per `superpowers:systematic-debugging`: gather evidence at EVERY layer
before proposing a fix.

## Flows BHC has + their boundaries

### Buyer signup → match flow

```
1. Form POST /api/consumers
   ├─ /access form, /map/add-a-buyer, /matched (?)
   └─ Maintenance gate, rate limit, validation
2. /api/consumers handler
   ├─ Server-side intent score
   ├─ Airtable Consumers create with Status=Approved + Buyer Stage=READY|WAITING
   ├─ formIsQualified gate → call matching/suggest OR send YES button
   └─ Welcome email + admin alert
3. matching/suggest (if qualified)
   ├─ Auth (admin cookie / internal secret / admin password)
   ├─ Buyer state normalize
   ├─ Active-referral guard (dedupe)
   ├─ Rancher filter (state, capacity w/ hot-lead clamp, Admin Approved Multi-State, Tier Specialty)
   ├─ Sort: state-match > capacity > round-robin > Performance Score
   ├─ Atomic capacity re-read + bump
   ├─ Referral create + status=Intro Sent
   ├─ Rancher intro email (with quick-action JWT buttons)
   ├─ Buyer intro email
   └─ Telegram alert
4. Rancher receives email
   ├─ Reply-To tagged ref-<id>@replies.buyhalfcow.com
   └─ Quick-action buttons (30d JWT)
```

### Rancher activate / go-live flow

```
1. Trigger (one of 8 paths):
   ├─ POST /api/admin/ranchers/[id]/go-live
   ├─ POST /api/rancher/landing-page (capacity raise At Capacity → Active)
   ├─ POST /api/ranchers/capacity-check (auto reconcile)
   ├─ POST /api/rancher/activate
   ├─ Telegram callback rgolive_ / spgolive
   ├─ /resume <name> Telegram text command
   ├─ /api/cron/batch-approve auto-go-live block
   └─ Pass action At Capacity → Active flip
2. Update Page Live + Active Status
3. triggerLaunchWarmup() fires (PR #28)
4. /api/cron/rancher-launch-warmup runs
   ├─ getOperationalServedStates(rancher) — multi-state gate
   ├─ Trust Mode branch OR throttled branch
   ├─ Pull Waitlisted buyers in state
   ├─ Per-buyer Warmup Sent At dedupe
   └─ Send YES-button email
5. Cron Runs row written via withCronRun
```

### Warmup → engagement flow

```
1. Warmup email sent → Warmup Sent At stamped
2. Buyer clicks YES → /api/warmup/engage?token=<jwt>
   ├─ Verify JWT type=warmup-engage
   ├─ Stamp Warmup Engaged At + Ready to Buy=true
   └─ Fire /api/matching/suggest with warmupEngaged=true (hot-lead bypass)
3. matching/suggest → as above
```

### Close-sale flow

```
1. Rancher action:
   ├─ Dashboard /rancher PATCH /api/rancher/referrals/[id] with status=Closed Won + saleAmount
   └─ Email quick-action button POST /api/rancher/quick-action?token=<jwt> with action=won
2. Backend
   ├─ Session/JWT verify
   ├─ POSITIVE SALE AMOUNT REQUIRED (PR #30 gate)
   ├─ Update Referral Status + Sale Amount + Commission Due (via calcCommission)
   ├─ Decrement Current Active Referrals
   ├─ Update Consumer Buyer Stage='CLOSED'
   ├─ Stripe createCommissionInvoice → Stripe Invoice URL persisted
   │  └─ On failure: operatorSignal LOUD alert (PR #30)
   ├─ Branded fallback email
   ├─ Telegram sale celebration (lifetime/monthly stats)
   └─ Pilot upsell milestone check
```

### Inbound reply → activity stamp flow

```
1. Rancher or buyer replies to BHC outbound email
2. Resend Inbound webhook POSTs /api/webhooks/resend-inbound
   ├─ Svix signature verify (gated on RESEND_INBOUND_WEBHOOK_SECRET)
   ├─ Parse Reply-To tag → context (ref/usr/rnc/inq)
   ├─ AI classify (sender, objection, sentiment, action)
   ├─ Conversations table row
   ├─ Activity stamp on Referral (Last Rancher/Buyer Activity At + Rancher Engaged Flag)
   ├─ Auto-respond if ghost/scheduling category
   ├─ Telegram mirror with classification
   └─ Forward to admin Gmail (if ADMIN_EMAIL_FOR_FORWARD set)
```

## Procedure

### Step 1 — Identify the entity + symptom

User names a person/rancher/buyer/referral. Pull their record.

```javascript
const ran = await base('Ranchers').select({filterByFormula: `OR(SEARCH("<name>", LOWER({Operator Name})), SEARCH("<name>", LOWER({Ranch Name})))`}).all();
// OR
const cons = await base('Consumers').select({filterByFormula: `OR(LOWER({Email})="<email>", SEARCH("<name>", LOWER({Full Name})))`}).all();
```

Print all relevant fields. Identify which flow the user expected.

### Step 2 — Walk the flow boundaries

For each step in the flow, verify the artifact exists OR the cron run
log shows it processed:

- Did `/api/consumers` create a Consumer? → Airtable row present
- Did matching/suggest fire? → Look for Referral row with this buyer
- Did the intro email send? → Check Conversations OR Vercel logs for sendEmail success
- Did the rancher receive? → Conversations inbound row OR rancher Quick Action stamp
- Did warmup fire? → Consumer Warmup Sent At stamped
- Did YES click happen? → Consumer Warmup Engaged At stamped
- Did Stripe invoice fire? → Referral Stripe Invoice URL + ID populated

The boundary where the artifact STOPPED is the failure point.

### Step 3 — Check the gate that blocked it

Common silent gates:

| Layer | Gate | Symptom |
|---|---|---|
| /api/consumers | `Unsubscribed`/`Bounced` flag set | Welcome email skipped |
| matching/suggest | `excludeRancherIds` (Closed Lost/Won dedupe) | Same rancher excluded |
| matching/suggest | Tier Specialty mismatch | Rancher filtered out |
| matching/suggest | 5-Bar Beef policy (REMOVED PR #25) | Should not block anymore |
| matching/suggest | Cap @ 1.2× hard ceiling | Hot-lead waitlist |
| matching/suggest | `isRancherOperationalForBuyers` (Active Status, Agreement Signed, Onboarding) | Whole rancher excluded |
| matching/suggest | Routing States vs buyer state (Admin Approved Multi-State gate) | Cross-state buyers waitlist |
| batch-approve | `isQualifiedForRouting` (no Warmup Engaged At / Ready to Buy) | Skipped daily |
| referral-chasup | `recentlyActive(r, 5)` | No chase email |
| rancher-launch-warmup | Per-buyer Warmup Sent At dedupe | No 2nd warmup |
| lib/email | Suppression list (Unsubscribed/Bounced/Complained Consumers + Ranchers) | Email skipped silently |
| lib/email | Resend rate limit 429 | Retry via gate; if fails → drop |
| /api/auth/rancher/login | Email field whitespace OR not in Email/Team Emails | Telegram MISS alert + no link sent |
| Stripe | createCommissionInvoice exception | Branded fallback only; URL empty |

### Step 4 — Cross-reference Cron Runs + Vercel logs

If the failure was in a cron path, query Cron Runs table for that
cron's recent runs. Did it process this record? Was it skipped?

Vercel logs filtered by entity:
- `query: "<recordId>"` in get_runtime_logs
- `query: "<email>"` for inbound traces

### Step 5 — Report

```
## Flow debug: <subject>

### Expected flow
<which flow they're on>

### State snapshot
<key fields from their Airtable record>

### Artifacts found
- ✅ Consumer record exists
- ✅ Referral created (Intro Sent at <ts>)
- ❌ Rancher Activity At never stamped (rancher never engaged)
- ❌ Cron Runs row for referral-chasup shows record skipped: 'recentlyActive=false'

### Boundary where flow died
<one specific boundary + reason>

### Root cause
<the gate or bug that triggered>

### Proposed fix
<file:line + 1-line change OR data fix>
```

## Don't

- Fix from inside this skill. Report → user decides → separate PR.
- Speculate without pulling the record. Always start from Airtable evidence.
- Skip Cron Runs check — it's the single source of truth for "did cron see this record" since PR #26.
