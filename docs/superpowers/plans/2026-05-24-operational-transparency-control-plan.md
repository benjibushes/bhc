# BHC Operational Transparency + Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the transparency layer (SYSTEM-MAP doc), control layer (Telegram commands + frequency guard), and observability layer (spam audit cron + Email Sends Airtable table) defined in `docs/superpowers/specs/2026-05-24-operational-transparency-control-design.md`. Closes the "I hardly know what I've built" + "we're spamming inboxes" pain points and makes the platform safe to scale w/ paid ads.

**Architecture:** Three artifacts (SYSTEM-MAP.md / Spam Audit cron / Telegram commands) + one always-on guard (`lib/emailFrequencyGuard.ts`). All email sends from `lib/email.ts` are wrapped with the guard so the frequency cap + per-template kill-switch + suppression logging are centralized. New Airtable `Email Sends` table is the source of truth for both the cap calculation and the audit reporting.

**Tech Stack:** Next.js 16 API routes · Airtable MCP for schema + writes · Resend (existing) for email sends · Telegram bot for control + observability · withCronRun wrapper for the new cron · CRON_SECRET Bearer auth pattern (matches every other cron).

---

## File structure

### Files created

| File | Responsibility |
|---|---|
| `lib/emailFrequencyGuard.ts` | `checkFrequencyCap` + `logEmailSend` + whitelist constant |
| `app/api/cron/spam-audit/route.ts` | Weekly Saturday spam audit cron — Telegram digest + markdown archive |
| `docs/SYSTEM-MAP.md` | Single-page inventory of the platform |
| `docs/audits/.gitkeep` | Keep audits directory in git |

### Files modified

| File | Modification |
|---|---|
| `lib/airtable.ts` | Add `EMAIL_SENDS` to TABLES export |
| `lib/email.ts` | Wrap every named send helper w/ `checkFrequencyCap` + `logEmailSend` calls |
| `app/api/webhooks/telegram/route.ts` | Add 6 commands: `/emaillog` `/pausemail` `/resumemail` `/freqcap` `/templatestats` `/whatfired` + help text |
| `vercel.json` | Add spam-audit cron schedule |

### Airtable changes (via MCP)

| Table | Action |
|---|---|
| `Email Sends` (new) | Create w/ 7 fields: Sent At · Recipient Email · Recipient Consumer (linked) · Template Name · Subject · Status · Suppression Reason |

---

## Foresight — what could go wrong across the whole plan

Before any code: anticipate failure modes so each task has explicit mitigation:

| Risk | Likelihood | Mitigation in plan |
|---|---|---|
| Frequency guard catches a transactional email by accident → invoice never sends | Medium | Hard-coded TRANSACTIONAL_WHITELIST in `emailFrequencyGuard.ts`. Sends bypass cap entirely. |
| Email Sends table write fails → cap miscounts | Medium | Wrap log call in try/catch. Failure is non-fatal — email still goes. Log to console for debug. |
| Telegram command spam (`/emaillog` against 1k+ records) | Low | Cap return at 30 most-recent per Consumer. |
| /pausemail flag persists incorrectly → template killed forever | Medium | Store in existing Cron Pauses table. Telegram `/resumemail` clears it. Inspectable in Airtable. |
| Frequency cap too aggressive on first deploy → no emails fire | High | First deploy ships w/ cap = 10 (not 3). Tighten to 3 only after observing real send volume for 24h. |
| 60-second memoization cache shows stale count → over-cap by 1-2 sends | Low | Acceptable. Soft cap. 1-2 extra is noise. |
| SYSTEM-MAP.md becomes stale | High over time | Out of scope for this plan — future Phase 2 auto-generates from manifest. Manual updates expected. |
| Spam audit cron OOMs reading 1500+ Email Sends records | Low | Filter Airtable query to 7-day window. Process in single-pass aggregation. maxDuration=300. |
| Wrap-every-helper migration introduces regression in 1 of 30 templates | High | Smoke test each batch w/ /whatfired today after deploy. Roll back on first regression. |
| Sat 14:00 UTC = 7am MT — too early on weekend | Low | Acceptable. Can adjust schedule if user prefers later. |

---

## Task 1: Create Email Sends Airtable table

**Files:**
- Modify: `lib/airtable.ts` (TABLES export, add EMAIL_SENDS constant)

**What could go wrong:**
- Field type mismatch (e.g. dateTime needs IANA timezone, learned this the hard way w/ Routing Segment Last Sent At)
- Linked field to Consumers table requires the Consumers table ID

- [ ] **Step 1: Create Email Sends table via Airtable MCP**

Use `mcp__d5aec254-622f-48e6-9468-0b36405e9a80__create_field` after creating the table. First create the table itself via the workspace UI OR via MCP if available. Otherwise create fields one by one on a new table via Airtable web app.

Actually since MCP doesn't have `create_table`, create the table manually via the Airtable web app at:
- Base: `appgLT4z009iwAfhs` (BHC base)
- New table named exactly: `Email Sends`
- After table created, capture its `tbl...` ID from the URL

Then add the 7 fields via `mcp__d5aec254-622f-48e6-9468-0b36405e9a80__create_field`:

```json
[
  {"name": "Sent At", "type": "dateTime", "options": {"dateFormat": {"name": "iso"}, "timeFormat": {"name": "24hour"}, "timeZone": "America/Denver"}, "description": "When this email was sent OR suppressed. Source of truth for 7-day frequency cap calculation."},
  {"name": "Recipient Email", "type": "email", "description": "Email address the message was sent to. Indexed implicitly via Airtable single-line search."},
  {"name": "Recipient Consumer", "type": "multipleRecordLinks", "options": {"linkedTableId": "tblAbjQDnLrOtjpoE"}, "description": "Optional link to Consumers table. Populated when sender knew the Consumer record ID. Used by /emaillog Telegram command to traverse a Consumer's history."},
  {"name": "Template Name", "type": "singleLineText", "description": "Send-helper function name (e.g. sendNudgeToEngage). Used by /templatestats + /pausemail."},
  {"name": "Subject", "type": "singleLineText", "description": "Subject line at send time. Useful for the /emaillog audit trail when the buyer asks 'what email did I get from you'."},
  {"name": "Status", "type": "singleSelect", "options": {"choices": [{"name": "sent", "color": "greenLight2"}, {"name": "suppressed", "color": "yellowLight2"}, {"name": "bounced", "color": "redLight2"}, {"name": "complained", "color": "redBright"}]}, "description": "sent = went out · suppressed = cap or pause prevented send · bounced/complained = Resend webhook will update later"},
  {"name": "Suppression Reason", "type": "singleLineText", "description": "If Status=suppressed: short reason string (cap-exceeded / paused / unsubscribed / bounced / complained). Empty otherwise."}
]
```

- [ ] **Step 2: Verify table + fields exist via MCP `list_tables_for_base`**

```bash
# Via Claude:
# Call mcp__d5aec254...__list_tables_for_base with baseId=appgLT4z009iwAfhs
# Confirm Email Sends table appears with all 7 fields
```

Expected: Email Sends table present with table ID like `tblXXXXXXXXXXXXXXX`. Note this ID for next step.

- [ ] **Step 3: Add EMAIL_SENDS constant to lib/airtable.ts**

Open `lib/airtable.ts`. Find the `TABLES` export. Add the new entry:

```typescript
export const TABLES = {
  // ... existing entries ...
  EMAIL_SENDS: 'Email Sends',
} as const;
```

- [ ] **Step 4: Type-check**

```bash
cd "/Users/benji.bushes/BHC/untitled folder/bhc"
npx tsc --noEmit
```

Expected: no output (clean).

- [ ] **Step 5: Commit**

```bash
git add lib/airtable.ts
git commit -m "chore(airtable): add Email Sends to TABLES export — schema-only

Companion to docs/superpowers/specs/2026-05-24-operational-transparency-control-design.md
Task 1 of the operational transparency plan. Email Sends Airtable table
created manually via web app (no MCP create_table); 7 fields added via
create_field MCP calls. This commit only exposes the table name to TS
code via the TABLES const; subsequent tasks build the guard + logging
that writes to it."
```

- [ ] **Step 6: Push + verify Vercel deploy**

```bash
git push origin main
```

Wait for deploy. Run smoke check after deploy READY:

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://www.buyhalfcow.com/api/health
```

Expected: `HTTP 401` (auth-gated, alive).

---

## Task 2: Build emailFrequencyGuard module

**Files:**
- Create: `lib/emailFrequencyGuard.ts`

**What could go wrong:**
- Airtable rate limit if too many concurrent guard calls (use 60s memoization)
- Whitelist match fails because template name passed in differently than expected (always lowercase comparison)
- Date math timezone bug (use UTC consistently)

- [ ] **Step 1: Write the module**

Create file `lib/emailFrequencyGuard.ts`:

```typescript
import { getAllRecords, createRecord, TABLES, escapeAirtableValue } from './airtable';

/**
 * Per-recipient rolling 7-day email cap. Configurable via env var w/
 * a safe default. First deploy ships @ 10 to allow soft transition;
 * tighten to 3 after observing real volume for 24h via the spam audit.
 */
const DEFAULT_FREQUENCY_CAP = Number(process.env.EMAIL_FREQUENCY_CAP_PER_WEEK || 10);

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Templates that bypass the frequency cap entirely. These are
 * transactional sends that customers EXPECT and depend on (invoice,
 * approval, intro). Suppressing one of these would break revenue or
 * trust.
 */
export const TRANSACTIONAL_WHITELIST: ReadonlySet<string> = new Set([
  'sendInstantCommissionInvoice',
  'sendMonthlyCommissionInvoice',
  'sendRancherApproval',
  'sendBuyerIntroNotification',
  'sendInquiryToRancher',
  'sendMatchedDay4CheckIn',
  'sendConsumerApproval',
  'sendFoundingHerdWelcome',
  'sendRancherGoLiveEmail',
  'sendRancherSelfSubmitWelcome',
  'sendPilotUpsellEmail',
  'sendProspectClaimMagicLink',
]);

/**
 * Per-process memoization to avoid hammering Airtable with the same
 * recipient lookup 50x during a single cron run. 60-second TTL — soft
 * stale acceptable for cap accuracy.
 */
const _countCache: Map<string, { count: number; ts: number }> = new Map();
const CACHE_TTL_MS = 60_000;

export interface FrequencyGateResult {
  ok: boolean;
  reason?: 'cap-exceeded' | 'paused' | 'unsubscribed' | 'bounced' | 'complained';
  weekCount: number;
  cap: number;
}

/**
 * Check whether sending another email to `recipientEmail` for template
 * `templateName` would violate the frequency cap, pause flag, or known
 * suppression list. Transactional templates always pass.
 *
 * Returns `ok: true` to send. `ok: false` + reason to suppress.
 *
 * The pause check uses the existing Cron Pauses table (template names
 * stored alongside cron names). The unsubscribed/bounced/complained
 * checks are delegated to the caller for now — those flags live on
 * Consumers/Ranchers, not on Email Sends, and the guard doesn't know
 * the recipient type. Caller's existing suppression list should still
 * fire BEFORE this guard. The guard returns those reason values for
 * uniformity if a caller wants to use this as the single check.
 */
export async function checkFrequencyCap(
  recipientEmail: string,
  templateName: string,
): Promise<FrequencyGateResult> {
  const cap = DEFAULT_FREQUENCY_CAP;

  // Transactional whitelist — always pass.
  if (TRANSACTIONAL_WHITELIST.has(templateName)) {
    return { ok: true, weekCount: 0, cap };
  }

  // Check Cron Pauses table for a template-name pause entry.
  try {
    const pauses = await getAllRecords(
      TABLES.CRON_PAUSES,
      `AND({Name}="${escapeAirtableValue(templateName)}", {Paused}=TRUE())`,
    ) as any[];
    if (pauses.length > 0) {
      return { ok: false, reason: 'paused', weekCount: 0, cap };
    }
  } catch (e: any) {
    // Don't let pause-table read error block a send. Log + proceed.
    console.warn(`[freqGuard] pause check failed for ${templateName}:`, e?.message);
  }

  // Count rolling 7-day sends to this recipient.
  let count = 0;
  const cached = _countCache.get(recipientEmail.toLowerCase());
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    count = cached.count;
  } else {
    try {
      const sinceISO = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
      const safeEmail = escapeAirtableValue(recipientEmail.toLowerCase());
      const records = await getAllRecords(
        TABLES.EMAIL_SENDS,
        `AND(LOWER({Recipient Email})="${safeEmail}", {Sent At} > "${sinceISO}", {Status}="sent")`,
      ) as any[];
      count = records.length;
      _countCache.set(recipientEmail.toLowerCase(), { count, ts: Date.now() });
    } catch (e: any) {
      console.warn(`[freqGuard] count read failed for ${recipientEmail}, failing open:`, e?.message);
      // Fail open — if we can't read, let the send through. Better to
      // over-send by a few than to drop critical email during an Airtable
      // outage.
      return { ok: true, weekCount: 0, cap };
    }
  }

  if (count >= cap) {
    return { ok: false, reason: 'cap-exceeded', weekCount: count, cap };
  }
  return { ok: true, weekCount: count, cap };
}

/**
 * Append a row to the Email Sends Airtable table. Used by every
 * named send helper after either dispatching to Resend or suppressing.
 * Non-fatal: logs failure to console + continues.
 */
export async function logEmailSend(input: {
  recipientEmail: string;
  recipientConsumerId?: string;
  templateName: string;
  subject: string;
  status: 'sent' | 'suppressed' | 'bounced' | 'complained';
  suppressionReason?: string;
}): Promise<void> {
  try {
    const fields: any = {
      'Sent At': new Date().toISOString(),
      'Recipient Email': input.recipientEmail.toLowerCase(),
      'Template Name': input.templateName,
      'Subject': input.subject.slice(0, 500),
      'Status': input.status,
    };
    if (input.suppressionReason) {
      fields['Suppression Reason'] = input.suppressionReason;
    }
    if (input.recipientConsumerId) {
      fields['Recipient Consumer'] = [input.recipientConsumerId];
    }
    await createRecord(TABLES.EMAIL_SENDS, fields);
    // Invalidate the cap cache for this recipient — next send will refresh.
    _countCache.delete(input.recipientEmail.toLowerCase());
  } catch (e: any) {
    console.warn(`[freqGuard] logEmailSend failed:`, e?.message);
  }
}

/**
 * Helper for callers that already have the recipient Consumer record id.
 * Returns the same shape as `checkFrequencyCap` but skips the Cron Pauses
 * lookup for transactional templates (perf).
 */
export function isTransactionalTemplate(templateName: string): boolean {
  return TRANSACTIONAL_WHITELIST.has(templateName);
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Manual smoke** — write a one-shot script `scripts/smoke-freq-guard.ts` that imports + tests `checkFrequencyCap` against a fresh email address (should return `ok: true, weekCount: 0`).

Skip the script — instead, verify by running this in a Node REPL OR by adding a one-time test from a cron at next deploy.

For now, defer smoke until Task 3 wires guard into a real send path.

- [ ] **Step 4: Commit**

```bash
git add lib/emailFrequencyGuard.ts
git commit -m "feat(email): frequency guard module — per-recipient 7-day cap

Task 2 of the operational transparency plan. New module wraps the
two functions every email send helper will call:

  checkFrequencyCap(email, templateName) - returns {ok, reason, weekCount, cap}
  logEmailSend({email, template, subject, status, ...})

Hard-coded TRANSACTIONAL_WHITELIST bypasses cap for invoices, intro
emails, approvals, etc. — sends customers expect that suppressing
would break revenue/trust.

Default cap: 10 emails/recipient/7d via EMAIL_FREQUENCY_CAP_PER_WEEK
env var (intentionally permissive first deploy; tighten to 3 after
observing real volume).

60s in-process memoization keeps Airtable load down across hot cron
runs. Fail-open on Airtable read errors so transient outages can't
silently drop email.

Pause flag piggybacks Cron Pauses table — template names live in
the same Name field as cron names. /pausemail Telegram command (Task 5)
will write entries here."
```

- [ ] **Step 5: Push**

```bash
git push origin main
```

Verify Vercel deploys clean (no build error since module isn't imported yet).

---

## Task 3: Wrap every named email send helper with guard + log

**Files:**
- Modify: `lib/email.ts`

**What could go wrong:**
- Wrapping ~30 helpers risks one-off regressions. Whitelist transactional templates from being affected (cap-wise they bypass but they STILL log — operator needs the audit trail).
- A helper that's used inside a cron that runs every minute could fall behind on logEmailSend calls if Airtable rate-limits.
- Template name string must match the function name exactly for `/pausemail` + `/templatestats` to work.

- [ ] **Step 1: List every named send helper**

```bash
grep -n "^export async function send" lib/email.ts | head -50
```

Expected output (canonical list from current codebase, ~30 functions):

```
sendBroadcastEmail, sendConsumerApproval, sendInquiryAlertToAdmin,
sendRancherApproval, sendRancherGoLiveEmail, sendNewLeadAlert,
sendInquiryToRancher, sendFoundingHerdWelcome, sendStripeWebhookAlert,
sendFounderLetterWaiting, sendMatchedDay4CheckIn, sendCutsEducation,
sendClosedMonthlyLetter, sendRepeatPurchaseAsk, sendBuyerIntroNotification,
sendRancherLeadNudge, sendRepeatPurchaseEmail, sendBackfillEmail,
sendRancherCheckIn, sendPipelineUpdateEmail, sendTrackedContactEmail,
sendEmail, sendInstantCommissionInvoice, sendMonthlyCommissionInvoice,
sendRancherLaunchWarmup, sendRancherLaunchWarmupNudge,
sendRancherLeadReminder, sendAbandonedRecoveryEmail, sendRerouteNotification,
sendProspectClaimMagicLink, sendRancherSelfSubmitWelcome,
sendRancherCommunityIntro, sendRancherOnboardingDripDay2,
sendRancherOnboardingDripDay5, sendRancherOnboardingDripDay14,
sendMatchNowRescue, sendNudgeToEngage, sendWarmLeadReadyCheck,
sendNoBudgetFounderPitch, sendStateWaitlistLetter, sendIncompleteProfileAsk,
sendPilotUpsellEmail
```

- [ ] **Step 2: Add the guard import + a helper wrapper at top of lib/email.ts**

Open `lib/email.ts`. Below the existing imports, add:

```typescript
import { checkFrequencyCap, logEmailSend } from './emailFrequencyGuard';
```

Then below `getUnsubscribeHeaders`, add a private helper:

```typescript
/**
 * Wrap a Resend send call with the frequency guard + audit log.
 * Returns {success, suppressed?, reason?} for callers that want to
 * surface suppression to their cron summary.
 */
async function guardedSend(opts: {
  templateName: string;
  recipientEmail: string;
  recipientConsumerId?: string;
  subject: string;
  send: () => Promise<unknown>;
}): Promise<{ success: boolean; suppressed?: boolean; reason?: string }> {
  const gate = await checkFrequencyCap(opts.recipientEmail, opts.templateName);
  if (!gate.ok) {
    await logEmailSend({
      recipientEmail: opts.recipientEmail,
      recipientConsumerId: opts.recipientConsumerId,
      templateName: opts.templateName,
      subject: opts.subject,
      status: 'suppressed',
      suppressionReason: gate.reason || 'unknown',
    });
    return { success: false, suppressed: true, reason: gate.reason };
  }
  try {
    await opts.send();
    await logEmailSend({
      recipientEmail: opts.recipientEmail,
      recipientConsumerId: opts.recipientConsumerId,
      templateName: opts.templateName,
      subject: opts.subject,
      status: 'sent',
    });
    return { success: true };
  } catch (error: any) {
    // Don't log to Email Sends as 'sent' if Resend threw — that would
    // poison the cap calc. Let the caller see the error.
    throw error;
  }
}
```

- [ ] **Step 3: Wrap helper #1 — sendNudgeToEngage (non-transactional, prototype the pattern)**

Find `export async function sendNudgeToEngage(data: ...)`. Refactor:

```typescript
export async function sendNudgeToEngage(data: {
  email: string;
  firstName: string;
  buyerState: string;
  engageUrl: string;
}) {
  const subject = `quick question on your ${data.buyerState} beef timing`;
  return guardedSend({
    templateName: 'sendNudgeToEngage',
    recipientEmail: data.email,
    subject,
    send: () =>
      resend.emails.send({
        from: getFromEmail(),
        to: data.email,
        subject,
        headers: getUnsubscribeHeaders(data.email),
        html: `<!DOCTYPE html>...existing HTML...`,
      }),
  });
}
```

Keep the existing HTML body — only the outer call structure changes.

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Wrap each remaining helper in the same pattern**

For every helper in the list from Step 1: replace the `await resend.emails.send({...})` call with `return guardedSend({...})`. The `templateName` is the function name. Use the existing `subject` variable (or extract it if inlined). The `recipientEmail` is the `to` field. Pass `recipientConsumerId` if the helper has access to a consumer record id (most don't).

Do this in batches of 5 helpers per commit to keep diffs reviewable. After each batch, type-check + commit.

Note: for `sendEmail` (the generic helper used by ad-hoc broadcasts), set `templateName: 'sendEmail'` so it shows up in `/templatestats` as a catch-all bucket.

- [ ] **Step 6: Type-check after all helpers wrapped**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit per batch**

```bash
# After each batch of 5 wrapped:
git add lib/email.ts
git commit -m "feat(email): wrap batch N of email helpers with frequency guard

Task 3 batch N of N. Each wrapped helper now passes through
guardedSend() which (a) checks cap via checkFrequencyCap, (b) suppresses
+ logs if cap-exceeded/paused, (c) sends via existing Resend call,
(d) logs successful send to Email Sends table. Net behavior change:
non-transactional templates respect 10/7d default cap; transactional
whitelist (12 templates) bypasses cap but still logs."
```

- [ ] **Step 8: Push all batches at once OR per-batch**

```bash
git push origin main
```

- [ ] **Step 9: Vercel deploy smoke**

After deploy READY, trigger one cron manually:

```bash
curl -X POST "https://www.buyhalfcow.com/api/cron/email-sequences" \
  -H "Authorization: Bearer $CRON_SECRET"
```

(or wait for natural fire at 16:00 UTC). Then check Airtable Email Sends table — rows should appear.

Expected: 1+ rows in Email Sends w/ Status=sent. Verify Template Name matches helper function name. Verify Subject populated. Verify Recipient Email lowercased.

---

## Task 4: Build /api/cron/spam-audit route

**Files:**
- Create: `app/api/cron/spam-audit/route.ts`
- Modify: `vercel.json` (add schedule)

**What could go wrong:**
- Saturday 14:00 UTC = 7am MT. User is in MT. Acceptable per spec but mention if they want later.
- Telegram message length limit (~4096 chars). Need to truncate top-20 lists.
- File write for markdown archive needs `fs/promises` import — verify Vercel allows file writes (it doesn't — read-only FS). Pivot: write to `docs/audits/` via git commit OR skip markdown archive in v1 and only do Telegram digest.

**Decision applied:** v1 skips the markdown archive (file writes don't work on Vercel serverless). Telegram digest is the deliverable. Phase 2 stores the digest as an Airtable row in a new `Audit Reports` table for browsable history.

- [ ] **Step 1: Write the cron route**

Create `app/api/cron/spam-audit/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { withCronRun } from '@/lib/cronRun';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { CRON_SECRET } from '@/lib/secrets';

export const maxDuration = 300;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

async function realHandler(
  _request: Request,
): Promise<{
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}> {
  const sinceISO = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();

  // Pull past 7d of sends + suppressions
  const allSends = (await getAllRecords(
    TABLES.EMAIL_SENDS,
    `{Sent At} > "${sinceISO}"`,
  )) as any[];

  // Aggregate by recipient
  const byRecipient: Record<string, { count: number; templates: string[] }> = {};
  const byTemplate: Record<string, number> = {};
  let suppressedCount = 0;

  for (const row of allSends) {
    const email = String(row['Recipient Email'] || '').toLowerCase();
    const template = String(row['Template Name'] || 'unknown');
    const status = String(row['Status'] || '');

    if (status === 'sent') {
      byRecipient[email] = byRecipient[email] || { count: 0, templates: [] };
      byRecipient[email].count++;
      if (byRecipient[email].templates.length < 6) {
        byRecipient[email].templates.push(template);
      }
      byTemplate[template] = (byTemplate[template] || 0) + 1;
    } else if (status === 'suppressed') {
      suppressedCount++;
    }
  }

  // Top 20 recipients by send count
  const topRecipients = Object.entries(byRecipient)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20);

  // Cap-breach list: anyone with >3 sends in 7 days (matches default cap)
  const capBreaches = topRecipients.filter(([, v]) => v.count > 3);

  // Templates ranked by send volume
  const topTemplates = Object.entries(byTemplate)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Build Telegram digest
  const lines: string[] = [];
  lines.push(`📊 <b>SPAM AUDIT</b> · Week ending ${new Date().toISOString().slice(0, 10)}\n`);
  lines.push(`<b>Top 20 high-volume recipients</b> (last 7d):`);
  for (const [email, v] of topRecipients.slice(0, 20)) {
    const tmplList = v.templates.join(', ');
    lines.push(`${v.count}× ${email}\n  ${tmplList}`);
  }
  lines.push('');
  lines.push(`<b>Cap breaches</b> (>3 emails/week): <b>${capBreaches.length}</b>`);
  if (capBreaches.length > 0) {
    lines.push('Run <code>/emaillog &lt;email&gt;</code> on each to inspect.');
  }
  lines.push('');
  lines.push(`<b>Templates by volume</b>:`);
  for (const [template, count] of topTemplates) {
    lines.push(`${count}× ${template}`);
  }
  lines.push('');
  lines.push(`<b>Suppressions this week</b>: ${suppressedCount}`);
  lines.push(`<b>Total sends this week</b>: ${allSends.length - suppressedCount}`);

  const digest = lines.join('\n').slice(0, 4000); // Telegram cap

  if (TELEGRAM_ADMIN_CHAT_ID) {
    await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, digest);
  }

  return {
    status: 'success',
    recordsTouched: allSends.length,
    notes: `total=${allSends.length} sends=${allSends.length - suppressedCount} suppressed=${suppressedCount} top=${topRecipients.length} breaches=${capBreaches.length}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  if (CRON_SECRET) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      const { searchParams } = new URL(request.url);
      if (searchParams.get('secret') !== CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('spam-audit', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
```

- [ ] **Step 2: Add cron schedule to vercel.json**

Open `vercel.json`. In the `crons` array, append:

```json
{ "path": "/api/cron/spam-audit", "schedule": "0 14 * * 6" }
```

(Saturday 14:00 UTC.)

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/spam-audit/route.ts vercel.json
git commit -m "feat(cron): weekly spam-audit cron — Saturday Telegram digest

Task 4 of the operational transparency plan. Aggregates last 7d of
Email Sends rows, ranks top 20 high-volume recipients + top 10
templates by volume + counts cap breaches + total suppressions. Posts
a single Telegram message to the operator chat. Schedule: 0 14 * * 6
(Saturday 14:00 UTC = 7am MT).

v1 skips the markdown archive — Vercel serverless filesystem is
read-only. Phase 2 will write the digest to a new Audit Reports
Airtable table for browsable history."
```

- [ ] **Step 5: Push + deploy verify**

```bash
git push origin main
```

After deploy READY, trigger manually:

```bash
curl -X POST "https://www.buyhalfcow.com/api/cron/spam-audit" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Expected: HTTP 200. Telegram chat receives "📊 SPAM AUDIT" digest (probably mostly empty since Email Sends table is fresh).

---

## Task 5: Add 6 Telegram commands

**Files:**
- Modify: `app/api/webhooks/telegram/route.ts`

**What could go wrong:**
- Conflict with existing command names — verified `/emaillog` `/pausemail` `/resumemail` `/freqcap` `/templatestats` `/whatfired` don't exist yet.
- HTML escaping — Telegram bot uses `parseMode: 'HTML'`. Must escape `<`, `>`, `&` in dynamic content.
- Cron Pauses table reuse — template-name pauses use same table as cron pauses. Visually they look the same but functionally distinct; that's OK.

- [ ] **Step 1: Add `/emaillog` command**

Open `app/api/webhooks/telegram/route.ts`. Find the existing routing block after `/routingstatus` command. Add:

```typescript
// /emaillog <email-or-name> — show last 30d of emails sent to a Consumer.
else if (text.startsWith('/emaillog ')) {
  const arg = text.slice('/emaillog '.length).trim().toLowerCase();
  if (!arg) {
    await sendTelegramMessage(chatId, 'Usage: <code>/emaillog &lt;email&gt;</code>');
  } else {
    try {
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      const sinceISO = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
      const safeArg = arg.replace(/"/g, '');
      const sends = (await getAllRecords(
        TABLES.EMAIL_SENDS,
        `AND(LOWER({Recipient Email})="${safeArg}", {Sent At} > "${sinceISO}")`,
      )) as any[];
      if (sends.length === 0) {
        await sendTelegramMessage(chatId, `📭 No emails sent to <code>${arg}</code> in last 30d.`);
      } else {
        const sorted = sends.sort((a, b) =>
          new Date(b['Sent At']).getTime() - new Date(a['Sent At']).getTime()
        ).slice(0, 30);
        const lines = sorted.map((s: any) => {
          const ts = new Date(s['Sent At']).toISOString().slice(0, 16).replace('T', ' ');
          const status = (s['Status'] || '').toString();
          const tag = status === 'sent' ? '✅' : status === 'suppressed' ? '⏸️' : '⚠️';
          return `${tag} ${ts} · <b>${s['Template Name'] || '?'}</b>${s['Suppression Reason'] ? ` (${s['Suppression Reason']})` : ''}`;
        });
        const sentCount = sends.filter((s: any) => s['Status'] === 'sent').length;
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
        const sevenDaysAgo = Date.now() - SEVEN_DAYS_MS;
        const last7d = sends.filter((s: any) =>
          new Date(s['Sent At']).getTime() > sevenDaysAgo && s['Status'] === 'sent'
        ).length;
        await sendTelegramMessage(
          chatId,
          `📧 <b>EMAIL LOG</b> · ${arg}\n\n` +
          `Past 30d: ${sentCount} sent, ${sends.length - sentCount} suppressed\n` +
          `Past 7d: ${last7d} sent\n\n` +
          lines.join('\n')
        );
      }
    } catch (e: any) {
      await sendTelegramMessage(chatId, `⚠️ /emaillog failed: ${e?.message || 'unknown'}`);
    }
  }
}
```

- [ ] **Step 2: Add `/pausemail` + `/resumemail` commands**

Below `/emaillog`:

```typescript
// /pausemail <template-name> — kill a specific email template
else if (text.startsWith('/pausemail ')) {
  const name = text.slice('/pausemail '.length).trim();
  if (!name) {
    await sendTelegramMessage(chatId, 'Usage: <code>/pausemail &lt;template-name&gt;</code>\n\nExample: <code>/pausemail sendRancherCheckIn</code>');
  } else {
    try {
      await pauseCron(name, 'telegram', 'paused via /pausemail');
      await sendTelegramMessage(chatId, `⏸️ Paused email template <code>${name}</code>. Use <code>/resumemail ${name}</code> to resume.`);
    } catch (e: any) {
      await sendTelegramMessage(chatId, `⚠️ /pausemail failed: ${e?.message || 'unknown'}`);
    }
  }
}

// /resumemail <template-name> — re-enable a template
else if (text.startsWith('/resumemail ')) {
  const name = text.slice('/resumemail '.length).trim();
  if (!name) {
    await sendTelegramMessage(chatId, 'Usage: <code>/resumemail &lt;template-name&gt;</code>');
  } else {
    try {
      await resumeCron(name);
      await sendTelegramMessage(chatId, `▶️ Resumed email template <code>${name}</code>.`);
    } catch (e: any) {
      await sendTelegramMessage(chatId, `⚠️ /resumemail failed: ${e?.message || 'unknown'}`);
    }
  }
}
```

- [ ] **Step 3: Add `/freqcap` command**

```typescript
// /freqcap <number> | show — global rolling 7d cap per Consumer
else if (text === '/freqcap show' || text === '/freqcap') {
  const cap = process.env.EMAIL_FREQUENCY_CAP_PER_WEEK || '10 (default)';
  await sendTelegramMessage(
    chatId,
    `<b>Frequency cap</b>: ${cap} emails/Consumer/7d\n\n` +
    `Change via Vercel env var <code>EMAIL_FREQUENCY_CAP_PER_WEEK</code> + redeploy.\n` +
    `Transactional templates (invoices, intros, approvals) bypass the cap.`
  );
}
```

- [ ] **Step 4: Add `/templatestats` command**

```typescript
// /templatestats — per-template send count last 30 days
else if (text === '/templatestats') {
  try {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const sinceISO = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
    const sends = (await getAllRecords(
      TABLES.EMAIL_SENDS,
      `{Sent At} > "${sinceISO}"`,
    )) as any[];
    const byTemplate: Record<string, { sent: number; suppressed: number }> = {};
    for (const s of sends) {
      const t = String(s['Template Name'] || '?');
      byTemplate[t] = byTemplate[t] || { sent: 0, suppressed: 0 };
      if (s['Status'] === 'sent') byTemplate[t].sent++;
      else if (s['Status'] === 'suppressed') byTemplate[t].suppressed++;
    }
    const ranked = Object.entries(byTemplate)
      .sort((a, b) => b[1].sent - a[1].sent)
      .slice(0, 25);
    const lines = ranked.map(([t, v]) =>
      `${v.sent.toString().padStart(4)} sent${v.suppressed > 0 ? ` · ${v.suppressed} supp` : ''}  ${t}`
    );
    await sendTelegramMessage(
      chatId,
      `📈 <b>TEMPLATE STATS</b> · Last 30 days\n\n` +
      `<pre>${lines.join('\n')}</pre>\n\n` +
      `Open/click data not yet wired (Phase 2 via Resend webhooks).`
    );
  } catch (e: any) {
    await sendTelegramMessage(chatId, `⚠️ /templatestats failed: ${e?.message || 'unknown'}`);
  }
}
```

- [ ] **Step 5: Add `/whatfired` command**

```typescript
// /whatfired today | yesterday | YYYY-MM-DD — daily activity summary
else if (text.startsWith('/whatfired')) {
  const arg = text.slice('/whatfired'.length).trim() || 'today';
  try {
    let targetDate: Date;
    if (arg === 'today') targetDate = new Date();
    else if (arg === 'yesterday') targetDate = new Date(Date.now() - 86400000);
    else targetDate = new Date(arg);
    if (isNaN(targetDate.getTime())) {
      await sendTelegramMessage(chatId, 'Usage: <code>/whatfired today</code> or <code>/whatfired yesterday</code> or <code>/whatfired YYYY-MM-DD</code>');
      return NextResponse.json({ ok: true });
    }
    const dayStart = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const [cronRuns, sends] = await Promise.all([
      getAllRecords(
        TABLES.CRON_RUNS,
        `AND({Started At} >= "${dayStart.toISOString()}", {Started At} < "${dayEnd.toISOString()}")`,
      ) as Promise<any[]>,
      getAllRecords(
        TABLES.EMAIL_SENDS,
        `AND({Sent At} >= "${dayStart.toISOString()}", {Sent At} < "${dayEnd.toISOString()}")`,
      ) as Promise<any[]>,
    ]);
    const cronByName: Record<string, { count: number; lastStatus: string }> = {};
    for (const c of cronRuns) {
      const n = String(c['Name'] || '?');
      cronByName[n] = cronByName[n] || { count: 0, lastStatus: '' };
      cronByName[n].count++;
      cronByName[n].lastStatus = String(c['Status'] || '');
    }
    const sendsByTemplate: Record<string, number> = {};
    for (const s of sends) {
      if (s['Status'] !== 'sent') continue;
      const t = String(s['Template Name'] || '?');
      sendsByTemplate[t] = (sendsByTemplate[t] || 0) + 1;
    }
    const cronLines = Object.entries(cronByName).map(([n, v]) =>
      `${v.lastStatus === 'success' ? '✅' : v.lastStatus === 'partial' ? '🟡' : v.lastStatus === 'paused' ? '⏸️' : '❌'} ${n} (×${v.count})`
    );
    const sendLines = Object.entries(sendsByTemplate)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([t, n]) => `${n}× ${t}`);
    await sendTelegramMessage(
      chatId,
      `🤖 <b>WHAT FIRED</b> · ${dayStart.toISOString().slice(0, 10)}\n\n` +
      `<b>Crons (${cronRuns.length} runs)</b>:\n${cronLines.join('\n') || 'none'}\n\n` +
      `<b>Emails sent (${sends.filter(s => s['Status'] === 'sent').length} total)</b>:\n${sendLines.join('\n') || 'none'}`
    );
  } catch (e: any) {
    await sendTelegramMessage(chatId, `⚠️ /whatfired failed: ${e?.message || 'unknown'}`);
  }
}
```

- [ ] **Step 6: Add commands to help text**

Find the existing `/help` command output. Below the `/routingstatus` line, add:

```
/emaillog [email] — Last 30d email log for a Consumer
/pausemail [template] — Kill a specific email template
/resumemail [template] — Re-enable a paused template
/freqcap — Show current cap
/templatestats — Per-template send count last 30d
/whatfired [today|yesterday|YYYY-MM-DD] — Daily activity summary
```

- [ ] **Step 7: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit + push**

```bash
git add app/api/webhooks/telegram/route.ts
git commit -m "feat(telegram): 6 commands for email observability + control

Task 5 of the operational transparency plan.

/emaillog <email>       Last 30d email log for a Consumer (sent +
                        suppressed, w/ template names + timestamps)
/pausemail <template>   Kill a specific email template via Cron Pauses
/resumemail <template>  Re-enable a paused template
/freqcap                Show current cap (env-driven, default 10/7d)
/templatestats          Per-template send count + suppression count
                        last 30 days, ranked
/whatfired [day]        Crons run + emails sent for a given day —
                        accepts 'today', 'yesterday', or YYYY-MM-DD

All commands read from the Email Sends + Cron Runs Airtable tables
populated by guardedSend() (Task 3) + withCronRun (existing). No
mutation surface — pure observability + the existing pauseCron
helper for the kill switch."
git push origin main
```

- [ ] **Step 9: Deploy + smoke**

After Vercel READY, send `/emaillog` (no arg) in Telegram → expect usage message. Send `/freqcap` → expect cap info. Send `/whatfired today` → expect today's cron + email summary.

---

## Task 6: Write initial docs/SYSTEM-MAP.md

**Files:**
- Create: `docs/SYSTEM-MAP.md`
- Create: `docs/audits/.gitkeep`

**What could go wrong:**
- File grows too long (>2000 lines) — keep it scan-readable w/ tables.
- Drift the moment it ships — accept it. Founder will update major changes.
- Inaccurate description of a process — copy from existing code comments + spec docs, not from memory.

- [ ] **Step 1: Write docs/SYSTEM-MAP.md sections**

Create the file. Structure per spec. Pull data from existing files:
- Public pages: enumerate by `app/*/page.tsx`
- API endpoints: enumerate by `app/api/**/route.ts`
- Crons: cross-check `vercel.json` `crons` array
- Email templates: pull from `lib/email.ts` `^export async function send` list
- Airtable tables: pull from `lib/airtable.ts` `TABLES` const
- Telegram commands: pull from `app/api/webhooks/telegram/route.ts` w/ grep `text === '/...'` or `text.startsWith('/...`

Format each section as a table with: Name · Purpose · Revenue Tier · Status · Link to source.

Use `grep` + `find` to enumerate accurately. Don't rely on memory.

- [ ] **Step 2: Create docs/audits/.gitkeep**

```bash
mkdir -p docs/audits && touch docs/audits/.gitkeep
```

- [ ] **Step 3: Commit + push**

```bash
git add docs/SYSTEM-MAP.md docs/audits/.gitkeep
git commit -m "docs: SYSTEM-MAP.md — single-page platform inventory

Task 6 of the operational transparency plan. Single-page reference
for every public page, API endpoint, cron, email template, Airtable
table, Telegram command, and routing path. Each entry: purpose,
revenue tier (high/medium/low/zero), status (live/broken/deprecated),
link to source.

Initial pass authored 2026-05-24. Manual updates expected when major
changes ship. Future Phase 2 may auto-generate from a manifest file."
git push origin main
```

---

## Task 7: Three-pass post-build audit

**Files:**
- Create: `docs/audits/2026-05-24-post-build-audit.md` (consolidated audit output)

**What could go wrong:**
- A regression introduced by Task 3's wrap-every-helper that we missed in batch type-check (e.g. a helper that depended on return type being `Promise<void>` now returns `Promise<{success: bool}>`).
- Frequency cap of 10 too tight for existing high-volume buyers (Founder backers who got a welcome + a Day-2 + a Day-5 onboarding drip + a founder letter all in one week = 4 emails, would hit cap on 11th).
- The 7 stuck Pending Approval referrals (from prior session) are STILL pending if the cron hasn't fired since.

### Pass A — Functional verification

- [ ] **A1: Manual trigger every new cron + command + verify output**

```bash
# Spam audit cron
curl -X POST "https://www.buyhalfcow.com/api/cron/spam-audit" \
  -H "Authorization: Bearer $CRON_SECRET"
# Expect: 200 + Telegram digest received

# Telegram: send each command in BHC bot chat
/emaillog karie.suarez@gmail.com   → expect log w/ Renick Valley warmups
/freqcap                            → expect cap value display
/templatestats                      → expect 25-row template ranking
/whatfired today                    → expect today's crons + email summary
/pausemail sendRancherCheckIn       → expect "paused" confirmation
/resumemail sendRancherCheckIn      → expect "resumed" confirmation
```

Each command should return a non-error response. Record actual outputs in the audit doc.

- [ ] **A2: Verify Email Sends table populated correctly**

```bash
# Check via MCP that Email Sends has rows from today's cron runs
# Confirm Template Name matches helper function names
# Confirm Status enum populated correctly
```

Open Airtable Email Sends table directly OR query via MCP list_records_for_table. Note: timestamps in `America/Denver` per schema.

- [ ] **A3: Frequency guard happy + sad path**

Pick one non-transactional template and one Consumer with 0 emails this week. Manually trigger the helper (via `/forcematch` or direct cron). Expect: Email Sends row created w/ Status=sent.

Then: with EMAIL_FREQUENCY_CAP_PER_WEEK=1, send a second email to that Consumer same week. Expect: Email Sends row created w/ Status=suppressed, Suppression Reason=cap-exceeded.

Reset cap to 10 after verification.

### Pass B — Regression check on existing flows

- [ ] **B1: existing crons still fire green**

```
/cronstatus
```

Expect: every cron in last 24h shows status=success (except the known-paused or known-transient daily-audit). New spam-audit cron present.

- [ ] **B2: existing email touchpoints still send**

Trigger a known existing flow — e.g. fire `/api/cron/rancher-launch-warmup` manually:

```bash
curl -X POST "https://www.buyhalfcow.com/api/cron/rancher-launch-warmup" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Verify: rows created in Email Sends w/ Template Name=sendRancherLaunchWarmup, Status=sent. NO warmup emails dropped except where cap hit.

- [ ] **B3: matching/suggest end-to-end still works**

Fire one synthetic R2B click against a covered state via `/api/warmup/engage` (with a known buyer's JWT). Verify: matching/suggest returns matchFound=true, referral created w/ Status=Intro Sent, buyer + rancher both received intro emails. Confirm Email Sends has rows for both sendBuyerIntroNotification + sendInquiryToRancher (transactional whitelist active).

- [ ] **B4: Stripe invoice fire still works**

Trigger a known Closed Won transition (or simulate via `/api/rancher/referrals/[id]` PATCH). Verify: Stripe invoice fires, Email Sends has row for sendInstantCommissionInvoice w/ Status=sent (transactional whitelist active).

### Pass C — Customer-experience pass

- [ ] **C1: No buyer accidentally over-emailed**

Run `/templatestats` after at least one daily cron cycle. Look at high-volume templates. For top 3 templates by send volume, run `/emaillog` against the top 3 recipients of each. Confirm no recipient is receiving more than (Cap × 2) = 20 emails/7d (would indicate cap not working).

- [ ] **C2: No rancher inbox spammed**

Same as C1 but for rancher emails (sendRancherLeadNudge, sendRancherCheckIn, sendRancherLaunchWarmup, sendRancherLeadReminder). For each rancher in network, check Email Sends `Recipient Email` = rancher's email. Confirm no rancher receiving > 5 emails/7d.

- [ ] **C3: Suppression rate sanity check**

Look at past-7d suppression count via `/templatestats`. Should be 0-20 range. Higher than 20 = cap too low + protection working OR cap is blocking too much.

- [ ] **C4: Founder backer experience**

Pull list of Consumers w/ Founder Tier != null. For each: `/emaillog`. Verify Founder letters firing on schedule, no accidental suppression of sendFoundingHerdWelcome (whitelisted) or sendFounderLetterWaiting.

### Audit deliverable

- [ ] **Step Final: Write findings to docs/audits/2026-05-24-post-build-audit.md**

Format:

```markdown
# Post-Build Audit — 2026-05-24

## Pass A — Functional
- [pass/fail] A1: every new command/cron verified
- [pass/fail] A2: Email Sends populated
- [pass/fail] A3: cap happy + sad path

## Pass B — Regression
- [pass/fail] B1: existing crons green
- [pass/fail] B2: existing emails still send
- [pass/fail] B3: matching/suggest E2E
- [pass/fail] B4: Stripe invoice fire

## Pass C — Customer Experience
- [pass/fail] C1: no buyer over-emailed
- [pass/fail] C2: no rancher spammed
- [pass/fail] C3: suppression rate sane
- [pass/fail] C4: Founder backer experience

## Issues found
- (list each w/ severity + proposed fix OR follow-up task)

## Ship status
✅ READY FOR PAID ADS | 🟡 SHIPPING WITH FOLLOW-UPS | 🚨 ROLLBACK NEEDED
```

Commit + push:

```bash
git add docs/audits/2026-05-24-post-build-audit.md
git commit -m "docs(audit): post-build verification — 3-pass audit results

Task 7 of the operational transparency plan. Functional / regression /
customer-experience pass results captured. Tag at top indicates ship
status: READY FOR PAID ADS, SHIPPING WITH FOLLOW-UPS, or ROLLBACK NEEDED."
git push origin main
```

---

## Final verification — "ready for paid ads" gate

After Task 7 audit complete, the final check before declaring ship-ready:

- [ ] All 7 tasks committed + deployed to prod
- [ ] /cronstatus shows spam-audit cron in the list (will fire next Saturday)
- [ ] /templatestats returns at least 5 templates w/ send counts
- [ ] /emaillog against a known Consumer returns a populated log
- [ ] Email Sends Airtable table has rows w/ Template Name populated
- [ ] No regression in existing email flows (transactional whitelist preserved)
- [ ] docs/SYSTEM-MAP.md committed + readable
- [ ] Post-build audit doc committed w/ status tag

If all check, system is ready for paid ad fuel.

---

## Self-review (run before declaring plan complete)

### Spec coverage

Walk every requirement in `docs/superpowers/specs/2026-05-24-operational-transparency-control-design.md`:

- ✅ SYSTEM-MAP.md → Task 6
- ✅ Weekly Spam Audit cron + Telegram digest → Task 4
- ✅ 6 Telegram commands → Task 5
- ✅ Auto-spam guard (per-Consumer freq cap) → Task 2 + Task 3
- ✅ Email Sends Airtable table → Task 1
- ✅ Transactional whitelist → Task 2
- ✅ 14-19 hour effort estimate respected — 7 tasks @ ~2-3 hours each = 14-21
- ✅ Multiple verification passes after each build → Task 7 + per-task type-check + deploy verify
- ✅ Foresight per task → "What could go wrong" section in each
- ✅ 3-pass post-build audit → Task 7 functional / regression / customer-experience

### Placeholder scan

- No TBD, TODO, "implement later" remaining
- Every code block contains actual content
- All function names match across tasks (guardedSend, checkFrequencyCap, logEmailSend, TRANSACTIONAL_WHITELIST, EMAIL_SENDS)

### Type consistency

- `checkFrequencyCap(recipientEmail, templateName)` signature consistent across Task 2 (definition) + Task 3 (consumption)
- `logEmailSend({recipientEmail, recipientConsumerId, templateName, subject, status, suppressionReason})` consistent across Task 2 + Task 3
- `EMAIL_SENDS` const naming consistent across Task 1 (definition) + Tasks 2/4/5 (consumption)
- TABLES.CRON_PAUSES used for both cron-name pauses (existing) + template-name pauses (new) — naming reused intentionally per spec

---

# PHASE 2 — Telegram + Cron Effectiveness Hardening

> **Status:** Pending. Phase 1 (Tasks 1-7) shipped 2026-05-24. Phase 2 starts 2026-05-27. Reasons for Phase 2:
> 1. Phase 1 3-pass audit flagged a Medium issue (B5: silent-failure swallowing in 4 callers) — still unfixed.
> 2. Operator request: "make the telegram automations and cron sequences more effective and actually useful and assure they are reading writing properly and executing the right tasks."
> 3. Operating the platform exposed 3 reliability gaps:
>    - Cron failures land in `Cron Runs` w/ `Status=error` but no Telegram alert fires → operator discovers via `/cronstatus` or post-mortem.
>    - No proactive alarm if an expected cron didn't fire in its window (Vercel cron silently skipped, secret rotation, etc).
>    - `skipReasonBreakdown` populated in only 2 of ~8 gating crons → other gating crons report `recordsTouched=0` with no explanation.

**Goal:** Close the Phase 1 silent-failure gap, surface every cron failure proactively to Telegram, add a heartbeat watchdog, expose dry-run mode on the three highest-volume crons, and harden callback idempotency across the 128 callback-handling code paths.

**Architecture:** All work concentrates around two files — `lib/cronRun.ts` (alert injection) and `app/api/webhooks/telegram/route.ts` (new commands + idempotency audit). One new cron (`heartbeat-watch`) and one new helper (`telegramAlert` in `lib/telegram.ts` if not already present). No new tables; reuses Cron Runs + Email Sends. Schema unchanged from Phase 1.

**Tech Stack:** Same as Phase 1.

---

## Phase 2 file structure

### Files created

| File | Responsibility |
|---|---|
| `app/api/cron/heartbeat-watch/route.ts` | Hourly watchdog — alerts Telegram if expected cron didn't log a Cron Runs row in its window |
| `docs/audits/2026-05-27-cron-coverage-audit.md` | Snapshot of cron coverage as of Phase 2 start (all 24 ✓, baseline for future drift) |
| `docs/audits/2026-05-27-telegram-callback-audit.md` | Per-callback handler idempotency audit findings |
| `docs/audits/2026-05-27-phase2-post-build-audit.md` | Phase 2 3-pass audit (functional + regression + customer-experience) |

### Files modified

| File | Modification |
|---|---|
| `lib/cronRun.ts` | Inject Telegram alert when `status='error'` or `'partial'`; in-memory rate limit 1/cron/hour |
| `lib/cronRun.ts` | Optional `expectedWindowMinutes` per cron — consumed by heartbeat-watch |
| `app/api/webhooks/telegram/route.ts` | Add `/cronhealth` command; idempotency retrofit on unguarded callbacks |
| `app/api/cron/email-sequences/route.ts` | Add `?dryRun=1` query mode + populate skipReasonBreakdown |
| `app/api/cron/batch-approve/route.ts` | Add `?dryRun=1` query mode (skipReasonBreakdown already populated) |
| `app/api/cron/rancher-launch-warmup/route.ts` | Add `?dryRun=1` query mode + populate skipReasonBreakdown |
| `app/api/cron/referral-chasup/route.ts` | Populate skipReasonBreakdown |
| `app/api/cron/stuck-buyer-recovery/route.ts` | Populate skipReasonBreakdown |
| `app/api/cron/close-detector/route.ts` | Populate skipReasonBreakdown |
| `app/api/cron/onboarding-stuck/route.ts` | Populate skipReasonBreakdown + FIX B5 silent-fail caller (L147) |
| `app/api/admin/consumers/[id]/resend-warmup/route.ts` | FIX B5 silent-fail caller (L91) |
| `app/api/admin/ranchers/[id]/resend-setup/route.ts` | FIX B5 silent-fail caller (L92) |
| `app/api/matching/suggest/route.ts` | FIX B5 silent-fail caller (L740) |
| `vercel.json` | Add `heartbeat-watch` cron schedule (`0 * * * *`) |
| `docs/SYSTEM-MAP.md` | Refresh w/ Phase 2 additions |

---

## Phase 2 foresight — what could go wrong across the whole phase

| Risk | Likelihood | Mitigation in plan |
|---|---|---|
| heartbeat-watch alerts spam Telegram if expected windows misconfigured | High | Start with permissive windows (3× expected interval) → tighten only after observing one week of data |
| Adding Telegram alert in `withCronRun` finally block creates loop (alert send fails → fires another withCronRun → loop) | Medium | Alert via direct `fetch('https://api.telegram.org/...')` call, NOT via the existing `sendTelegramMessage` (which routes through the email/Resend stack indirectly via send-scheduled cron in some code paths). Cap with in-memory rate limit 1/cron/hour. |
| `?dryRun=1` query param bypassed if auth weak → attacker drains DB | Medium | dryRun mode runs AFTER auth check (CRON_SECRET). `?dryRun=1` without secret returns 401. Dry-run path never calls `createRecord` / `sendEmail` — reads only. Smoke test confirms. |
| skipReasonBreakdown JSON value too large for Airtable singleLineText | Low | Field is multilineText (existing). Cap object key set at 10 reason names per cron run. |
| B5 fix changes wrapper return shape → cascading typecheck failures | Medium | The fix is at the CALLER side, not the wrapper. Existing wrapper return shape `{success, suppressed?, reason?}` preserved. Callers add `r.suppressed` + `r.reason` to their existing `r.error` check. |
| Callback idempotency retrofit changes existing behavior | High | Each retrofit is `if (await dedupClaim(cbId)) { ... existing logic ... }`. Existing logic untouched. Dedup miss → no-op + ACK. Test against staging callback first. |
| `/cronhealth` query against 7 days of Cron Runs is slow (~1k rows) | Low | Filter `{Started At} > now-7d` at Airtable layer. Process aggregation in single pass. |
| Heartbeat-watch cron alerts on its OWN missing run (chicken-and-egg) | Low | Heartbeat-watch run-check skips its own name from the expected-cron list. Self-healing via Vercel's own cron alarm channel. |

---

## Task 8: Fix Phase 1 B5 silent-fail swallowing in 4 callers

**Files:**
- Modify: `app/api/admin/consumers/[id]/resend-warmup/route.ts:91`
- Modify: `app/api/admin/ranchers/[id]/resend-setup/route.ts:92`
- Modify: `app/api/cron/onboarding-stuck/route.ts:147`
- Modify: `app/api/matching/suggest/route.ts:740`

**What could go wrong:**
- A caller used `r.error` to surface Resend network errors → after fix it must still surface those. Resend errors still throw out of `guardedSend` (caught by the surrounding try/catch). The fix only adds suppression visibility — error path unchanged.
- The admin UI side may render `reason: 'cap-exceeded'` as a confusing user-facing string. Map to a friendlier phrase ("frequency cap — try again in 7 days").

- [ ] **Step 1: Update `app/api/admin/consumers/[id]/resend-warmup/route.ts:91`**

Find the call site. Currently looks like:

```typescript
const r = await sendRancherLaunchWarmup({ ... });
if (r && r.error) { /* error path */ }
```

Change to:

```typescript
const r = await sendRancherLaunchWarmup({ ... });
if (r && (r.suppressed || (r as any).error)) {
  // Surface suppression reason in admin UI response
  return NextResponse.json({
    ok: false,
    reason: r.reason || (r as any).error?.message || 'unknown',
    suppressed: !!r.suppressed,
  }, { status: 200 });
}
```

- [ ] **Step 2: Update `app/api/admin/ranchers/[id]/resend-setup/route.ts:92`**

Same pattern. Read the surrounding context first to keep return shape consistent with the existing endpoint contract.

- [ ] **Step 3: Update `app/api/cron/onboarding-stuck/route.ts:147`**

Cron context — surface via `skipReasonBreakdown` instead of HTTP response. Add a counter:

```typescript
const suppressedByReason: Record<string, number> = {};
// ... in loop:
const r = await sendRancherOnboardingDripDay2({ ... });
if (r && r.suppressed) {
  suppressedByReason[r.reason || 'unknown'] = (suppressedByReason[r.reason || 'unknown'] || 0) + 1;
}
// ... return from handler:
return {
  status: 'success',
  recordsTouched: nudged,
  notes: `nudged ${nudged}; suppressed ${Object.values(suppressedByReason).reduce((a, b) => a + b, 0)}`,
  skipReasonBreakdown: Object.keys(suppressedByReason).length ? suppressedByReason : undefined,
};
```

- [ ] **Step 4: Update `app/api/matching/suggest/route.ts:740`**

This is the intro-email send path. Currently:

```typescript
if (emailResult && emailResult.error) { introSendErr = emailResult.error; }
```

Change to:

```typescript
if (emailResult && ((emailResult as any).error || emailResult.suppressed)) {
  introSendErr = (emailResult as any).error || `suppressed: ${emailResult.reason}`;
}
```

Note: intro emails are in the TRANSACTIONAL_WHITELIST, so `suppressed` should only ever fire if the buyer is Unsubscribed/Bounced/Complained. Worth logging — that's a routing-engine bug if it happens.

- [ ] **Step 5: Type-check + boundary check**

```bash
cd "/Users/benji.bushes/BHC/untitled folder/bhc"
npx tsc --noEmit
npm run check:boundaries 2>/dev/null || true
```

Expected: no errors.

- [ ] **Step 6: Smoke against prod**

Trigger one of the admin UI paths manually:

```bash
# From admin UI: click "Resend warmup" against a Consumer who's already hit cap
# Expect: response { ok: false, reason: 'cap-exceeded', suppressed: true }
# Admin UI should render a friendly message
```

For the cron path (`onboarding-stuck`): trigger via curl + read the Cron Runs row written. Expect `skipReasonBreakdown` JSON populated if any suppression occurred.

- [ ] **Step 7: Commit + push + Vercel deploy verify**

```bash
git add app/api/admin/consumers/[id]/resend-warmup/route.ts \
        app/api/admin/ranchers/[id]/resend-setup/route.ts \
        app/api/cron/onboarding-stuck/route.ts \
        app/api/matching/suggest/route.ts
git commit -m "fix(email): surface suppressed sends in 4 callers (Phase 1 B5)

Phase 2 Task 8. The Phase 1 3-pass audit (docs/audits/2026-05-24-post-build-audit.md
Pass B5) flagged that 4 callers checked .error on the wrapped send-helper
return shape — a field that NEVER exists on guardedSend's {success, suppressed?,
reason?} shape. Effect: when frequency-cap suppression OR pause OR
Unsubscribed/Bounced/Complained kicked in, the caller saw 'success' silently.

Now: every caller checks both .error (legacy/synthetic) AND .suppressed.
Admin UI returns ok:false + reason for suppressed sends. Cron writes
skipReasonBreakdown for visibility in /whatfired + spam-audit.

Files:
- app/api/admin/consumers/[id]/resend-warmup/route.ts
- app/api/admin/ranchers/[id]/resend-setup/route.ts
- app/api/cron/onboarding-stuck/route.ts
- app/api/matching/suggest/route.ts"
git push origin main
```

Wait for Vercel READY. Re-fire `/whatfired today` after next cron tick — confirm skipReasonBreakdown surfaces in notes.

---

## Task 9: Populate skipReasonBreakdown on remaining gating crons

**Files:**
- Modify: `app/api/cron/referral-chasup/route.ts`
- Modify: `app/api/cron/email-sequences/route.ts`
- Modify: `app/api/cron/rancher-launch-warmup/route.ts`
- Modify: `app/api/cron/stuck-buyer-recovery/route.ts`
- Modify: `app/api/cron/close-detector/route.ts`

**What could go wrong:**
- Some crons have multiple skip points (e.g. email-sequences has segment gating + per-buyer cadence gating). Need ONE breakdown bucket per logical reason, not per code path. Risk: too granular = noise.
- Inline counter object grows large mid-loop → memory concern at ~1500 buyers. Mitigation: keep it `Record<string, number>` (cheap).
- Returning a typed skipReasonBreakdown changes the realHandler signature → typecheck breaks other crons that return only `{status, recordsTouched, notes}`. Mitigation: type is already optional in `CronRunResult` (verified in `lib/cronRun.ts:16`).

- [ ] **Step 1: Pattern reference — copy from batch-approve**

Open `app/api/cron/batch-approve/route.ts`. Read L33 (signature) + L486 (return). That's the pattern to replicate.

- [ ] **Step 2: Retrofit `referral-chasup`**

Find skip points (where the cron iterates referrals + chooses to skip one). Common reasons in this cron: `recentlyActive`, `terminal-status`, `maintenance-blocked`, `no-rancher-email`, `bounced-or-unsub`. Add:

```typescript
const skipReasons: Record<string, number> = {};
// In each skip branch, instead of `continue`:
// skipReasons['recentlyActive'] = (skipReasons['recentlyActive'] || 0) + 1; continue;
// ... at handler return:
return {
  status: 'success',
  recordsTouched: chased,
  notes: `chased ${chased}; skipped ${Object.values(skipReasons).reduce((a, b) => a + b, 0)}`,
  skipReasonBreakdown: Object.keys(skipReasons).length ? skipReasons : undefined,
};
```

- [ ] **Step 3: Retrofit `email-sequences`**

Same pattern. Reasons: `segment-mismatch`, `cadence-not-due`, `cap-suppressed`, `unsubscribed`, `closed-or-terminal`, `paused-template`.

- [ ] **Step 4: Retrofit `rancher-launch-warmup`**

Reasons: `rancher-not-operational`, `out-of-state`, `already-warmed`, `dedupe-recent-warmup`, `bounced-unsub`.

- [ ] **Step 5: Retrofit `stuck-buyer-recovery`**

Reasons: `not-stuck-yet`, `already-recovered`, `unsubscribed`, `paused`.

- [ ] **Step 6: Retrofit `close-detector`**

Reasons: `no-stripe-event`, `referral-not-open`, `terminal-status`, `dedupe`.

- [ ] **Step 7: Type-check + boundary check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Smoke against prod — trigger one cron + verify Cron Runs row**

```bash
curl -X POST "https://www.buyhalfcow.com/api/cron/referral-chasup" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Wait 30s. Open Airtable Cron Runs table. Find newest row w/ `Name=referral-chasup`. Verify `Skip Reason Breakdown` column is populated w/ JSON like `{"recentlyActive": 12, "terminal-status": 3}`.

Repeat for the other 4 crons.

- [ ] **Step 9: Commit + push + Vercel deploy verify**

```bash
git add app/api/cron/referral-chasup/route.ts \
        app/api/cron/email-sequences/route.ts \
        app/api/cron/rancher-launch-warmup/route.ts \
        app/api/cron/stuck-buyer-recovery/route.ts \
        app/api/cron/close-detector/route.ts
git commit -m "feat(crons): populate skipReasonBreakdown on 5 gating crons

Phase 2 Task 9. Previously only batch-approve + testimonial-collection
surfaced WHY records were skipped. Other gating crons reported
recordsTouched=0 with no breakdown, hiding queue stalls.

Now every gating cron writes a JSON map of {reason: count} to the
Cron Runs row's Skip Reason Breakdown field. Surfaces in /whatfired
+ spam-audit + the new /cronhealth command (Task 12)."
git push origin main
```

After deploy READY, wait for next natural cron tick (or trigger manually). Open Cron Runs + verify breakdown populated.

---

## Task 10: Inject Telegram alert on cron error/partial inside withCronRun

**Files:**
- Modify: `lib/cronRun.ts`

**What could go wrong:**
- Telegram API call in finally block fails → swallows the original error message. Mitigation: try/catch the alert; don't override existing notes.
- Alert spam if a cron retries 5x in an hour. Mitigation: in-memory Map rate-limit 1/cron/hour.
- Direct fetch to `api.telegram.org` requires `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ADMIN_CHAT_ID` env vars. Both already set per Phase 1 audit. Defensive: skip alert if either missing.

- [ ] **Step 1: Add alert helper to lib/cronRun.ts**

Open `lib/cronRun.ts`. Above the `withCronRun` function, add:

```typescript
/**
 * In-memory rate limit for cron error alerts. Map<cronName, lastAlertMs>.
 * Reset on cold start (Vercel serverless) — acceptable, just means a cold
 * Lambda may double-alert vs a warm one. Bound is "no more than 1 alert
 * per cron per hour per warm instance."
 */
const _alertLast: Map<string, number> = new Map();
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

async function maybeAlertTelegram(cron: string, status: CronStatus, notes: string): Promise<void> {
  if (status !== 'error' && status !== 'partial') return;
  const last = _alertLast.get(cron) || 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return;
  _alertLast.set(cron, Date.now());

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chat) return;

  const emoji = status === 'error' ? '🚨' : '🟡';
  const text = `${emoji} <b>CRON ${status.toUpperCase()}</b> · <code>${cron}</code>\n\n${notes.slice(0, 500)}`;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
    });
  } catch (e: any) {
    console.warn(`[withCronRun:${cron}] alert send failed:`, e?.message);
  }
}
```

- [ ] **Step 2: Wire it into the withCronRun finally block**

In `lib/cronRun.ts` inside `withCronRun`, in the `finally` block — AFTER the `createRecord(TABLES.CRON_RUNS, row)` call — add:

```typescript
// Surface failures proactively. Best-effort; non-fatal if alert send fails.
await maybeAlertTelegram(name, status, notes);
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Smoke — force a failing cron**

Pick a low-stakes cron (e.g. `healthcheck` is good — it logs status). Temporarily modify its realHandler locally to throw, push to a feature branch, deploy. Verify Telegram alert fires.

Easier alt: trigger a non-existent cron path or use a known-broken endpoint:

```bash
# Pick a cron that will surface 'partial' on the next natural run, or simulate via
# manually constructing the alert (one-time smoke):
curl -X POST "https://www.buyhalfcow.com/api/cron/email-sequences?simulate=error" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Inspect Vercel logs — if `maybeAlertTelegram` ran, the warn message will appear (or absence of warn = success).

Confirm Telegram chat received `🚨 CRON ERROR · ...` message.

- [ ] **Step 5: Verify cooldown — fire same cron twice within 1h**

Run the same trigger twice. Expect: only first alert sent. Second silently skipped.

- [ ] **Step 6: Commit + push + Vercel deploy verify**

```bash
git add lib/cronRun.ts
git commit -m "feat(cron): Telegram alert on cron error or partial status

Phase 2 Task 10. Previously: cron failure → row written to Cron Runs
w/ Status=error → operator finds out via /cronstatus or post-mortem.
Now: every error/partial fires a Telegram alert via direct fetch to
api.telegram.org/bot{token}/sendMessage. 1/cron/hour in-memory rate
limit prevents spam during retries.

Direct fetch (not sendTelegramMessage) chosen to avoid recursion
through the send-scheduled cron path. Best-effort; alert failure
logged but doesn't override the cron's own status."
git push origin main
```

---

## Task 11: Cron heartbeat watcher

**Files:**
- Create: `app/api/cron/heartbeat-watch/route.ts`
- Modify: `vercel.json`

**What could go wrong:**
- Schedule miscalculation — a cron that runs `0 9 * * *` should NOT alert at 9:01 even if the most recent row is 23h old. Mitigation: compute window as `next_expected - now < threshold` not `last_run > now - threshold`.
- Heartbeat itself never running → no alert about its own failure. Acceptable: covered by Vercel's own infra alarm (the deploy notification + uptime ping).
- Cron list drift — manually maintained `EXPECTED_CRONS` map. Adding a new cron requires updating this map. Mitigation: comment block + document in SYSTEM-MAP.

- [ ] **Step 1: Build the heartbeat-watch route**

Create `app/api/cron/heartbeat-watch/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { withCronRun } from '@/lib/cronRun';

export const runtime = 'nodejs';
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET || '';

/**
 * Expected cron schedules. Used to compute "is this cron overdue?"
 * Schedule is the cron syntax we set in vercel.json; maxAgeMinutes is
 * a permissive threshold — alert ONLY if the most-recent Cron Runs row
 * for this cron is older than maxAgeMinutes. Default policy: 3× the
 * expected interval so a single skipped run doesn't alert.
 *
 * Keep in sync w/ vercel.json crons array. Adding a new cron there
 * requires adding an entry here OR accepting that no heartbeat will
 * watch it (acceptable for low-stakes crons).
 */
const EXPECTED_CRONS: Record<string, { intervalHours: number; maxAgeMinutes: number }> = {
  'batch-approve':           { intervalHours: 24, maxAgeMinutes: 4320 }, // 72h grace
  'email-sequences':         { intervalHours: 24, maxAgeMinutes: 4320 },
  'referral-chasup':         { intervalHours: 24, maxAgeMinutes: 4320 },
  'rancher-launch-warmup':   { intervalHours: 24, maxAgeMinutes: 4320 },
  'commission-invoices':     { intervalHours: 24, maxAgeMinutes: 4320 },
  'compliance-reminders':    { intervalHours: 24, maxAgeMinutes: 4320 },
  'daily-digest':            { intervalHours: 24, maxAgeMinutes: 4320 },
  'rancher-followup':        { intervalHours: 24, maxAgeMinutes: 4320 },
  'healthcheck':             { intervalHours: 24, maxAgeMinutes: 4320 },
  'nightly-rancher-audit':   { intervalHours: 24, maxAgeMinutes: 4320 },
  'rancher-onboarding-drip': { intervalHours: 24, maxAgeMinutes: 4320 },
  'rancher-trust-promotion': { intervalHours: 24, maxAgeMinutes: 4320 },
  'stuck-buyer-recovery':    { intervalHours: 24, maxAgeMinutes: 4320 },
  'onboarding-stuck':        { intervalHours: 24, maxAgeMinutes: 4320 },
  'close-detector':          { intervalHours: 24, maxAgeMinutes: 4320 },
  'daily-audit':             { intervalHours: 24, maxAgeMinutes: 4320 },
  'buyer-pulse':             { intervalHours: 24, maxAgeMinutes: 4320 },
  'send-scheduled':          { intervalHours: 1, maxAgeMinutes: 180 }, // hourly w/ 3h grace
};

async function realHandler(_request: Request): Promise<{
  status: 'success' | 'partial';
  recordsTouched: number;
  notes: string;
}> {
  const sinceISO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentRuns = (await getAllRecords(
    TABLES.CRON_RUNS,
    `{Started At} > "${sinceISO}"`,
  )) as any[];

  // Last successful run per cron name
  const lastRunByName: Record<string, number> = {};
  for (const row of recentRuns) {
    const name = String(row['Name'] || '');
    const status = String(row['Status'] || '');
    if (status !== 'success' && status !== 'partial' && status !== 'paused') continue;
    const tsMs = new Date(row['Started At']).getTime();
    if (!lastRunByName[name] || tsMs > lastRunByName[name]) {
      lastRunByName[name] = tsMs;
    }
  }

  // Identify overdue crons
  const overdue: { name: string; ageMin: number; max: number }[] = [];
  for (const [name, cfg] of Object.entries(EXPECTED_CRONS)) {
    if (name === 'heartbeat-watch') continue; // skip self
    const last = lastRunByName[name];
    const ageMin = last ? Math.floor((Date.now() - last) / 60_000) : 99999;
    if (ageMin > cfg.maxAgeMinutes) {
      overdue.push({ name, ageMin, max: cfg.maxAgeMinutes });
    }
  }

  // Fire alert if any
  if (overdue.length > 0) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (token && chat) {
      const lines = overdue.map(o => `<code>${o.name}</code> · ${o.ageMin}m old (max ${o.max}m)`);
      const text = `⏰ <b>HEARTBEAT</b> · ${overdue.length} cron(s) overdue\n\n${lines.join('\n')}`;
      try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
        });
      } catch (e: any) {
        console.warn('[heartbeat-watch] alert send failed:', e?.message);
      }
    }
  }

  return {
    status: overdue.length > 0 ? 'partial' : 'success',
    recordsTouched: recentRuns.length,
    notes: `expected=${Object.keys(EXPECTED_CRONS).length} overdue=${overdue.length} recentRuns=${recentRuns.length}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  if (CRON_SECRET) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      const { searchParams } = new URL(request.url);
      if (searchParams.get('secret') !== CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('heartbeat-watch', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
```

- [ ] **Step 2: Add cron schedule to vercel.json**

In the `crons` array, append:

```json
{ "path": "/api/cron/heartbeat-watch", "schedule": "0 * * * *" }
```

(Hourly.)

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Smoke against prod**

After deploy, manually trigger:

```bash
curl -X POST "https://www.buyhalfcow.com/api/cron/heartbeat-watch" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Expected: HTTP 200. If any cron is genuinely overdue at run time, Telegram receives `⏰ HEARTBEAT` message. If none overdue, no Telegram.

Inspect Cron Runs table: new row w/ `Name=heartbeat-watch`, Status=success or partial.

- [ ] **Step 5: Commit + push + Vercel deploy verify**

```bash
git add app/api/cron/heartbeat-watch/route.ts vercel.json
git commit -m "feat(cron): hourly heartbeat watcher alerts Telegram on overdue crons

Phase 2 Task 11. New cron /api/cron/heartbeat-watch fires every hour,
reads Cron Runs for past 7 days, computes last-successful-run per
expected cron name, alerts Telegram if any cron is overdue beyond
its configured maxAgeMinutes (default 3× expected interval).

Closes the 'Vercel cron silently skipped a run' visibility gap.
Operator now finds out within 1 hour if a daily cron is overdue,
within 3 hours if hourly cron stopped firing.

EXPECTED_CRONS map maintained manually — keep in sync w/ vercel.json.
Adding a new cron there requires adding a heartbeat entry. Document
in SYSTEM-MAP.md."
git push origin main
```

---

## Task 12: `/cronhealth` Telegram command

**Files:**
- Modify: `app/api/webhooks/telegram/route.ts`

**What could go wrong:**
- Telegram message length cap (~4096 chars). 24 crons × 60 chars each = 1440 chars. OK, plenty of headroom.
- Heavy Airtable read on every command invocation (7 days of Cron Runs ≈ 168 rows for hourly + ~150 for daily ≈ 320 rows). Acceptable — no caching needed.
- Conflict with existing `/cronstatus` command. `/cronhealth` is the deeper view — keeps `/cronstatus` as a simple list. Distinct purpose.

- [ ] **Step 1: Add command to telegram route**

Open `app/api/webhooks/telegram/route.ts`. Find the existing `/cronstatus` handler (~L4789). Below it, add:

```typescript
// /cronhealth — per-cron health summary: last run, status, duration trend, error rate
else if (text === '/cronhealth' || text === '/cronhealth ' ) {
  try {
    const sinceISO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const runs = (await getAllRecords(
      TABLES.CRON_RUNS,
      `{Started At} > "${sinceISO}"`,
    )) as any[];

    // Group by Name
    const byName: Record<string, { runs: any[]; success: number; error: number; partial: number; paused: number; durations: number[] }> = {};
    for (const r of runs) {
      const n = String(r['Name'] || '?');
      byName[n] = byName[n] || { runs: [], success: 0, error: 0, partial: 0, paused: 0, durations: [] };
      byName[n].runs.push(r);
      const s = String(r['Status'] || '');
      if (s === 'success') byName[n].success++;
      else if (s === 'error') byName[n].error++;
      else if (s === 'partial') byName[n].partial++;
      else if (s === 'paused') byName[n].paused++;
      const d = Number(r['Duration ms'] || 0);
      if (d > 0) byName[n].durations.push(d);
    }

    const rows = Object.entries(byName)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, v]) => {
        const total = v.runs.length;
        const last = v.runs.sort((a, b) => new Date(b['Started At']).getTime() - new Date(a['Started At']).getTime())[0];
        const lastTs = last ? new Date(last['Started At']).toISOString().slice(5, 16).replace('T', ' ') : '—';
        const lastStatus = last ? String(last['Status'] || '') : '—';
        const tag = lastStatus === 'success' ? '✅' : lastStatus === 'partial' ? '🟡' : lastStatus === 'paused' ? '⏸️' : lastStatus === 'error' ? '🚨' : '?';
        const avgDur = v.durations.length > 0 ? Math.round(v.durations.reduce((a, b) => a + b, 0) / v.durations.length) : 0;
        const errRate = total > 0 ? Math.round((v.error / total) * 100) : 0;
        return `${tag} <code>${name.padEnd(28)}</code> ${lastTs} · ${total} runs · ${errRate}% err · ${avgDur}ms`;
      });

    await sendTelegramMessage(
      chatId,
      `🩺 <b>CRON HEALTH</b> · last 7d\n\n` +
      `<pre>${rows.join('\n')}</pre>\n\n` +
      `Use <code>/whatfired YYYY-MM-DD</code> for per-day details.`
    );
  } catch (e: any) {
    await sendTelegramMessage(chatId, `⚠️ /cronhealth failed: ${e?.message || 'unknown'}`);
  }
}
```

- [ ] **Step 2: Add to `/help` text**

Find the `/help` command output. Below `/cronstatus`, add:

```
/cronhealth — Per-cron health summary (last run, status, duration, error rate)
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Smoke**

After deploy, send `/cronhealth` in Telegram. Expect a table of 24 crons w/ last-run timestamp, status emoji, run count, error rate, avg duration.

- [ ] **Step 5: Commit + push + Vercel deploy verify**

```bash
git add app/api/webhooks/telegram/route.ts
git commit -m "feat(telegram): /cronhealth — per-cron health summary

Phase 2 Task 12. Reads past 7d of Cron Runs, groups by Name, computes:
- last run timestamp + status emoji
- total runs in period
- error rate %
- avg duration ms

Returns sorted table. Complements /cronstatus (simple list) and
/whatfired (per-day detail) — /cronhealth is the per-cron trend view."
git push origin main
```

---

## Task 13: `?dryRun=1` mode on 3 high-volume crons

**Files:**
- Modify: `app/api/cron/email-sequences/route.ts`
- Modify: `app/api/cron/batch-approve/route.ts`
- Modify: `app/api/cron/rancher-launch-warmup/route.ts`

**What could go wrong:**
- Dry-run path forgets to skip a write somewhere → real records mutated. Mitigation: gate EVERY `createRecord`, `updateRecord`, `sendEmail`, `sendTelegramMessage` call inside `if (!dryRun) { ... }`.
- Operator forgets `dryRun=1` and accidentally fires real cron → no harm done (it's just the cron, runs every day anyway). Mitigation: dry-run returns `notes: 'DRY RUN — ${count} would have processed'` so it's obvious.
- Dry-run still writes a Cron Runs row → could be confused with real runs. Mitigation: include `dryRun=1` in the Notes field; `/whatfired` shows it.

- [ ] **Step 1: Pattern — dry-run flag plumb-through**

In each target cron, modify the realHandler signature to accept dryRun:

```typescript
async function realHandler(request: Request): Promise<{ status: 'success' | 'partial'; recordsTouched: number; notes: string; skipReasonBreakdown?: Record<string, number> }> {
  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';

  // ... existing logic but every write gated:
  if (!dryRun) {
    await createRecord(TABLES.REFERRALS, { ... });
  }
  if (!dryRun) {
    await sendNudgeToEngage({ ... });
  }
  // ...
  return {
    status: 'success',
    recordsTouched: count,
    notes: `${dryRun ? 'DRY RUN — ' : ''}processed ${count}`,
  };
}
```

- [ ] **Step 2: Apply to `email-sequences`**

Open `app/api/cron/email-sequences/route.ts`. Find every write (createRecord / updateRecord / sendXxx). Wrap each in `if (!dryRun)`. Add the `dryRun` parse at top of handler. Add `'DRY RUN — '` prefix to notes when dryRun.

- [ ] **Step 3: Apply to `batch-approve`**

Same pattern. Note: batch-approve already has a `dryRun: false` flag in some inner function calls (Phase 1 audit revealed). Reuse / standardize that flag.

- [ ] **Step 4: Apply to `rancher-launch-warmup`**

Same pattern.

- [ ] **Step 5: Type-check + boundary check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Smoke against prod — dry-run each**

```bash
curl -X POST "https://www.buyhalfcow.com/api/cron/email-sequences?dryRun=1" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Expected: HTTP 200. Open Cron Runs in Airtable, latest `Name=email-sequences` row should have Notes starting with `DRY RUN —`. NO new emails should appear in Email Sends table for the past minute (verify by filtering Email Sends `Sent At > now-2min` returns 0 rows).

Repeat for batch-approve + rancher-launch-warmup.

- [ ] **Step 7: Commit + push + Vercel deploy verify**

```bash
git add app/api/cron/email-sequences/route.ts \
        app/api/cron/batch-approve/route.ts \
        app/api/cron/rancher-launch-warmup/route.ts
git commit -m "feat(crons): ?dryRun=1 mode on 3 high-volume crons

Phase 2 Task 13. Operator can now preview what a cron WOULD do
without actually sending email or mutating records:

  curl -X POST .../api/cron/email-sequences?dryRun=1 -H 'Auth..'

Useful for:
- Pre-deploy verification (does the new gating logic ship right?)
- Investigating queue stalls (are buyers being skipped for the
  expected reason?)
- Validating cap changes (would tightening cap to 3 break anything?)

Every write (createRecord, updateRecord, sendEmail) gated behind
if (!dryRun) check. Cron Runs row still written w/ Notes prefix
'DRY RUN — ' so it's clearly distinguished in /whatfired."
git push origin main
```

---

## Task 14: Telegram callback idempotency audit + retrofit

**Files:**
- Create: `docs/audits/2026-05-27-telegram-callback-audit.md`
- Modify: `app/api/webhooks/telegram/route.ts` (idempotency retrofit on unguarded handlers)

**What could go wrong:**
- Adding idempotency check WRONG → blocks legitimate retries (e.g. operator double-taps an approve button → second tap silently no-ops, which is the desired behavior).
- Storing dedupe state in Airtable is slow per callback. Mitigation: use Upstash Redis (already wired per H-5 work) or in-memory Map w/ TTL.
- Audit finds 30+ callbacks needing retrofit → too much for one task. Mitigation: scope to high-risk callbacks only (mutation paths). Read-only callbacks don't need idempotency.

- [ ] **Step 1: Enumerate every callback handler**

```bash
cd "/Users/benji.bushes/BHC/untitled folder/bhc"
grep -n "callback_query.data\|callbackData\|cb\.data === '\|cbData.startsWith('" app/api/webhooks/telegram/route.ts | head -80
```

Capture every distinct callback action name. Group by:
- READ (information-fetch only — no idempotency needed)
- WRITE single-record (high-risk if double-fired — needs idempotency)
- WRITE multi-record (highest risk — must be idempotent)

- [ ] **Step 2: Write audit doc**

Create `docs/audits/2026-05-27-telegram-callback-audit.md`:

```markdown
# Telegram Callback Idempotency Audit — 2026-05-27

## Coverage

| Callback action | Mutation? | Has idempotency guard? | Risk |
|---|---|---|---|
| approve_<refId> | yes (Referral → Intro Sent) | ✅ via Cron Runs lookup | low |
| reject_<refId>  | yes (Referral → Lost) | ✅ via Cron Runs lookup | low |
| ... fill in all callbacks ...
```

For each row marked "no" w/ Risk medium or high → Task 14 retrofit target.

- [ ] **Step 3: Retrofit each unguarded mutation callback**

Pattern (using Upstash Redis already in the codebase per H-5):

```typescript
import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();

async function callbackDedup(cbId: string): Promise<boolean> {
  // Returns true if first time, false if duplicate
  const key = `tg:cb:${cbId}`;
  const result = await redis.set(key, '1', { nx: true, ex: 600 }); // 10 min dedup window
  return result === 'OK';
}

// In handler:
const cbId = update.callback_query?.id;
if (cbId) {
  const isFirst = await callbackDedup(cbId);
  if (!isFirst) {
    await answerCallbackQuery(cbId, 'Already processed');
    return NextResponse.json({ ok: true });
  }
}
// ... existing handler logic ...
```

Apply to each WRITE callback identified in Step 2.

- [ ] **Step 4: Type-check + boundary check**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Smoke against prod**

Trigger a callback twice in rapid succession (e.g. tap an "Approve" button twice within 5 seconds). Expect: first tap processes, second tap returns "Already processed" via callback alert.

- [ ] **Step 6: Commit + push + Vercel deploy verify**

```bash
git add app/api/webhooks/telegram/route.ts docs/audits/2026-05-27-telegram-callback-audit.md
git commit -m "feat(telegram): idempotency guards on N mutation callbacks

Phase 2 Task 14. Audit (docs/audits/2026-05-27-telegram-callback-audit.md)
identified N callback handlers performing mutations without
idempotency. Vercel can retry on transient errors; operator double-taps
buttons. Both paths previously created duplicate Airtable records.

Now: every mutation callback claims its callback_query.id via
Upstash Redis SET NX EX 600 (10 min window). Duplicate fires return
'Already processed' acknowledgment without re-running the mutation.

Patterns documented in callback-audit.md for future callback authors."
git push origin main
```

---

## Task 15: Refresh `docs/SYSTEM-MAP.md`

**Files:**
- Modify: `docs/SYSTEM-MAP.md`

**What could go wrong:**
- Out-of-date map = worse than no map. Operator trusts wrong info.
- Manual sync across 500+ line doc is tedious. Mitigation: focus on Phase 2 deltas only — diff what changed since 2026-05-24.

- [ ] **Step 1: Diff against Phase 2 additions**

Open `docs/SYSTEM-MAP.md`. Add or update sections:

- **Crons:** Add `heartbeat-watch` (new) + `spam-audit` if missing
- **Telegram commands:** Add `/cronhealth` (new)
- **Email templates:** No changes (Phase 2 didn't add new templates)
- **Airtable tables:** No new tables (Phase 2 reuses Cron Runs + Email Sends)
- **Routing logic:** Add a section "Failure surfaces" describing Telegram alerts, heartbeat-watch behavior
- **Known issues + deprecated surfaces:** Add note about EXPECTED_CRONS map manual-sync requirement

- [ ] **Step 2: Verify**

Scan the updated map. Every new artifact from Phase 2 should appear with: name, purpose, source file path, revenue tier, status.

- [ ] **Step 3: Commit + push**

```bash
git add docs/SYSTEM-MAP.md
git commit -m "docs(map): refresh SYSTEM-MAP w/ Phase 2 additions

Phase 2 Task 15. Adds heartbeat-watch cron, /cronhealth Telegram
command, failure-surface routing notes. No new tables or email
templates. Drift caveat documented under Known Issues — EXPECTED_CRONS
map in heartbeat-watch must be kept in sync w/ vercel.json crons array."
git push origin main
```

---

## Task 16: Phase 2 3-pass post-build audit

**Files:**
- Create: `docs/audits/2026-05-27-phase2-post-build-audit.md`

**What could go wrong:**
- The Phase 1 audit found B5 (silent fail) only because the auditor read every caller. Phase 2 audit must read every NEW caller too — don't trust typecheck alone.
- Heartbeat-watch + Telegram alert + dryRun mode are all new + interdependent. A regression in one may show only when another fires. Test in sequence.

### Pass A — Functional verification

- [ ] **A1: Every new artifact responds**

```bash
curl -X POST "https://www.buyhalfcow.com/api/cron/heartbeat-watch" \
  -H "Authorization: Bearer $CRON_SECRET"
# Expect: 200 + Cron Runs row w/ Name=heartbeat-watch

# Telegram:
/cronhealth                       → table of 24 crons
/cronstatus                       → still works
/whatfired today                  → includes heartbeat-watch row
```

- [ ] **A2: Skip Reason Breakdown populated**

Trigger each gating cron once via curl. Open Cron Runs in Airtable. Filter newest 5 rows. Verify `Skip Reason Breakdown` column populated as JSON for at least one row per gating cron.

- [ ] **A3: Telegram error alert fires**

Push a known-broken cron (or simulate) → verify `🚨 CRON ERROR · ...` Telegram message arrives.

- [ ] **A4: Heartbeat alert fires**

Temporarily set one cron's maxAgeMinutes to 1 in EXPECTED_CRONS → trigger heartbeat-watch → verify `⏰ HEARTBEAT` message arrives. REVERT after smoke.

- [ ] **A5: dryRun works for all 3 crons**

```bash
curl -X POST ".../api/cron/email-sequences?dryRun=1" -H "Auth..."
curl -X POST ".../api/cron/batch-approve?dryRun=1" -H "Auth..."
curl -X POST ".../api/cron/rancher-launch-warmup?dryRun=1" -H "Auth..."
```

Verify: Cron Runs row w/ Notes prefix `DRY RUN —`. NO new rows in Email Sends within the past 2 minutes.

- [ ] **A6: B5 silent-fail callers now surface suppression**

Force a suppression scenario (e.g. operator hits "Resend onboarding" against a Consumer at cap). Verify admin UI response includes `reason: 'cap-exceeded'` and `suppressed: true`.

### Pass B — Regression check on existing flows

- [ ] **B1: All Phase 1 commands still work**

```
/emaillog karie.suarez@gmail.com   → still returns log
/pausemail sendXxx                  → still pauses
/resumemail sendXxx                 → still resumes
/freqcap                            → still shows cap
/templatestats                      → still shows ranked list
/whatfired today                    → still works + now shows skip breakdown notes
```

- [ ] **B2: All existing crons fire green**

```
/cronstatus
/cronhealth
```

Expect: no new error/partial since Phase 2 deploy. If any → investigate before declaring ship-ready.

- [ ] **B3: Existing email flow unaffected**

Trigger one warmup or one match. Verify Email Sends has rows w/ Status=sent. Transactional whitelist still bypasses cap.

- [ ] **B4: No new lint or boundary violations**

```bash
npx tsc --noEmit
# Plus any project linter
```

### Pass C — Customer-experience pass

- [ ] **C1: No buyer accidentally over-emailed during Phase 2 work**

Run `/templatestats`. Compare top 5 templates' send counts vs Phase 1 baseline (recorded in Phase 1 audit). Spike of >50% = investigate before paid ads.

- [ ] **C2: No rancher accidentally spammed by heartbeat-watch or error alerts**

Verify the new alerts (heartbeat + cron error) only land in OPERATOR Telegram chat (TELEGRAM_ADMIN_CHAT_ID). NO rancher email or Telegram thread receives them.

- [ ] **C3: dryRun didn't accidentally mutate prod**

Audit Email Sends + Referrals + Consumers Airtable tables filtered to `Modified > 1h ago` and Referrals/Consumers w/ unusual fields. Cross-check against the cron runs from Step A5. NO records should have been mutated by dryRun calls.

- [ ] **C4: Callback double-fire scenario**

Tap an Approve callback button twice within 10s. Verify: ONE Referral row created with `Status=Intro Sent`. Second tap acknowledged but no duplicate.

### Audit deliverable

- [ ] **Step Final: Write findings to `docs/audits/2026-05-27-phase2-post-build-audit.md`**

Format same as Phase 1 audit:

```markdown
# Phase 2 Post-Build Audit — 2026-05-27

Implementation: Telegram + Cron Effectiveness Hardening
Commits audited: <SHA range>
Spec: docs/superpowers/specs/2026-05-24-operational-transparency-control-design.md (Phase 2 append)

## Pass A — Functional
- [pass/fail] A1: heartbeat-watch + /cronhealth + /cronstatus + /whatfired work
- [pass/fail] A2: skipReasonBreakdown populated on 5 gating crons
- [pass/fail] A3: Telegram error alert fires
- [pass/fail] A4: Heartbeat alert fires
- [pass/fail] A5: dryRun works on 3 crons
- [pass/fail] A6: B5 callers surface suppression

## Pass B — Regression
- [pass/fail] B1: All Phase 1 Telegram commands still work
- [pass/fail] B2: /cronstatus + /cronhealth clean (no new error/partial)
- [pass/fail] B3: Email flows unaffected
- [pass/fail] B4: typecheck + boundary check clean

## Pass C — Customer Experience
- [pass/fail] C1: no buyer over-emailed (vs Phase 1 baseline)
- [pass/fail] C2: alerts only in operator chat
- [pass/fail] C3: dryRun no prod mutation
- [pass/fail] C4: callback double-fire blocked

## Issues found
- (list each w/ severity + proposed fix OR follow-up task)

## Ship status
✅ READY FOR PAID ADS · BULLETPROOF | 🟡 SHIPPING WITH FOLLOW-UPS | 🚨 ROLLBACK NEEDED
```

Commit + push:

```bash
git add docs/audits/2026-05-27-phase2-post-build-audit.md
git commit -m "docs(audit): Phase 2 post-build 3-pass verification

Phase 2 Task 16. Functional / regression / customer-experience
results captured. Tag at top indicates ship status."
git push origin main
```

---

## Phase 2 final verification — "operationally bulletproof" gate

After Task 16 audit complete:

- [ ] All 9 Phase 2 tasks committed + deployed to prod
- [ ] `/cronstatus` shows heartbeat-watch in the list
- [ ] `/cronhealth` returns sorted table of 24 crons w/ error rate column
- [ ] Cron Runs writes include `Skip Reason Breakdown` for 7+ crons (Phase 1: 2; Phase 2 added 5+)
- [ ] One real `🚨 CRON` error alert successfully received during smoke (or known-faked)
- [ ] One `⏰ HEARTBEAT` alert successfully received during smoke
- [ ] `?dryRun=1` smoke confirmed no prod mutation on email-sequences / batch-approve / rancher-launch-warmup
- [ ] No callback double-fire detected during stress test (rapid double-tap)
- [ ] B5 silent-fail callers surface suppression in both admin UI and cron logs
- [ ] Phase 2 audit doc committed w/ status tag
- [ ] SYSTEM-MAP.md updated w/ all Phase 2 deltas

If all check: operator can run paid ads w/o the "what's actually firing" or "did that cron actually run" anxiety.

---

## Phase 2 self-review (run before declaring Phase 2 complete)

### Spec coverage

Phase 2 doesn't extend the original spec — it closes operational gaps revealed during Phase 1 operation. Verify Phase 2 tasks map to user's "make telegram automations and cron sequences more effective" ask:

- ✅ Failure surfaces (Telegram alert on error/partial) → Task 10
- ✅ Proactive heartbeat (cron-didn't-fire alarm) → Task 11
- ✅ Visibility into why records are skipped (skipReasonBreakdown) → Task 9
- ✅ Pre-fire preview (dryRun) → Task 13
- ✅ Aggregated cron health view (/cronhealth) → Task 12
- ✅ Idempotent callback handling → Task 14
- ✅ Doc refresh → Task 15
- ✅ Phase 1 B5 closure → Task 8
- ✅ 3-pass post-build audit → Task 16

### Placeholder scan

- No TBD, TODO, "implement later" remaining
- Every code block contains actual content
- File paths and line numbers reference real files in the repo as of 2026-05-27

### Type consistency

- `dryRun` boolean naming consistent across all 3 cron retrofits
- `maybeAlertTelegram(cron, status, notes)` signature defined once in `lib/cronRun.ts`, consumed in same file's finally block
- `callbackDedup(cbId)` signature consistent across all callback retrofits in Task 14
- `EXPECTED_CRONS` map in heartbeat-watch is the single source of truth for "what crons exist + what their windows are"
- `skipReasonBreakdown?: Record<string, number>` shape consistent across all gating crons
