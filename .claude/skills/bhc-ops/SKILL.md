---
name: bhc-ops
description: Operational console for BuyHalfCow — push ranchers through the pipeline, mark deals closed, pause/resume routing, search and pull data, draft personalized emails, advance specific records without touching code. Use this skill whenever the user wants to perform a business operation on the BHC platform — phrases like "push [rancher] to [stage]", "mark [referral] closed for $X", "pause [rancher]", "resume [rancher]", "show me ranchers in [state/stage]", "what's the status of [name]", "add a rancher manually", "draft a follow-up to [name]", "send the agreement to [rancher]", "fire warmup to [state]", "find [buyer/rancher]", "/bhc-ops", "advance [name]", "kick [rancher] to live", "close [referral]", or any request to query or mutate Airtable / trigger BHC API endpoints. This is the day-to-day ops surface — read state and write changes without ripping up code.
---

# BHC Ops Console

Day-to-day business operations skill. Mutate Airtable + trigger BHC API
endpoints by name. No code changes — this is the runtime tool for pushing
ranchers along, marking deals, pulling lists, drafting personal emails.

The BHC platform itself is the product. This skill is the levers behind
the curtain.

## Procedure

### Step 1 — Identify the operation

Read user request. Pick exactly one of:

| Operation | Examples |
|-----------|----------|
| **READ** — pull data | "show me ranchers in onboarding", "what's the status of Sackett", "list hot leads", "find Jane Doe" |
| **WRITE** — mutate single record | "push Sackett to verified", "mark referral closed $1200", "pause High Lonesome", "set Quarter Price to 1100 for Foodstead" |
| **TRIGGER** — fire endpoint | "fire warmup to MT", "send agreement to Foodstead", "retry stuck buyers", "promote Sackett to Trust Mode" |
| **COMPOSE** — generate copy | "draft a follow-up to Foodstead", "write a personal note to Title Founder Joe Smith". (For mass-marketing copy, defer to `bhc-marketing` skill.) |
| **CREATE** — add new record | "add a new rancher manually: Smith Family Ranch in Bozeman MT" |

If ambiguous, ask before acting. If destructive (Closed Lost on a ref, pause
a rancher, change verification status), confirm with the user before writing.

### Step 2 — Reference the schema

Single source of truth: `.claude/worktrees/throttle/docs/BUSINESS-MODEL.md`
(state machines) + `.claude/worktrees/throttle/docs/BHC.md` (audience + voice).

Quick state machine reference:

**Buyer Stage** (Consumers table):
```
NEW → WAITING → READY → MATCHED → CLOSED
```
- NEW: just signed up
- WAITING: approved, no rancher in state yet
- READY: rancher exists + buyer not yet engaged
- MATCHED: active referral, intro fired
- CLOSED: bought (or ghosted, terminal)

**Rancher pipeline** (Ranchers table):
```
Verification Status: Prospect → Verified
Onboarding Status:   (blank) → Call Scheduled → Call Complete → Docs Sent → Agreement Signed → Verification Pending → Verification Complete → Live
Active Status:       Active · Paused · Non-Compliant · At Capacity
Trust Mode:          false (throttled) · true (auto-routing)
```

**Referral Status** (Referrals table):
```
Pending Approval → Intro Sent → Rancher Contacted → Negotiation → Closed Won / Closed Lost
```

### Step 3 — Use the right tool

| Task | Tool |
|------|------|
| Search/list records | Airtable MCP `search_records` or `list_records_for_table` (filter by formula) |
| Get single record | Airtable MCP `get_record_for_page` |
| Update field | Airtable MCP `update_records_for_table` |
| Create record | Airtable MCP `create_records_for_table` |
| Find by name/email/state | `search_records` with formula like `LOWER({Email}) = "x@y.com"` or `FIND(LOWER("smith"), LOWER({Ranch Name})) > 0` |
| Trigger cron | `Bash` curl with CRON_SECRET: `curl -H "Authorization: Bearer $CRON_SECRET" https://www.buyhalfcow.com/api/cron/[name]` |
| Trigger admin action | `Bash` curl with ADMIN_PASSWORD if endpoint requires |

Required env vars to read from `.env.local`:
```
AIRTABLE_API_KEY · AIRTABLE_BASE_ID · CRON_SECRET · ADMIN_PASSWORD · JWT_SECRET
```

### Step 4 — Confirm before destructive writes

Always confirm before:
- Setting `Verification Status = Removed`
- Setting `Active Status = Paused` / `Non-Compliant`
- Marking referral `Closed Lost`
- Bulk updates (>1 record at once)
- Deleting any record (extremely rare — usually flag-and-archive instead)

Example confirmation pattern:
> "About to set Sackett Ranch's Active Status to 'Paused'. This stops new
> buyer routing immediately. Confirm?"

### Step 5 — After-action: verify + report

After every write, report:
- What changed (field-level diff)
- Side effects (e.g., "Active Status flip will pause warmup cron from picking them up tomorrow morning")
- Next-step recommendation (e.g., "Their dashboard now shows 'Paused' — they'll see it on next login")

After every read, report:
- Count of matches
- Top 5 records with key fields
- Total count if more

## Common Operations — Recipe Book

### Push a rancher through onboarding

User: "Push Foodstead to Agreement Signed"

```
1. Find rancher: search_records on Ranchers, filter `FIND(LOWER("foodstead"), LOWER({Ranch Name})) > 0`
2. Verify match (one record)
3. Update fields:
     Onboarding Status: "Agreement Signed"
     Agreement Signed: true
     Agreement Signed At: now ISO
4. Report: "Foodstead → Agreement Signed. Trust Mode auto-promotion cron picks them up at 14:00 UTC daily once Onboarding Phase Until lapses."
```

### Kick a rancher to Live

User: "Push High Lonesome to Live"

```
1. Find rancher
2. Confirm — going Live triggers buyer routing. Capacity should be set first.
3. Update fields:
     Onboarding Status: "Live"
     Active Status: "Active"
     Page Live: true
     Verification Status: "Verified"
     Onboarding Phase Until: now + 30 days ISO (kicks off throttle window)
4. Report: "Live. First-week throttle gate active for first 5 intros. Trust-promotion cron will auto-flip Trust Mode after 30 days OR 5 closes."
```

### Mark a referral Closed Won

User: "Mark Sarah K's referral with Sackett closed for $1,200"

```
1. Find referral: search on Referrals, filter on Buyer Email or Buyer Name + Suggested Rancher Name
2. Update:
     Status: "Closed Won"
     Sale Amount: 1200
     Commission Due: 120 (10%)
     Closed At: now ISO
3. Report: "Closed Won stamped. Instant invoice fires from rancher dashboard close handler — but if you marked it directly in Airtable, fire the invoice manually via /api/rancher/referrals/[id] POST. Also: rancher's lifetime Closed Won count just incremented. If they hit pilot goal (4), pilot-upsell email auto-fires."
```

### Pause a rancher

User: "Pause High Lonesome — they're at processing"

```
1. CONFIRM: "Pausing means no new buyer routing until you Resume. Confirm?"
2. Update Ranchers table:
     Active Status: "Paused"
3. Report: "High Lonesome paused. matching/suggest will skip them. Existing in-flight referrals continue. Resume when ready."
```

### Resume a rancher

```
Update Active Status: "Active"
```

### Search for a buyer

User: "Find John Smith from Texas"

```
search_records on Consumers with:
  AND(
    FIND(LOWER("john smith"), LOWER({Full Name})) > 0,
    {State} = "TX"
  )
```

Report: name, email, state, intent score, Buyer Stage, Ready to Buy, last contact.

### Pull list: ranchers in onboarding

User: "Show me all ranchers in onboarding"

```
list_records_for_table Ranchers, filter:
  AND(
    {Verification Status} != "Verified",
    {Onboarding Status} != "",
    {Onboarding Status} != "Live"
  )
```

Group by Onboarding Status. Report counts + names per group.

### Pull list: hot leads waiting

User: "Show me hot leads"

```
list_records_for_table Consumers, filter:
  AND(
    {Segment} = "Beef Buyer",
    {Intent Score} >= 80,
    OR({Buyer Stage} = "NEW", {Buyer Stage} = "READY"),
    NOT({Unsubscribed})
  )
```

### Pull list: deals at risk (stalled)

```
Referrals filter:
  AND(
    OR({Status} = "Intro Sent", {Status} = "Rancher Contacted", {Status} = "Negotiation"),
    DATETIME_DIFF(NOW(), {Last Updated}, 'days') >= 7
  )
```

### Trigger a cron manually

User: "Retry stuck buyers"

```
Bash:
  cd /Users/benji.bushes/BHC/untitled\ folder/bhc
  source <(grep '^CRON_SECRET=' .env.local)
  curl -H "Authorization: Bearer $CRON_SECRET" \
    https://www.buyhalfcow.com/api/cron/stuck-buyer-recovery
```

Available crons:
- `stuck-buyer-recovery` — retries READY buyers without active referrals
- `rancher-launch-warmup` — drips waitlisted buyers to newly-live ranchers
- `rancher-trust-promotion` — auto-promote ranchers to Trust Mode
- `rancher-onboarding-drip` — Day 2/5/14 nudges for self-submitted
- `email-sequences` — buyer-stage drip emails
- `commission-invoices` — monthly rollup invoices
- `referral-chasup` — chase stalled deals

### Send agreement to a rancher

User: "Send agreement to Smith Family Ranch"

```
1. Find rancher
2. Hit POST /api/ranchers/[id]/send-onboarding (admin-authed) OR
3. Generate signing JWT manually + send email
```

For the script-free path: ask user to hit the rancher dashboard and use
the existing send-agreement flow, OR fire the Telegram command `/setuppage`
for that rancher.

### Add a rancher manually

User: "Add new rancher: Bear Creek Ranch in Cody WY, Lisa Bear, lisa@bearcreek.com, 100% grass-fed"

```
create_records_for_table on Ranchers:
{
  "Ranch Name": "Bear Creek Ranch",
  "Operator Name": "Lisa Bear",
  "Email": "lisa@bearcreek.com",
  "State": "WY",
  "City": "Cody",
  "Beef Types": "100% grass-fed",
  "Verification Status": "Prospect",
  "Source Type": "manual-add",
  "Slug": "bear-creek-ranch-wy"
}
```

Then offer to:
- Geocode (use Nominatim manually or via the next /map cron tick)
- Mint a setup-token magic link they can use to fill out their page
- Send onboarding welcome email

### Compose a personal email

User: "Draft a personal follow-up to Joe at Foodstead about the upsell"

```
1. Find Foodstead rancher record + closed deals
2. Hand off to bhc-marketing skill OR draft inline using BHC.md voice rules
3. Output as email-ready HTML/markdown
4. Sign — Ben
```

For mass marketing copy, defer entirely to `bhc-marketing` skill. This
skill handles personalized one-offs.

### Bulk export

User: "Export all closed deals to CSV"

```
list_records_for_table Referrals, filter `{Status} = "Closed Won"`,
fields: [Buyer Name, Suggested Rancher Name, Sale Amount, Commission Due,
Closed At]
→ format as CSV, save to /tmp/closed-deals-YYYY-MM-DD.csv
```

## Anti-Patterns

1. **Don't auto-fire emails to large lists.** Anything > 5 recipients needs explicit user confirmation first.
2. **Don't silently fix.** If a record looks broken (missing required field), report it and ask before patching.
3. **Don't bypass the throttle.** First-week ranchers should still go through the approval gate. If user wants to skip, confirm + log it.
4. **Don't change Stripe state.** Refunds, subscription changes, etc. happen in Stripe dashboard. This skill reads + writes Airtable + triggers BHC API endpoints — that's it.
5. **Don't write commits or push code.** This is runtime ops, not deployment.
6. **Don't claim coverage we don't have.** If asked about a state with no rancher, say so plainly.

## Common Field Reference

**Ranchers — most-mutated fields:**
- `Verification Status` (singleSelect: Prospect / Verified / Removed)
- `Onboarding Status` (singleSelect: Call Scheduled / Call Complete / Docs Sent / Agreement Signed / Verification Pending / Verification Complete / Live)
- `Active Status` (singleSelect: Active / Paused / Non-Compliant / At Capacity)
- `Trust Mode` (checkbox)
- `Page Live` (checkbox)
- `Agreement Signed` (checkbox) + `Agreement Signed At` (date)
- `Onboarding Phase Until` (dateTime)
- `Pilot Closes Goal` (number)
- `Quarter/Half/Whole Price` (numbers)
- `Public Map Hidden` (checkbox)

**Consumers — most-mutated fields:**
- `Buyer Stage` (singleSelect: NEW / WAITING / READY / MATCHED / CLOSED)
- `Buyer Stage Updated At` (dateTime)
- `Status` (singleSelect: Approved / Rejected / Pending)
- `Ready to Buy` (checkbox)
- `Founder Tier` (singleSelect: Herd / Outlaw / Steward / Founding 100 / Title Founder)
- `Buyer Health` (singleSelect: Active / Non-Responsive)

**Referrals — most-mutated fields:**
- `Status` (singleSelect: Pending Approval / Intro Sent / Rancher Contacted / Negotiation / Closed Won / Closed Lost)
- `Sale Amount` (currency)
- `Commission Due` (currency)
- `Commission Paid` (checkbox)
- `Approval Status` (singleSelect: pending-approval / approved / held / skipped)
- `Closed At` (text)

## Quick Reference URLs

- Airtable base: `appgLT4z009iwAfhs`
- Ranchers table: `tbl08y9Be45zNG0OG`
- Consumers table: `tblAbjQDnLrOtjpoE`
- Referrals table: `tblBfimb4Gt8C0fu4`
- Affiliates table: `tblzbmKJr67IsTBa3`
- Conversations table: `tblFEPEJpvs5PLSob`
- Prod base URL: `https://www.buyhalfcow.com`
- Stripe dashboard: `https://dashboard.stripe.com`
- Vercel project: `bhc` (account: `benibeauchman-3168`)

## Why this skill exists

Ben needs to push the business along daily — mark wins, advance ranchers,
chase stalled deals, draft personal notes, pull arbitrary lists. Without
this skill, every operation requires either Airtable UI clicks (slow),
custom code (rip up the codebase), or Telegram commands (fixed surface).

This skill turns natural language into Airtable mutations + endpoint
triggers, with safety rails on destructive operations. The BHC platform
runs autonomously most of the time; this is the lever for when it
shouldn't.

Don't write code. Don't deploy. Don't ship. Mutate state, generate
copy, trigger endpoints. That's the surface area.

— Ben
