---
name: bhc-cron-debug
description: Investigate a specific BHC cron's behavior. Pulls Cron Runs Airtable table (per-execution log), Vercel runtime logs, schedule from vercel.json, and the cron's source. Identifies failure mode (silent skip, error, never-fires, wrong-data). Use when "why didn't X cron fire", "is the Y cron working", "X cron returns 0 every day", "audit Z cron", or any cron-specific question. Read-only.
---

# BHC Cron Debug

Diagnose a single cron's behavior. Output: per-execution history,
recent run status, common failure patterns, and (if asked) a fix plan.

## When to invoke

- "Why didn't `<name>` cron fire?"
- "`<name>` returns 0 every day"
- "Did `<name>` run today?"
- "Audit the `<name>` cron"
- "/bhc-cron-debug `<name>`"

## Procedure

### Step 1 — Identify the cron

Cron names live in `vercel.json` + `app/api/cron/<name>/route.ts`. Full
list:

- compliance-reminders · send-scheduled · daily-digest · batch-approve
- rancher-followup · email-sequences · referral-chasup · commission-invoices
- healthcheck · rancher-launch-warmup · nightly-rancher-audit
- rancher-onboarding-drip · rancher-trust-promotion · stuck-buyer-recovery
- onboarding-stuck · close-detector · daily-audit · buyer-pulse

If user names a cron not in the list, ask to clarify before proceeding.

### Step 2 — Pull execution history (Cron Runs table)

Every cron migrated to `withCronRun` writes to Airtable `Cron Runs`
table on every execution. Pull rows filtered by Name:

```javascript
const runs = await base('Cron Runs').select({
  filterByFormula: `{Name}="<cron-name>"`,
  maxRecords: 50,
  sort: [{field: 'Started At', direction: 'desc'}]
}).all();
```

Report:
- Total runs in last 7 days
- Most recent run: timestamp, status, duration ms, records touched, notes
- Any `error` status in last 24h → expand the notes
- Any `partial` status in last 24h → expand the notes
- Long-running outliers (duration > 30s)
- Gaps in cadence (cron expected daily but missing 2+ days)

If table has NO rows for this cron:
- Either the cron hasn't fired since `withCronRun` deployed (PR #26 merged ~2026-05-18 21:00 UTC — anything pre-21:00 UTC that day won't be logged)
- OR the route returns 401 (auth misconfig — check CRON_SECRET)
- OR Vercel cron schedule was deleted from vercel.json

### Step 3 — Pull Vercel runtime logs

```
mcp__b2a1a8ed-5009-469d-a793-c345a239ed4b__get_runtime_logs
- projectId: prj_UiTlxTHcMl277z0QyrAVz82nclVA
- teamId: team_LtooF0XS8M8oDBUwxphrC1RJ
- environment: production
- query: "/api/cron/<name>"
- since: 7d
- limit: 50
```

Filter on `level=error` AND `statusCode=500` separately. Surface real
errors (filter out `[DEP0169]` deprecation noise).

### Step 4 — Read schedule + source

Schedule from `vercel.json`. Confirm cron expression matches expectation.

Source from `app/api/cron/<name>/route.ts`. Look for:
- Maintenance short-circuit (returns `'maintenance-blocked'` early)
- Auth gate (CRON_SECRET — wrong header = 401, returns BEFORE wrapper)
- Filter formulas using Airtable field names (TYPO check)
- Throttle logic (per-record cooldown via `Last X At` fields)
- One-shot flags (e.g. `Launch Warmup Triggered`)
- Skip-counter math (e.g. batch-approve waitlist retry at line 351 had a known double-count bug)

### Step 5 — Diagnose

Common failure patterns by symptom:

| Symptom | Likely cause |
|---|---|
| Cron Runs table empty, returns 200 in logs | Auth path returns before wrapper. Check `Authorization: Bearer ${CRON_SECRET}` header in Vercel cron config. |
| Same data every day no change | Throttle flag never cleared (e.g. `Launch Warmup Triggered`). Or qualification gate excludes all candidates (waitlist retry). |
| `records touched=0` daily | All candidates filter out via formula. Check filterByFormula against actual field values. |
| `status=error` daily | Real exception. Read notes. Common: Resend rate limit, Airtable 422 (invalid singleSelect option), Telegram 401. |
| `status=partial` | Some records succeeded, some failed. Look in notes. Usually network blip or single-record schema issue. |
| Cron schedule says daily but only fires every 2-3 days | Schedule conflict (two crons same minute UTC) or Vercel cron tier limit. Check vercel.json + Vercel dashboard. |

### Step 6 — Trigger manually if needed

```bash
SEC=$(grep -E "^CRON_SECRET=" .env.local | cut -d= -f2- | tr -d '"')
curl -s -H "Authorization: Bearer $SEC" "https://www.buyhalfcow.com/api/cron/<name>"
```

The response now includes `{ok, status, recordsTouched, notes}` so you
can verify the wrapper IS recording before tomorrow's scheduled fire.

### Step 7 — Report

Output template:

```
## <cron-name> debug report

### Schedule
- vercel.json: `<expression>` (`<human time>` daily)
- Last 7 days: X runs (expected ~Y)

### Last run
- When: <ts>
- Status: <success/partial/error/maintenance-blocked>
- Touched: <N>
- Notes: <truncated 200 chars>

### Recent errors / partials (24h)
<list with timestamps + notes>

### Suspected failure
<one of the patterns above OR custom diagnosis>

### Proposed fix (if applicable)
<file:line + 1-line change>

### Trigger result (if manual fire ran)
<status/touched/notes>
```

## Known cron quirks

- **batch-approve**: returns `{ok, status, recordsTouched, notes}` post-PR #26. Old admin button at `app/admin/page.tsx:632` reads `data.approved` → shows undefined (cosmetic only; toast still fires).
- **referral-chasup `?dryRun=1`**: planned arrays are now console-logged as `[chasup:dryRun]` JSON instead of HTTP body. Read Vercel logs.
- **healthcheck**: returns `partial`/`error` for degraded but wrapper returns HTTP 200 (Vercel doesn't mark cron failed for degraded states).
- **rancher-launch-warmup**: Trust Mode flag-gate REMOVED PR #27. Per-buyer `Warmup Sent At` is the only dedupe now.
- **buyer-pulse / close-detector / daily-audit**: scheduled PR #26. Pre-PR #26 these were unscheduled — Cron Runs may show only post-PR runs.

## Don't

- Edit cron code from inside this skill. Audit → propose → user picks → separate PR via `superpowers:writing-plans`.
- Disable a cron in `vercel.json` without first confirming whether other code calls it via fetch.
- Manually patch `Cron Runs` rows. They're append-only audit log.
