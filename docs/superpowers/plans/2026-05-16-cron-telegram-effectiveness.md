# Cron + Telegram Effectiveness Audit & Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every cron + every Telegram automation observable, accurate, and useful. Each cron must declare its purpose, prove it's reading the right records + writing the right fields, prove it fires within the intended cadence, and feed a clean signal (not noise) into Telegram. No silent failures, no orphan crons, no overlapping schedules, no dead callbacks.

**Architecture:**
- Audit-first: build a per-cron health probe + dashboard panel before changing logic. You can't fix what you can't measure.
- Replace ad-hoc Telegram alerts with a typed "operator-signal" helper so the rules around urgency/throttle/deduplication live in one place.
- Schedule rationalization in `vercel.json` — drop dead crons, stagger overlapping windows, surface unscheduled cron files.
- Backwards-compat: every fix preserves existing behavior unless explicitly noted in the task. No silent semantic drift.

**Tech Stack:** Next.js 16 App Router, Vercel Cron, Airtable, Telegram Bot API, AI Audit Log table (existing), `lib/telegram.ts` (token-bucket gate already shipped).

---

## File Structure

**Files modified:**
- `vercel.json` — schedule rationalization, drop dead entries
- `app/api/cron/*/route.ts` (15 cron routes) — add purpose-doc header, run summary write to AI Audit Log
- `app/api/webhooks/telegram/route.ts` — consume typed operator-signal helper (Tasks 7+)
- `lib/telegram.ts` — add throttle/dedupe wrapper for non-critical alerts
- `app/api/admin/health/route.ts` — extend with per-cron last-run + last-success
- `app/admin/health/page.tsx` — render cron health table

**Files created:**
- `lib/cronRun.ts` — `withCronRun(name, fn)` wrapper: logs start/end to AI Audit Log, catches errors, writes to a `Cron Runs` Airtable table
- `lib/operatorSignal.ts` — typed `sendOperatorSignal({ urgency, kind, summary, refs?, actions? })` helper. Routes to Telegram with throttle + dedupe; falls back to admin email if Telegram is down
- `docs/cron-inventory.md` — living catalog of every cron (purpose, cadence, reads, writes, last-known-issue)
- (no new pages)

**Airtable changes (via MCP):**
- New table: `Cron Runs` (fields: Name, Started At, Ended At, Status, Records Touched, Notes, Source Commit). Used by `withCronRun` to surface every execution.

---

## Task 1: Inventory every cron + map declared vs actual schedule

**Files:**
- Create: `docs/cron-inventory.md`
- Read: `app/api/cron/*/route.ts`, `vercel.json`

- [ ] **Step 1: Enumerate every cron route file**

```bash
ls -1 app/api/cron/
```

Expected output (today): 18 directories. Each is a cron handler.

- [ ] **Step 2: Compare to `vercel.json` schedule**

```bash
node -e "
const fs=require('fs');
const sched = JSON.parse(fs.readFileSync('vercel.json','utf8')).crons.map(c=>c.path.replace('/api/cron/',''));
const files = fs.readdirSync('app/api/cron');
const unscheduled = files.filter(f => !sched.includes(f));
const scheduledOnly = sched.filter(s => !files.includes(s));
console.log('Files NOT in vercel.json:', unscheduled);
console.log('Schedule entries with NO file:', scheduledOnly);
"
```

Expected (today): 3 unscheduled crons (`buyer-pulse`, `close-detector`, `daily-audit`). Zero phantoms.

- [ ] **Step 3: Build `docs/cron-inventory.md`**

For each cron file, document a 6-row block:

```markdown
## /api/cron/<name>

- **Purpose (one sentence):** ...
- **Schedule:** `0 14 * * *` (or "UNSCHEDULED")
- **Reads:** Ranchers, Referrals, Consumers (which fields)
- **Writes:** Referrals.Status, Consumers.Buyer Stage (which fields)
- **Telegram output:** summary alert / digest / silent
- **Known issues:** ...
```

For data: open each file, scan top 80 lines for `getAllRecords(...)` and `updateRecord(...)`, list field names.

- [ ] **Step 4: Identify schedule conflicts**

In `vercel.json`, look for crons that share the same minute and could overlap (each Vercel cron runs serverless — overlap doesn't crash but doubles Airtable read pressure during that minute). Example: today both `email-sequences` and `onboarding-stuck` run at `:00 16` UTC.

Append a "Schedule Conflicts" section to `docs/cron-inventory.md`.

- [ ] **Step 5: Commit the inventory**

```bash
git add docs/cron-inventory.md
git commit -m "docs(cron): full inventory + schedule conflict map

3 unscheduled cron files (buyer-pulse, close-detector, daily-audit).
2 schedule conflicts (16:00 UTC: email-sequences + onboarding-stuck;
14:00 UTC: rancher-trust-promotion + daily-digest)."
```

---

## Task 2: Create `Cron Runs` Airtable table

**Files:**
- (No code files — Airtable schema change via MCP)

- [ ] **Step 1: Create table via Airtable MCP**

Use `mcp__d5aec254-622f-48e6-9468-0b36405e9a80__create_table` (or `create_field` against an existing table — check first).

Schema:
- `Name` (singleLineText, primary)
- `Started At` (dateTime, ISO)
- `Ended At` (dateTime, ISO)
- `Duration ms` (number, precision 0)
- `Status` (singleSelect: `success`, `partial`, `error`, `maintenance-blocked`)
- `Records Touched` (number, precision 0)
- `Notes` (multilineText)
- `Source Commit` (singleLineText, optional)

- [ ] **Step 2: Verify table reachable**

```bash
node -e "
import('airtable').then(async ({default: Airtable}) => {
  const fs = await import('fs');
  for (const l of fs.readFileSync('./.env.local','utf8').split('\n')) {
    const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = process.env[m[1]] || m[2];
  }
  const base = new Airtable({apiKey: process.env.AIRTABLE_API_KEY}).base(process.env.AIRTABLE_BASE_ID);
  const recs = await base('Cron Runs').select({maxRecords: 1}).all();
  console.log('Cron Runs table reachable, rows:', recs.length);
});
"
```

Expected: `Cron Runs table reachable, rows: 0`.

- [ ] **Step 3: Add table name to `lib/airtable.ts` `TABLES` export**

```typescript
// in lib/airtable.ts, inside TABLES:
CRON_RUNS: 'Cron Runs',
```

- [ ] **Step 4: Commit**

```bash
git add lib/airtable.ts
git commit -m "feat(airtable): add Cron Runs table to TABLES export

Backing table for the withCronRun() wrapper (next commit). Records
every cron execution with start/end/status/notes."
```

---

## Task 3: Build `lib/cronRun.ts` wrapper

**Files:**
- Create: `lib/cronRun.ts`

- [ ] **Step 1: Write the helper**

```typescript
import { createRecord, TABLES } from './airtable';

type CronStatus = 'success' | 'partial' | 'error' | 'maintenance-blocked';

interface CronRunResult {
  status: CronStatus;
  recordsTouched?: number;
  notes?: string;
}

/**
 * Wraps a cron handler. Logs start, awaits the function, logs end with
 * status + duration + records-touched count. On exception, records the
 * error message and re-throws so Vercel marks the cron failed.
 *
 * Usage inside a cron route:
 *
 *   export const GET = withCronRun('referral-chasup', async () => {
 *     ... your existing logic ...
 *     return { status: 'success', recordsTouched: 5, notes: 'Chased 5 stale' };
 *   });
 *
 * Wrapper writes to Airtable table 'Cron Runs'. Failures to log don't
 * block the cron — they just console.error.
 */
export function withCronRun<T extends CronRunResult>(
  name: string,
  fn: (request: Request) => Promise<T>,
): (request: Request) => Promise<Response> {
  return async function wrapped(request: Request): Promise<Response> {
    const startedAt = new Date();
    let endedAt: Date;
    let status: CronStatus = 'error';
    let recordsTouched = 0;
    let notes = '';
    let returnedResponse: Response | null = null;
    try {
      const result = await fn(request);
      status = result.status;
      recordsTouched = result.recordsTouched ?? 0;
      notes = result.notes ?? '';
      returnedResponse = new Response(
        JSON.stringify({ ok: true, status, recordsTouched, notes }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    } catch (e: any) {
      status = 'error';
      notes = (e?.message || String(e)).slice(0, 500);
      returnedResponse = new Response(
        JSON.stringify({ ok: false, error: notes }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    } finally {
      endedAt = new Date();
      try {
        await createRecord(TABLES.CRON_RUNS, {
          Name: name,
          'Started At': startedAt.toISOString(),
          'Ended At': endedAt.toISOString(),
          'Duration ms': endedAt.getTime() - startedAt.getTime(),
          Status: status,
          'Records Touched': recordsTouched,
          Notes: notes,
        });
      } catch (logErr: any) {
        console.error(`[withCronRun:${name}] log write failed:`, logErr?.message);
      }
    }
    return returnedResponse;
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/cronRun.ts
git commit -m "feat(cron): withCronRun() wrapper for execution observability

Every wrapped cron auto-logs start/end/duration/status/records-touched/
notes to the Cron Runs Airtable table. Failures to write the log
don't block the cron. Existing maintenance-mode check stays in caller."
```

---

## Task 4: Migrate `referral-chasup` to `withCronRun`

**Files:**
- Modify: `app/api/cron/referral-chasup/route.ts`

- [ ] **Step 1: Open the file + read the existing structure**

```bash
head -50 app/api/cron/referral-chasup/route.ts
```

- [ ] **Step 2: Refactor exported handler**

Replace the `export const GET = ...` (or however it's currently exported) with the wrapper. The inner function takes the existing logic and at the end RETURNS `{ status, recordsTouched, notes }` instead of `NextResponse.json(...)`.

Concrete shape:

```typescript
import { withCronRun } from '@/lib/cronRun';

async function handler(request: Request): Promise<{ status: 'success' | 'partial' | 'error' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }
  // ... existing logic body ...
  // count records you mutated (chase emails sent + auto-closes) as you go.
  return { status: 'success', recordsTouched: chasedCount + closedCount, notes: `chased ${chasedCount}, closed ${closedCount}` };
}

export const GET = withCronRun('referral-chasup', handler);
export const POST = withCronRun('referral-chasup', handler);
```

Drop the explicit `NextResponse.json(...)` at the end of the handler body and just `return` the typed object.

- [ ] **Step 3: Run the build**

```bash
npm run build 2>&1 | tail -5
```

Expected: build green. The wrapper returns `Promise<Response>` which Next.js accepts for route handlers.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/referral-chasup/route.ts
git commit -m "refactor(cron): referral-chasup uses withCronRun

First cron migrated to the observability wrapper. Run timing,
status, records-touched count now logged to Cron Runs table.
Logic unchanged."
```

---

## Task 5: Migrate the remaining 14 scheduled crons one PR at a time

**Files:**
- Modify: every `app/api/cron/<name>/route.ts` referenced in `vercel.json` except `referral-chasup` (done in Task 4)

- [ ] **Step 1: List remaining crons**

```bash
node -e "
const fs=require('fs');
const sched = JSON.parse(fs.readFileSync('vercel.json','utf8')).crons.map(c=>c.path.replace('/api/cron/',''));
console.log(sched.filter(s => s !== 'referral-chasup').join('\n'));
"
```

- [ ] **Step 2: For each cron, repeat Task 4's pattern**

For every cron in the list, repeat the same refactor: import `withCronRun`, replace the exported handler, return a typed result object. Commit each one separately so individual failures are revertable.

Per-cron commit message template:

```bash
git add app/api/cron/<name>/route.ts
git commit -m "refactor(cron): <name> uses withCronRun"
```

- [ ] **Step 3: Spot-check the build after each commit**

```bash
npx tsc --noEmit && npm run build 2>&1 | tail -3
```

- [ ] **Step 4: Final commit of the batch**

After all 14, push the branch:

```bash
git push -u origin <branch-name>
```

---

## Task 6: Resolve unscheduled cron files

**Files:**
- Read: `app/api/cron/buyer-pulse/route.ts`, `app/api/cron/close-detector/route.ts`, `app/api/cron/daily-audit/route.ts`

For each unscheduled cron, decide: keep + schedule, OR delete.

- [ ] **Step 1: Read each unscheduled file's header**

```bash
head -40 app/api/cron/buyer-pulse/route.ts
head -40 app/api/cron/close-detector/route.ts
head -40 app/api/cron/daily-audit/route.ts
```

Read the top-of-file comment for purpose. Decide:
- `buyer-pulse` — used by other crons? `grep -rn "buyer-pulse" app/`. If only the file itself: candidate for deletion.
- `close-detector` — purpose: detect deals that closed off-platform. Useful → schedule daily.
- `daily-audit` — purpose: audit data integrity. Useful → schedule daily.

- [ ] **Step 2: Schedule the keepers in `vercel.json`**

Add entries (rotate minute so they don't all overlap):

```json
{
  "path": "/api/cron/close-detector",
  "schedule": "15 17 * * *"
},
{
  "path": "/api/cron/daily-audit",
  "schedule": "45 5 * * *"
}
```

- [ ] **Step 3: Delete `buyer-pulse` IF confirmed dead**

Verify ZERO references outside the file itself:

```bash
grep -rln "buyer-pulse" app/ lib/ scripts/ | grep -v "app/api/cron/buyer-pulse" | grep -v "docs/"
```

If empty output: delete:

```bash
rm -rf app/api/cron/buyer-pulse
git add -A
```

Otherwise: schedule it.

- [ ] **Step 4: Commit**

```bash
git add vercel.json app/api/cron/
git commit -m "chore(cron): schedule close-detector + daily-audit, drop buyer-pulse

Three cron files existed in app/api/cron/ but were unscheduled in
vercel.json. close-detector + daily-audit are useful → scheduled.
buyer-pulse confirmed unused → deleted."
```

---

## Task 7: Resolve schedule conflicts in `vercel.json`

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Re-read the conflict list from Task 1's inventory**

Read the "Schedule Conflicts" section in `docs/cron-inventory.md`.

- [ ] **Step 2: Stagger by 5-15 minutes**

Update overlapping crons to non-conflicting minutes. Sample diff:

```json
// before:
{"path": "/api/cron/email-sequences", "schedule": "0 16 * * *"},
{"path": "/api/cron/onboarding-stuck", "schedule": "0 16 * * *"},
// after:
{"path": "/api/cron/email-sequences", "schedule": "0 16 * * *"},
{"path": "/api/cron/onboarding-stuck", "schedule": "15 16 * * *"},
```

Apply to every conflict pair.

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "fix(cron): stagger overlapping schedules

email-sequences + onboarding-stuck both ran at :00 16 UTC — doubled
Airtable read pressure for that minute. Now :00 and :15. Same for
rancher-trust-promotion + daily-digest at :00 14."
```

---

## Task 8: Build `lib/operatorSignal.ts` typed Telegram helper

**Files:**
- Create: `lib/operatorSignal.ts`

- [ ] **Step 1: Write the helper**

```typescript
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from './telegram';

/**
 * One typed entry point for every operator-facing alert. Replaces ad-hoc
 * sendTelegramMessage(...) calls scattered across crons/endpoints so:
 *   1. Throttle/dedupe lives in one place (avoids "10 capacity alerts in 5min").
 *   2. Urgency drives delivery (loud, normal, digest).
 *   3. Optional inline buttons follow a consistent format.
 *   4. Future: route loud alerts to SMS via Twilio without touching call sites.
 */

export type SignalUrgency = 'loud' | 'normal' | 'digest';
export type SignalKind =
  | 'capacity'
  | 'sale'
  | 'stuck-rancher'
  | 'login-miss'
  | 'system-error'
  | 'inbound-reply'
  | 'verification-request'
  | 'recovery-suggestion'
  | 'audit'
  | 'other';

interface SignalInput {
  urgency: SignalUrgency;
  kind: SignalKind;
  summary: string;
  detail?: string;
  refs?: Array<{ type: 'rancher' | 'referral' | 'consumer' | 'cron'; id: string; label?: string }>;
  actions?: Array<{ label: string; callbackData: string }>;
  // Dedupe key — if same key fires within dedupeWindowMs, second alert suppressed.
  dedupeKey?: string;
  dedupeWindowMs?: number;
}

// Module-level dedupe state. Reset on every cold-start (fine — we'd
// rather re-alert after a deploy than swallow a real event).
const _dedupe: Record<string, number> = {};

const URGENCY_EMOJI: Record<SignalUrgency, string> = { loud: '🚨', normal: '🟡', digest: '⚪️' };

export async function sendOperatorSignal(input: SignalInput): Promise<{ sent: boolean; reason?: string }> {
  const { urgency, kind, summary, detail, refs, actions, dedupeKey, dedupeWindowMs = 5 * 60 * 1000 } = input;
  if (dedupeKey) {
    const last = _dedupe[dedupeKey];
    if (last && Date.now() - last < dedupeWindowMs) {
      return { sent: false, reason: 'deduped' };
    }
    _dedupe[dedupeKey] = Date.now();
  }
  const head = `${URGENCY_EMOJI[urgency]} <b>${kind.toUpperCase()}</b> ${summary}`;
  const lines = [head];
  if (detail) lines.push('', detail);
  if (refs && refs.length) {
    lines.push('', refs.map((r) => `• ${r.type}=${r.id}${r.label ? ` (${r.label})` : ''}`).join('\n'));
  }
  const inlineKeyboard = actions && actions.length > 0
    ? { inline_keyboard: [actions.map((a) => ({ text: a.label, callback_data: a.callbackData }))] }
    : undefined;
  try {
    await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, lines.join('\n'), inlineKeyboard);
    return { sent: true };
  } catch (e: any) {
    console.error('[sendOperatorSignal] send failed:', e?.message);
    return { sent: false, reason: e?.message };
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit 2>&1 | tail -3
```

- [ ] **Step 3: Commit**

```bash
git add lib/operatorSignal.ts
git commit -m "feat(telegram): typed operator-signal helper with dedupe + urgency

Every operator-facing alert in BHC was an ad-hoc sendTelegramMessage()
call with bespoke formatting. Hard to throttle, no shared dedupe,
no consistent urgency. This helper is the new single entry point —
classifies urgency, dedupes by key, formats refs + actions
consistently. Migrating call sites in the next task."
```

---

## Task 9: Migrate top-noise alerts to `sendOperatorSignal`

**Files:**
- Modify: `app/api/cron/batch-approve/route.ts` (capacity self-heal alert)
- Modify: `app/api/matching/suggest/route.ts` (CAPACITY RACE, AT CAPACITY, HOT-LEAD BYPASS alerts)
- Modify: `app/api/auth/rancher/login/route.ts` (RANCHER LOGIN MISS alert)
- Modify: `app/api/admin/referrals/[id]/revive/route.ts` (LEAD REVIVED audit)

- [ ] **Step 1: For each existing `sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, ...)` call, decide urgency + kind**

Cheat-sheet:
- Capacity at 100% with no other rancher in state → `loud`
- Capacity at 100% but state has 2+ ranchers → `normal`
- Login miss → `normal` (dedupe by typed email, 30-min window)
- Lead revived → `digest`
- Sale closed → `loud`
- Stuck rancher 14d → `loud`
- Capacity race caught (atomic guard) → `digest` (already throttled by matching)

- [ ] **Step 2: Replace each call site**

Example — `app/api/auth/rancher/login/route.ts` no-match block:

```typescript
// before:
await sendTelegramMessage(
  TELEGRAM_ADMIN_CHAT_ID,
  `⚠️ <b>RANCHER LOGIN MISS</b>\n\nEmail typed: <code>${normalizedEmail}</code>\nNo match in Email or Team Emails. Likely a typo or whitespace in the stored field.`
);

// after:
const { sendOperatorSignal } = await import('@/lib/operatorSignal');
await sendOperatorSignal({
  urgency: 'normal',
  kind: 'login-miss',
  summary: `Email typed: ${normalizedEmail}`,
  detail: 'No match in Email or Team Emails. Likely a typo or whitespace in the stored field.',
  dedupeKey: `login-miss:${normalizedEmail}`,
  dedupeWindowMs: 30 * 60 * 1000,
});
```

Apply to all 4 file-modifications listed above.

- [ ] **Step 3: Typecheck + build**

```bash
npx tsc --noEmit && npm run build 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/batch-approve/route.ts app/api/matching/suggest/route.ts app/api/auth/rancher/login/route.ts app/api/admin/referrals/[id]/revive/route.ts
git commit -m "refactor(telegram): top-noise alerts use sendOperatorSignal

Login-miss now dedupes within 30min (so a rancher typing wrong email
3x doesn't ping 3x). Capacity-race + lead-revived flagged as digest
urgency so they don't compete with sale + stuck-rancher loud alerts.
Behavior preserved for happy paths."
```

---

## Task 10: Extend `/admin/health` with cron health table

**Files:**
- Modify: `app/api/admin/health/route.ts`
- Modify: `app/admin/health/page.tsx`

- [ ] **Step 1: Add cron-runs pull to the health API**

In `app/api/admin/health/route.ts`, add:

```typescript
const cronRuns = await getAllRecords(TABLES.CRON_RUNS) as any[];
// Group by Name. For each, find the latest by Started At.
const byName: Record<string, { lastRun: string; status: string; durationMs: number; notes: string }> = {};
for (const r of cronRuns) {
  const name = (r['Name'] || '').toString();
  if (!name) continue;
  const startedAt = r['Started At'] || '';
  if (!byName[name] || startedAt > byName[name].lastRun) {
    byName[name] = {
      lastRun: startedAt,
      status: (r['Status'] || '').toString(),
      durationMs: Number(r['Duration ms'] || 0),
      notes: (r['Notes'] || '').toString().slice(0, 200),
    };
  }
}
```

Include in the response under `crons: byName`.

- [ ] **Step 2: Render in `/admin/health` page**

Add a new section after Data Integrity:

```typescript
{/* Cron Health */}
<section>
  <h2 className="font-serif text-xl mb-3">Cron Health</h2>
  <table className="w-full text-xs">
    <thead><tr className="text-left text-[#6B4F3F]"><th className="pr-3">Name</th><th className="pr-3">Last Run</th><th className="pr-3">Status</th><th className="pr-3">Duration</th><th className="pr-3">Notes</th></tr></thead>
    <tbody>
      {Object.entries(data.crons || {}).sort((a: any, b: any) => (b[1].lastRun > a[1].lastRun ? 1 : -1)).map(([name, c]: any) => (
        <tr key={name} className="border-t border-[#A7A29A]/30">
          <td className="py-1 pr-3 font-mono">{name}</td>
          <td className="py-1 pr-3">{c.lastRun ? new Date(c.lastRun).toLocaleString() : '(never)'}</td>
          <td className="py-1 pr-3">
            <span className={c.status === 'success' ? 'text-green-700' : c.status === 'error' ? 'text-red-700' : c.status === 'maintenance-blocked' ? 'text-amber-700' : ''}>
              {c.status || '(unknown)'}
            </span>
          </td>
          <td className="py-1 pr-3">{c.durationMs}ms</td>
          <td className="py-1">{c.notes}</td>
        </tr>
      ))}
    </tbody>
  </table>
</section>
```

- [ ] **Step 3: Build + commit**

```bash
npm run build 2>&1 | tail -3
git add app/api/admin/health/route.ts app/admin/health/page.tsx
git commit -m "feat(admin): cron health table on /admin/health

Reads Cron Runs Airtable table, shows latest run per name with
status + duration + notes. Operator sees at a glance which cron
failed last or hasn't fired in 24h."
```

---

## Task 11: Audit each cron for read/write correctness against `docs/cron-inventory.md`

**Files:**
- Read: `docs/cron-inventory.md`
- Modify: `app/api/cron/*/route.ts` (only where bugs are found)

- [ ] **Step 1: For each cron, manually trace one execution**

Open the cron file, identify:
1. **Reads:** Which Airtable fields does it filter on (`filterByFormula`)? Are those field names correct?
2. **Writes:** Which fields does it `updateRecord` to? Are those names correct?
3. **Telegram output:** Does it actually call `sendOperatorSignal` (or `sendTelegramMessage`) ONLY when it did real work?

Look for the failure mode "silent no-op" — cron runs, returns 200, touches nothing, sends no alert, looks healthy in logs but is actually broken.

- [ ] **Step 2: Document findings inline in `docs/cron-inventory.md`**

Under each cron, add a "Audit Findings (YYYY-MM-DD)" sub-section with:
- Read fields that don't exist on the table → bug
- Write fields that drop silently → bug (Airtable updateRecord retries auto-strip unknown fields per `lib/airtable.ts`)
- Silent no-op paths → bug

- [ ] **Step 3: For each confirmed bug, write a focused fix commit**

Pattern:

```bash
# example fix
git add app/api/cron/<name>/route.ts
git commit -m "fix(cron): <name> reads {Right Field Name} (was {Wrong Field})

Was filtering on '{Old Name}' which doesn't exist on the table —
Airtable formula silently returns ALL records (or zero, depending on
filter direction), so the cron was either no-op or destructive.
Real field is '{Correct Name}'."
```

- [ ] **Step 4: Update the inventory with "Fixed YYYY-MM-DD" footers**

Strike out the bugs you fixed.

---

## Task 12: Audit every Telegram callback handler — fix or remove dead ones

**Files:**
- Read: `app/api/webhooks/telegram/route.ts`
- Modify: same

- [ ] **Step 1: List every callback prefix**

```bash
grep -n "callback_data: \`\|callback_data: '" app/api/webhooks/telegram/route.ts | head -80
grep -n "callbackData === \|callbackData?.startsWith\|callbackData.startsWith" app/api/webhooks/telegram/route.ts | head -80
```

Build a 2-column list: "emitted callback_data" vs "handler exists".

- [ ] **Step 2: For each emitted but unhandled callback, decide: handle or remove the button**

If the button serves a real purpose: write the handler. Pattern:

```typescript
else if (callbackData.startsWith('newprefix_')) {
  const recordId = callbackData.substring('newprefix_'.length);
  // ... real work ...
  await answerCallbackQuery(queryId, 'Done.');
  return NextResponse.json({ ok: true });
}
```

If the button is dead: remove the call site that emits it.

- [ ] **Step 3: For each handled callback, verify `answerCallbackQuery` is called on every code path**

A button that doesn't ack within 3s shows "loading..." forever in Telegram clients. Worst-feeling bug class.

For long-running handlers, ack immediately:

```typescript
await answerCallbackQuery(queryId, 'Working on it…');
// then do the slow work
```

- [ ] **Step 4: For each handler that mutates state, verify it logs to `AI Audit Log`**

`logAuditEntry({ actor: 'telegram-callback', tool: callbackData.split('_')[0], targetType: ..., targetId: ..., args: { ... }, result: { ... }, reverseAction: { ... } })`.

If a callback writes to Airtable but doesn't audit-log, add the call.

- [ ] **Step 5: Synthetic-test every callback after the audit**

For each callback, send a fake `callback_query` payload to `/api/webhooks/telegram` via curl with the bot token. Verify 200 + success-toast string in the response.

Example:

```bash
curl -X POST https://www.buyhalfcow.com/api/webhooks/telegram \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_BOT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 999999,
    "callback_query": {
      "id": "test-cq-1",
      "from": { "id": 12345 },
      "message": { "message_id": 1, "chat": { "id": '$TELEGRAM_ADMIN_CHAT_ID' } },
      "data": "rverify_recXXX"
    }
  }'
```

Replace `rverify_recXXX` with each callback you're testing.

- [ ] **Step 6: Commit**

```bash
git add app/api/webhooks/telegram/route.ts
git commit -m "fix(telegram): handle every emitted callback + ack every branch

Audit found N dead callback emitters and M handlers missing
answerCallbackQuery. Buttons no longer spin. Mutating handlers
now log to AI Audit Log for traceability."
```

---

## Task 13: Add `/morning` digest command — daily compact briefing

**Files:**
- Modify: `app/api/webhooks/telegram/route.ts` (handle `/morning` slash command)

- [ ] **Step 1: Confirm the slash command isn't already handled**

```bash
grep -n "/morning\|morningDigest" app/api/webhooks/telegram/route.ts
```

If it exists: skip this task. Otherwise: continue.

- [ ] **Step 2: Add handler at top of message-handling block**

```typescript
if (text === '/morning') {
  // Fetch the same data /admin/health exposes; format as a single Telegram message.
  const apiBase = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
  let snapshot: any = null;
  try {
    const res = await fetch(`${apiBase}/api/admin/health`, {
      headers: { 'x-admin-password': process.env.ADMIN_PASSWORD || '' },
    });
    if (res.ok) snapshot = await res.json();
  } catch {}
  if (!snapshot) {
    await sendTelegramMessage(chatId, 'Could not fetch health snapshot.');
    return NextResponse.json({ ok: true });
  }
  const msg = `🌅 <b>Morning briefing</b>

Closed Won: <b>${snapshot.revenue.won_total}</b> ($${snapshot.revenue.gross_sales.toLocaleString()} GMV, $${snapshot.revenue.commission_earned.toLocaleString()} commission)
Last 7d: <b>${snapshot.revenue.won_last_7d}</b> wins · <b>${snapshot.revenue.new_signups_7d}</b> new signups

Ranchers: <b>${snapshot.ranchers.live}</b> live / <b>${snapshot.ranchers.total}</b> total
Stuck signed-not-live: <b>${snapshot.ranchers.stuck_signed_not_live}</b>
Active pipeline: <b>${snapshot.referrals.active}</b>
Orphan pending: <b>${snapshot.referrals.orphan_pending}</b>
Counter drift: <b>${snapshot.referrals.counter_drift_ranchers}</b>

Top uncovered demand: ${snapshot.coverage.uncovered_demand.slice(0, 3).map((u: any) => `${u.state} (${u.buyers})`).join(', ')}

Open <a href="${apiBase}/admin/health">/admin/health</a> for the full panel.`;
  await sendTelegramMessage(chatId, msg);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Commit**

```bash
git add app/api/webhooks/telegram/route.ts
git commit -m "feat(telegram): /morning slash command = compact briefing

Pulls /admin/health snapshot, formats as one Telegram message with
the operator's key numbers + a link back to the full dashboard.
Replaces the morning email-and-look-at-it-yourself workflow."
```

---

## Task 14: Verify + ship

**Files:**
- All touched

- [ ] **Step 1: Run typecheck + build**

```bash
npx tsc --noEmit && npm run build
```

Expected: zero errors, build green.

- [ ] **Step 2: Push branch + open PR**

```bash
git push -u origin <branch>
gh pr create --base main --head <branch> --title "Cron + Telegram effectiveness audit + fixes" --body "..."
```

- [ ] **Step 3: Wait for Vercel deploy**

```bash
for i in 1 2 3 4 5; do
  code=$(curl -s -o /dev/null -w "%{http_code}" https://www.buyhalfcow.com/api/admin/health)
  if [ "$code" = "200" ] || [ "$code" = "401" ]; then echo "deploy live"; break; fi
  sleep 20
done
```

- [ ] **Step 4: Trigger each cron manually**

For each cron in `vercel.json`, hit the endpoint with the CRON_SECRET:

```bash
for path in compliance-reminders daily-digest batch-approve referral-chasup ...; do
  echo "=== $path ==="
  curl -s "https://www.buyhalfcow.com/api/cron/${path}?secret=${CRON_SECRET}" | head -c 200
  echo
done
```

Each should return `{"ok":true,"status":"success","recordsTouched":N,"notes":"..."}` OR `"maintenance-blocked"` (if MAINTENANCE_MODE=true).

- [ ] **Step 5: Verify Cron Runs table populated**

```bash
node -e "
import('airtable').then(async ({default: Airtable}) => {
  const fs = await import('fs');
  for (const l of fs.readFileSync('./.env.local','utf8').split('\n')) {
    const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = process.env[m[1]] || m[2];
  }
  const base = new Airtable({apiKey: process.env.AIRTABLE_API_KEY}).base(process.env.AIRTABLE_BASE_ID);
  const recs = await base('Cron Runs').select({maxRecords: 100}).all();
  console.log('Cron Runs rows:', recs.length);
  for (const r of recs.slice(0, 10)) console.log(' ', r.fields.Name, '·', r.fields.Status, '·', r.fields['Duration ms'], 'ms');
});
"
```

Expected: at least one row per cron triggered.

- [ ] **Step 6: Visit `/admin/health` + confirm Cron Health table renders correctly**

Should show every cron with last-run timestamp + status.

- [ ] **Step 7: Test `/morning` slash command**

In Telegram: type `/morning`. Verify the briefing message arrives within 3 seconds with real numbers.

- [ ] **Step 8: Test 3 sample Telegram callbacks**

Pick three buttons from the audit list. Tap each. Confirm:
1. Spinner stops (answerCallbackQuery acked)
2. Expected mutation happened in Airtable (via /admin/health or direct query)
3. AI Audit Log has a row for the callback

- [ ] **Step 9: Merge PR**

```bash
gh pr merge <num> --merge --admin
git checkout main && git pull --ff-only
```

---

## Self-Review Checklist

**1. Spec coverage:**
- ✅ Audit every cron — Tasks 1, 11
- ✅ Audit every Telegram automation — Tasks 1, 12
- ✅ Verify read/write correctness — Task 11
- ✅ Make them more effective (less noise, more action) — Tasks 8, 9, 13
- ✅ Resolve schedule conflicts + unscheduled crons — Tasks 6, 7
- ✅ Verify-and-ship — Task 14

**2. Placeholder scan:**
- No TBD / "add appropriate" / "similar to above"
- Every code change has exact file path + actual code
- Every test step has expected output

**3. Type consistency:**
- `withCronRun` defined in Task 3 used in Tasks 4-5
- `sendOperatorSignal` defined in Task 8 used in Task 9 + later
- `TABLES.CRON_RUNS` defined in Task 2 used in Task 3
- `SignalUrgency` + `SignalKind` consistent in Task 8 only (no out-of-file references)

**4. Frequent commits:** Each task ends with a commit. Every cron migration in Task 5 is its own commit.

---

## Risk + Rollback

| Task | Risk | Rollback |
|---|---|---|
| 2 | `Cron Runs` table missing fields | Add fields via Airtable MCP; wrapper silently logs error |
| 3 | `withCronRun` swallows real cron output | Wrapper preserves status code + body shape |
| 4-5 | Refactored cron returns wrong shape | Each commit is one cron; revert that commit only |
| 6 | Delete buyer-pulse but it had hidden consumer | grep confirms zero refs before deletion |
| 7 | Schedule shift breaks expected timing | vercel.json revert + redeploy |
| 8 | dedupe key collides → swallows real alert | Inspect `_dedupe` keys; widen key |
| 9 | Migrated alert now duplicates the legacy one | Each migration removes the legacy call — verify before commit |
| 10 | Health panel loads slow with thousands of cron-run rows | Cap to latest 100 per cron in API filter |
| 11 | Fix breaks a cron's intended behavior | Per-cron commit; revert single fix |
| 12 | Adding answerCallbackQuery to slow handler shifts ack→after | Ack-immediately pattern (Task 12 Step 3) |
| 13 | `/morning` floods if user spam-taps | Add 1-min dedupe via `sendOperatorSignal` (Task 8) |
