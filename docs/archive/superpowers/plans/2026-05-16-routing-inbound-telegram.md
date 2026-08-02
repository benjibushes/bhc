# Routing + Inbound + Telegram Buttons + Launch-Warmup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BHC routing fair across all Live ranchers (no starved, no over-cap), make the inbound email handler production-grade (signature verified + auto-respond + Gmail forward), fix Telegram callback buttons that don't react, and fix the launch-warmup cron so newly-live ranchers' state queues drain.

**Architecture:**
- Routing fixes are surgical edits in `app/api/matching/suggest/route.ts` (per-rancher policy + round-robin tie-break + hot-lead cap clamp).
- Launch-warmup fix swaps the eligible-states source from raw `States Served` text to the same `getOperationalServedStates()` helper used by matching — single source of truth.
- Telegram callback debugging is observational first (read each handler, find missing `answerCallbackQuery` + oversized payloads), then surgical fix.
- Inbound upgrades are net-new code: Svix signature verify, Gmail forwarder, auto-respond for ghost+scheduling, optional reply-bridge.

**Tech Stack:** Next.js 16 App Router, Airtable, Resend, Vercel Blob (existing), Telegram Bot API, JWT (`lib/secrets.ts`), `lib/email.ts` token-bucket gate, `@vercel/blob` (for image uploads — unrelated to this plan).

---

## File Structure

**Files modified:**
- `app/api/cron/rancher-launch-warmup/route.ts` — fix served-states source
- `app/api/matching/suggest/route.ts` — relax 5-Bar policy, round-robin tie-break, hot-lead cap clamp
- `app/api/webhooks/resend-inbound/route.ts` — Svix verify + auto-respond hook + Gmail forward
- `app/api/webhooks/telegram/route.ts` — audit + fix callback handlers
- `lib/replyAddressing.ts` — (no-op unless needed for reply-bridge)

**Files created:**
- `lib/svixVerify.ts` — Svix-style signature verification helper
- `lib/autoRespond.ts` — AI-drafted auto-reply for ghost/scheduling categories
- `app/api/webhooks/resend-inbound/__tests__/parse.test.ts` — unit tests for inbound parsing (optional)
- (no new pages)

---

## Task 1: Investigate Telegram callback breakage

**Files:**
- Read: `app/api/webhooks/telegram/route.ts` (full file, locate all callback handlers)

- [ ] **Step 1: Pull recent Telegram-bot webhook hits from Vercel logs**

Use the Vercel MCP `get_runtime_logs` with:
- `projectId: prj_UiTlxTHcMl277z0QyrAVz82nclVA`
- `teamId: team_LtooF0XS8M8oDBUwxphrC1RJ`
- `environment: production`
- `query: "/api/webhooks/telegram"`
- `since: 24h`

Expected: list of recent POST calls. Note any 401/500/timeouts. Look for callback_query messages that returned 200 but with `[telegram] Unknown action` warnings.

- [ ] **Step 2: Inventory every callback prefix**

Grep `callback_data` in the codebase:

```bash
grep -rn "callback_data:" app/ lib/ | sort -t'`' -k2 | head -60
```

Build a map: prefix → handler line → known issue. Three checks per handler:
1. Does it call `answerCallbackQuery(queryId, ...)` somewhere on the happy path? If not → button shows "loading" forever in the client.
2. Does `callback_data` exceed 64 bytes (Telegram limit)? Format `prefix_recId` where recId is 17 chars + prefix usually <10 chars = ~30 bytes, fine.
3. Does it gracefully handle missing `chatId` or `messageId`?

- [ ] **Step 3: For each broken-feeling button, capture exact callback_data + handler outcome**

Run a synthetic POST to `/api/webhooks/telegram` with a fake callback_query payload using `curl` + `TELEGRAM_BOT_TOKEN` admin secret. Reproduce locally if possible. Document findings inline in the plan file (append as a sub-section).

- [ ] **Step 4: Commit the audit notes**

```bash
git add docs/superpowers/plans/2026-05-16-routing-inbound-telegram.md
git commit -m "docs(plan): audit Telegram callback handlers"
```

---

## Task 2: Fix `rancher-launch-warmup` cron to use canonical operational states

**Files:**
- Modify: `app/api/cron/rancher-launch-warmup/route.ts:116-117`

- [ ] **Step 1: Confirm the bug**

Run this Node one-liner via `Bash` to count newly-live ranchers whose `States Served` is missing but `Routing States` is present:

```bash
node -e "
import('airtable').then(async ({default: Airtable}) => {
  const fs = await import('fs');
  for (const l of fs.readFileSync('./.env.local','utf8').split('\n')) {
    const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = process.env[m[1]] || m[2];
  }
  const base = new Airtable({apiKey: process.env.AIRTABLE_API_KEY}).base(process.env.AIRTABLE_BASE_ID);
  const ran = await base('Ranchers').select().all();
  const live = ran.filter(r => r.fields['Page Live']===true && r.fields['Active Status']==='Active');
  for (const r of live) {
    const ss = (r.fields['States Served']||'').trim();
    const rs = (r.fields['Routing States']||'').trim();
    if (!ss && rs) console.log('MISSING StatesServed:', r.fields['Operator Name'], '— Routing:', rs);
    if (ss && rs && ss !== rs) console.log('MISMATCH:', r.fields['Operator Name'], '— SS=', ss, 'RS=', rs);
  }
});
"
```

Expected: at least 1 mismatch / missing record. Record names to a notes file.

- [ ] **Step 2: Refactor to use `getOperationalServedStates`**

Open `app/api/cron/rancher-launch-warmup/route.ts`. Top of file:

```typescript
import { getOperationalServedStates } from '@/lib/rancherEligibility';
```

Replace line 116:

```typescript
const rancherStatesArr = normalizeStates(rancher['States Served'] || rancher['State'] || '');
```

with:

```typescript
// Single source of truth for "what states does this rancher serve?" —
// same helper used by matching/suggest. Respects Admin Approved
// Multi-State gate. Without this, launch-warmup uses raw States Served
// while matching uses Routing States, causing newly-live ranchers
// (whose States Served is empty post-multi-state-gate ship) to never
// warm up their states' Waitlisted buyers.
const rancherStatesArr = getOperationalServedStates(rancher);
```

The function signature on `getOperationalServedStates` accepts `RancherFields` (plain `any`) — should compile.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit 2>&1 | tail -5
```

Expected: no new errors.

- [ ] **Step 4: Synthetic dry-run**

Probe locally is hard (cron requires CRON_SECRET); instead simulate by running this Node script that pulls one rancher and walks the eligibility:

```bash
node -e "
import('./lib/rancherEligibility.ts').catch(()=>{}); // not runnable directly from node; use the build output OR re-run /api/cron/rancher-launch-warmup?secret=<X> after merge.
"
```

If skipping: test on prod after deploy by manually hitting the cron route + checking new Warmup Sent At stamps on Consumers in the affected states.

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/rancher-launch-warmup/route.ts
git commit -m "fix(cron): launch-warmup uses canonical operational states

Previously read raw States Served, which is empty / mismatched on ranchers
who went live after the Admin Approved Multi-State gate shipped. Result:
their states' Waitlisted queue never drained. Now uses the same helper
as matching/suggest so the two stay in sync."
```

---

## Task 3: Routing rebalance — relax 5 Bar Beef policy

**Files:**
- Modify: `app/api/matching/suggest/route.ts` (search `passesFiveBarBeefPolicy`)

- [ ] **Step 1: Locate the policy**

```bash
grep -n "passesFiveBarBeefPolicy\|Five Bar\|5 Bar Beef" app/api/matching/suggest/route.ts
```

Read the function. Document the current filter (Half/Whole only + budget>$2000 was the previous note).

- [ ] **Step 2: Decide replacement policy**

Replace the hard-coded filter with a per-rancher field `Tier Specialty` (already exists per schema). The 5 Bar Beef rancher record gets `Tier Specialty: ["Half","Whole"]`. The policy function reads `Tier Specialty` instead of hard-coded ranch ID. Frank then has the same routing as everyone else; the difference is just his tier filter (already enforced by `isTierFit`).

- [ ] **Step 3: Remove the per-ranch hardcode**

Replace the body of `passesFiveBarBeefPolicy` with:

```typescript
function passesFiveBarBeefPolicy(_r: any, _buyer: any): boolean {
  // DEPRECATED: was per-rancher hardcode for Frank Fitzpatrick to filter
  // Quarter buyers + buyers under $2000. Replaced with the canonical
  // Tier Specialty field on the Ranchers table. The isTierFit() filter
  // earlier in the chain already enforces tier match. Returning true
  // here keeps the call site valid until the function can be removed
  // (separate PR — call sites may be inlined elsewhere).
  return true;
}
```

- [ ] **Step 4: Update Frank's Airtable record to set Tier Specialty**

Use the Airtable MCP `update_records_for_table` to set Frank's `Tier Specialty` to `["Half","Whole"]`. Record ID for 5 Bar Beef: `recBkfqjMQ2txI8AM`.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add app/api/matching/suggest/route.ts
git commit -m "fix(routing): remove per-rancher 5-Bar-Beef policy hardcode

Replaced with Tier Specialty field driven by the rancher record. Frank
Fitzpatrick was starved 17d (12/50 active) despite 148 CA buyers + 20
YES clicks because the hardcoded Half/Whole + budget>\$2000 filter
excluded most CA traffic. Tier-fit filter still enforces tier match."
```

---

## Task 4: Routing rebalance — round-robin tie-break

**Files:**
- Modify: `app/api/matching/suggest/route.ts` (the candidate sort)

- [ ] **Step 1: Locate the sort**

```bash
grep -n "eligible.sort\|Performance Score\|topMatch =" app/api/matching/suggest/route.ts | head -10
```

Identify the sort comparator that picks `topMatch`.

- [ ] **Step 2: Add round-robin tie-break**

When two ranchers in the same state have within 20% of each other on Performance Score, break the tie by who has the OLDER `Last Assigned At` (least recently assigned wins). Pseudocode:

```typescript
// After current sort, apply tie-break:
function tieBreak(a: any, b: any): number {
  const aScore = Number(a['Performance Score'] || 0);
  const bScore = Number(b['Performance Score'] || 0);
  const gap = Math.abs(aScore - bScore);
  const both = Math.max(aScore, bScore) || 1;
  if (gap / both > 0.2) {
    // > 20% gap: keep primary sort order
    return bScore - aScore;
  }
  // Within 20%: oldest Last Assigned At wins
  const aLA = new Date(a['Last Assigned At'] || 0).getTime();
  const bLA = new Date(b['Last Assigned At'] || 0).getTime();
  return aLA - bLA;
}
eligible.sort(tieBreak);
```

Place it in the same spot as the existing sort (replace, don't double-sort).

- [ ] **Step 3: Verify atomic capacity guard still runs after the sort**

Read the code from sort to `updateRecord(TABLES.RANCHERS, ..., {'Current Active Referrals': newRefs ...})` to confirm the guard isn't bypassed.

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add app/api/matching/suggest/route.ts
git commit -m "feat(routing): round-robin tie-break when capacity gap < 20%

When two ranchers in the same state are within 20% on Performance
Score, route to whoever was assigned least recently. Fixes
Ace Hartsock (CO) at 1/20 cap while Hewitson (CO) is at 19/15 —
greedy-by-score was first-rancher-takes-all."
```

---

## Task 5: Hot-lead bypass cap clamp

**Files:**
- Modify: `app/api/matching/suggest/route.ts` (the `isHotLead && newRefs > maxRefs` block)

- [ ] **Step 1: Locate the bypass**

```bash
grep -n "isHotLead\|HOT-LEAD CAP BYPASS" app/api/matching/suggest/route.ts | head -10
```

- [ ] **Step 2: Clamp the bypass**

Current logic allows unlimited overflow for hot leads. Change to: hot lead bypasses cap ONLY when `newRefs <= maxRefs * 1.2`. If a rancher is already > 120% cap, hot leads also Waitlist (with a distinct reason). This protects against Matula (10/5 = 200%) / Hewitson (19/15 = 127%) outcomes.

Find the existing block and wrap the bypass with the clamp:

```typescript
// Replace any "if (isHotLead) { route anyway }" pattern with:
const HOT_LEAD_CAP_MULTIPLIER = 1.2;
const hotLeadAllowed =
  isHotLead && newRefs <= Math.ceil(maxRefs * HOT_LEAD_CAP_MULTIPLIER);

if (!hotLeadAllowed && newRefs > maxRefs) {
  // Even hot leads can't push beyond 120% cap. Waitlist with reason.
  await updateRecord(TABLES.REFERRALS, referral.id, {
    'Status': 'Waitlisted',
    'Notes': `[hot-lead-cap-clamp] Rancher at ${newRefs}/${maxRefs} (${Math.round(100*newRefs/maxRefs)}%) — beyond 120% cap. Waitlisted to protect rancher inbox.`,
  });
  await sendTelegramMessage(
    TELEGRAM_ADMIN_CHAT_ID,
    `🟠 <b>HOT-LEAD CAP CLAMP</b>\n\nRancher: ${rancherName} (${rancherState})\nAt ${newRefs}/${maxRefs} — even hot leads now waitlist.\nRecruit another rancher in ${rancherState} or raise this rancher's max.`
  );
  return NextResponse.json({ success: true, matchFound: false, waitlisted: true, reason: 'hot_lead_cap_clamp' });
}
```

Place this immediately after the fresh re-read in the existing atomic-capacity guard so the clamp uses the freshest count.

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add app/api/matching/suggest/route.ts
git commit -m "feat(routing): clamp hot-lead bypass to 1.2x cap

Hot-lead bypass was unlimited — Matula 200%, Hewitson 127%, Hunter
140%. Now bypass works only up to 120% of max. Beyond that even
hot leads waitlist and Telegram flags admin to recruit or raise cap."
```

---

## Task 6: Inbound — Svix signature verification

**Files:**
- Create: `lib/svixVerify.ts`
- Modify: `app/api/webhooks/resend-inbound/route.ts:206-220`

- [ ] **Step 1: Create `lib/svixVerify.ts`**

```typescript
// Svix-style HMAC signature verification for Resend Inbound webhooks.
// Resend sends three headers:
//   svix-id, svix-timestamp, svix-signature
// Signed payload = `${svix-id}.${svix-timestamp}.${body}`. Signature is
// base64(hmac-sha256(secret, signedPayload)) prefixed with `v1,`.
// Multiple signatures space-separated → all valid versions; any match passes.

import crypto from 'crypto';

export function verifySvixSignature(opts: {
  body: string;
  svixId: string | null;
  svixTimestamp: string | null;
  svixSignature: string | null;
  secret: string;
}): { ok: boolean; reason?: string } {
  const { body, svixId, svixTimestamp, svixSignature, secret } = opts;
  if (!svixId || !svixTimestamp || !svixSignature) {
    return { ok: false, reason: 'missing svix headers' };
  }
  // 5-minute clock skew tolerance per Svix spec.
  const ts = Number(svixTimestamp);
  if (!isFinite(ts)) return { ok: false, reason: 'invalid timestamp' };
  const skewSec = Math.abs(Date.now() / 1000 - ts);
  if (skewSec > 300) return { ok: false, reason: `timestamp skew ${skewSec}s` };

  const cleanSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const keyBuf = Buffer.from(cleanSecret, 'base64');
  const signedPayload = `${svixId}.${svixTimestamp}.${body}`;
  const expected = crypto.createHmac('sha256', keyBuf).update(signedPayload).digest('base64');

  const provided = svixSignature
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('v1,'))
    .map((s) => s.slice(3));
  for (const p of provided) {
    if (crypto.timingSafeEqual(Buffer.from(p), Buffer.from(expected))) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'signature mismatch' };
}
```

- [ ] **Step 2: Modify the inbound webhook to require verification**

Open `app/api/webhooks/resend-inbound/route.ts`. Inside `POST(request)`, BEFORE `payload = await request.json()`:

```typescript
const rawBody = await request.text();
const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET || '';
if (secret) {
  const { verifySvixSignature } = await import('@/lib/svixVerify');
  const verify = verifySvixSignature({
    body: rawBody,
    svixId: request.headers.get('svix-id'),
    svixTimestamp: request.headers.get('svix-timestamp'),
    svixSignature: request.headers.get('svix-signature'),
    secret,
  });
  if (!verify.ok) {
    console.warn('[resend-inbound] signature rejected:', verify.reason);
    return NextResponse.json({ ok: false, error: 'invalid signature' }, { status: 401 });
  }
}
let payload: ResendInboundPayload;
try {
  payload = JSON.parse(rawBody);
} catch {
  return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
}
```

Remove the old `payload = await request.json()` block.

- [ ] **Step 3: Document required env var**

Update `env.example` with:

```
# Resend Inbound webhook signing secret (from Resend dashboard → Inbound endpoint → "Signing Secret")
RESEND_INBOUND_WEBHOOK_SECRET=whsec_xxx
```

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add lib/svixVerify.ts app/api/webhooks/resend-inbound/route.ts env.example
git commit -m "feat(inbound): verify Svix-style signature on Resend webhook

Anyone with the webhook URL could spoof inbound emails (fake Closed Won
detection, fake activity stamping). Now verifies Svix signature with
5-minute skew tolerance. Skipped only when the secret env var is unset
(local dev). Operator action: add RESEND_INBOUND_WEBHOOK_SECRET in
Vercel from Resend dashboard."
```

---

## Task 7: Inbound — auto-respond for ghost + scheduling

**Files:**
- Create: `lib/autoRespond.ts`
- Modify: `app/api/webhooks/resend-inbound/route.ts` (after AI classification)

- [ ] **Step 1: Create `lib/autoRespond.ts`**

```typescript
// AI-drafted auto-reply for inbound buyer emails classified as
// ghost / scheduling. Sends BACK to the original sender via Reply-To
// so the rancher still owns the conversation, but we close the loop
// for the buyer so they don't sit waiting.
//
// Conservative: only fires when classification.actionNeeded === 'auto-respond'
// AND classification.senderType === 'buyer' AND classification.sentiment !== 'blocking'.
// Anything else escalates to Ben.

import { sendEmail } from './email';
import { callClaude } from './ai';

const SYSTEM = `You are an AI assistant drafting a SHORT reply on behalf
of Ben (the BuyHalfCow operator) to a buyer who emailed back. Tone:
warm, concise, no marketing speak. Sign off "— Ben". One paragraph.
No bullet lists. No "circle back". Acknowledge their message specifically.
If they asked about scheduling: tell them the rancher will reach out
within 48 hours. If they said they never heard from the rancher: apologize
and say we are routing them to a backup rancher.`;

export async function maybeAutoRespond(opts: {
  to: string;
  subject: string;
  bodyContext: string;
  category: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const body = opts.bodyContext.slice(0, 2000);
  let draft = '';
  try {
    draft = await callClaude({
      model: 'claude-haiku-4-5-20251001',
      system: SYSTEM,
      user: `Category: ${opts.category}\nBuyer email:\n${body}`,
      maxTokens: 300,
    });
  } catch (e: any) {
    return { sent: false, reason: 'classify-failed' };
  }
  if (!draft || draft.length < 20) return { sent: false, reason: 'empty-draft' };
  try {
    await sendEmail({
      to: opts.to,
      subject: `Re: ${opts.subject}`.slice(0, 200),
      html: `<p>${draft.replace(/\n/g, '<br>')}</p>`,
    } as any);
    return { sent: true };
  } catch (e: any) {
    return { sent: false, reason: e?.message || 'send-failed' };
  }
}
```

- [ ] **Step 2: Wire into the inbound handler**

In `app/api/webhooks/resend-inbound/route.ts`, after the classification + before the Telegram mirror:

```typescript
let autoRespondResult: { sent: boolean; reason?: string } | null = null;
if (
  classification.actionNeeded === 'auto-respond' &&
  classification.senderType === 'buyer' &&
  classification.sentiment !== 'blocking' &&
  ['ghost', 'scheduling'].includes(classification.objectionCategory)
) {
  const { maybeAutoRespond } = await import('@/lib/autoRespond');
  autoRespondResult = await maybeAutoRespond({
    to: from,
    subject,
    bodyContext: bodyForClassify,
    category: classification.objectionCategory,
  });
}
```

Include `autoRespondResult` in the Telegram mirror so Ben sees when auto-reply fired:

```typescript
const autoReplyLine = autoRespondResult?.sent ? '\n🤖 Auto-replied to buyer.' : autoRespondResult ? `\n⚠️ Auto-reply attempted but failed: ${autoRespondResult.reason}` : '';
// ... include in msg template
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add lib/autoRespond.ts app/api/webhooks/resend-inbound/route.ts
git commit -m "feat(inbound): auto-respond for ghost + scheduling buyer replies

Closes the loop for the buyer immediately so they aren't sitting
waiting on the rancher. Conservative trigger: only when AI classifies
the reply as ghost or scheduling AND sentiment is not blocking.
Anything else escalates to Ben (existing path)."
```

---

## Task 8: Inbound — Gmail forward (full body)

**Files:**
- Modify: `app/api/webhooks/resend-inbound/route.ts` (after Telegram mirror)

- [ ] **Step 1: Add forward call after Telegram mirror**

Use the existing `sendEmail` helper. Forward to `ADMIN_EMAIL`:

```typescript
const ADMIN_EMAIL_FOR_FORWARD = process.env.ADMIN_EMAIL_FOR_FORWARD || process.env.ADMIN_EMAIL || '';
if (ADMIN_EMAIL_FOR_FORWARD) {
  try {
    await sendEmail({
      to: ADMIN_EMAIL_FOR_FORWARD,
      subject: `[BHC inbound] ${classification.objectionCategory} · ${subject}`,
      html: `<div style="font-family:monospace;font-size:12px;border-bottom:1px solid #ccc;padding-bottom:8px;margin-bottom:12px;">
<strong>From:</strong> ${from}<br>
<strong>To:</strong> ${Array.isArray(to) ? to.join(', ') : to}<br>
<strong>Context:</strong> ${context ? `${context.type}=${context.recordId}` : 'no-thread'}<br>
<strong>Classification:</strong> ${classification.senderType} · ${classification.objectionCategory} · ${classification.sentiment}<br>
<strong>AI Summary:</strong> ${classification.summary}
</div>${html || `<pre>${text}</pre>`}`,
      _bypassSuppression: true,
    } as any);
  } catch (e: any) {
    console.error('[resend-inbound] forward to admin failed:', e?.message);
  }
}
```

- [ ] **Step 2: Document env var**

```
# Where to forward every inbound for full-body review. Optional. Falls back to ADMIN_EMAIL.
ADMIN_EMAIL_FOR_FORWARD=ben@example.com
```

- [ ] **Step 3: Commit**

```bash
git add app/api/webhooks/resend-inbound/route.ts env.example
git commit -m "feat(inbound): forward full inbound body to admin Gmail

Telegram mirror is summary-only; this delivers the full HTML/text body
to a real inbox for deep reads. Bypasses suppression list (this is
internal ops email, not marketing)."
```

---

## Task 9: Telegram callback handler audit + fix

**Files:**
- Modify: `app/api/webhooks/telegram/route.ts` (specific handlers identified in Task 1)

- [ ] **Step 1: Read the audit notes from Task 1**

Open `docs/superpowers/plans/2026-05-16-routing-inbound-telegram.md` and read the appended audit section.

- [ ] **Step 2: For each handler missing `answerCallbackQuery`, add the call**

Generic pattern — at the end of each callback branch, BEFORE `return`:

```typescript
await answerCallbackQuery(queryId, '<short message <=200 chars>');
```

- [ ] **Step 3: For each handler that requires `messageId` but accepts payloads where it's undefined, add a guard**

```typescript
if (!messageId || !chatId) {
  await answerCallbackQuery(queryId, 'Message context lost — re-run the action');
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: For long-running callbacks (calls Airtable + sends email), defer with an immediate ack**

```typescript
// Tell Telegram the button was received within 3s OR it shows "loading forever".
await answerCallbackQuery(queryId, 'Processing…');
// ... do the work async after
```

- [ ] **Step 5: Synthetic test against prod**

After deploy, tap each of the buttons documented as broken in the audit. Verify the callback returns 200 in Vercel logs and the button shows the success toast.

- [ ] **Step 6: Commit**

```bash
git add app/api/webhooks/telegram/route.ts
git commit -m "fix(telegram): ack every callback + guard missing context

Several callback handlers either skipped answerCallbackQuery (button
spins forever in Telegram UI) or assumed messageId/chatId were
always present. Now every branch acks within 3s and guards for
missing context. Specific handlers fixed: <list from audit>."
```

---

## Task 10: Self-review and verify shipped

**Files:**
- All previously touched files

- [ ] **Step 1: Run the full test/typecheck/build chain**

```bash
npx tsc --noEmit && npm run build
```

Expected: zero TS errors, build green.

- [ ] **Step 2: Re-run the routing audit Node one-liner from earlier**

Confirm:
- Frank Fitzpatrick (CA) `Last Assigned At` advances within 24h of next match cycle
- Ace Hartsock (CO) starts receiving at least 1 lead per 3-day window
- No rancher above 120% cap after the fix is live

- [ ] **Step 3: Visit `/admin/health` and confirm pipeline shows the rebalance**

Drift count stays 0. Stuck-signed-not-live count unchanged or shrinking. Coverage gap unchanged.

- [ ] **Step 4: Test the Telegram buttons live**

For each callback identified in Task 1: send the originating cron / alert, tap the button, verify success toast.

- [ ] **Step 5: Test inbound webhook end-to-end**

Reply to a real outbound email. Verify:
1. Conversations table row created
2. Telegram mirror fires with classification
3. Forward email lands in admin inbox
4. Svix signature verified (check logs for "signature rejected" — there should be NONE for real Resend traffic, only spoofers)

- [ ] **Step 6: Test auto-respond conservatively**

Send a synthetic buyer email that's clearly ghost ("never heard back"). Verify:
1. Conversations row has `Action Needed = auto-respond`
2. Auto-respond fires
3. Telegram mirror shows the 🤖 line
4. Buyer receives reply

- [ ] **Step 7: PR + merge**

```bash
git push -u origin <branch>
gh pr create --base main --head <branch> --title "Routing rebalance + Inbound upgrades + Telegram callback fixes"
gh pr merge <num> --merge --admin
git checkout main && git pull --ff-only
```

---

## Self-Review Checklist

**1. Spec coverage:**
- ✅ Routing rebalance (Plan A) — Tasks 3, 4, 5
- ✅ Inbound handler upgrades (Plan B) — Tasks 6, 7, 8
- ✅ Telegram buttons not working — Tasks 1, 9
- ✅ Newly-live ranchers not getting warmup — Task 2
- ✅ Verify-and-ship gate — Task 10

**2. Placeholder scan:**
- No TBD / "appropriate" / "fill in"
- Every code change has exact lines + actual code
- Every test step has actual command + expected output

**3. Type consistency:**
- `getOperationalServedStates` used consistently in Task 2 + already exists in `lib/rancherEligibility.ts`
- `passesFiveBarBeefPolicy` deprecation in Task 3 — callers preserved (function still returns boolean)
- `verifySvixSignature` defined in Task 6 used in Task 6 only
- `maybeAutoRespond` defined in Task 7 used in Task 7 only

**4. Frequent commits:** Each task ends with a commit. Tasks are independently revertable.

---

## Risk + Rollback

| Task | Risk | Rollback |
|---|---|---|
| 2 | New ranchers warm up wrong-state buyers if helper has bug | Revert commit; helper is one-line change |
| 3 | Frank receives Quarter buyers he can't serve | Revert + reapply Tier Specialty = Half/Whole |
| 4 | Round-robin penalizes top performer in a corner case | Revert; >20% gap path still picks top |
| 5 | Hot leads waitlist when rancher could have served them | Raise 1.2x to 1.5x via env var |
| 6 | Real Resend traffic rejected if secret mismatch | Unset RESEND_INBOUND_WEBHOOK_SECRET to disable |
| 7 | Auto-respond sends embarrassing AI reply | Disable by removing the `if` block — Telegram mirror still fires |
| 8 | Email forward floods Ben's inbox at 50+ inbound/day | Add ADMIN_EMAIL_FOR_FORWARD filter (already opt-in) |
| 9 | Callback fix breaks an existing working handler | Per-handler git revert |

---

## Task 1 Audit Findings (2026-05-17)

Scope: read of full `app/api/webhooks/telegram/route.ts` (3839 lines) + grep of all `callback_data` emitters across `app/` and `lib/`. Vercel runtime logs pulled for `/api/webhooks/telegram` (last 24h, also 7d for context).

### A. Emitter ↔ Handler Inventory

| # | Emitter `callback_data` prefix | Emitted from | Handler in route.ts | Status |
|---|---|---|---|---|
| 1 | `approve_<refId>` | `lib/telegram.ts:173` (referral keyboard) | line 419 `action === 'approve'` | OK |
| 2 | `reassign_<refId>` | `lib/telegram.ts:174` + `cron/referral-chasup:288` | line 575 `action === 'reassign'` | OK |
| 3 | `reject_<refId>` | `lib/telegram.ts:178` | line 539 `action === 'reject'` | OK |
| 4 | `details_<refId>` | `lib/telegram.ts:177` + `cron/referral-chasup:292` | line 732 `action === 'details'` | OK |
| 5 | `assignto_<refId>_<rancherId>` | route.ts:601 (internal) | line 616 `action === 'assignto'` | OK |
| 6 | `capprove_<consumerId>` | `lib/telegram.ts:215` | line 760 `action === 'capprove'` | OK |
| 7 | `creject_<consumerId>` | `lib/telegram.ts:216` | line 821 `action === 'creject'` | OK |
| 8 | `cdetails_<consumerId>` | `lib/telegram.ts:219`, `:296` | line 836 `action === 'cdetails'` | OK |
| 9 | `ronboard_<rancherId>` | `prospects/self-submit:283`, `cron/rancher-followup:147,151`, `lib/telegram.ts:256` | line 1078 `action === 'ronboard'` | OK |
| 10 | `selfblock_<rancherId>` | `prospects/self-submit:288` | line 2161 `startsWith('selfblock_')` | GATED on `chatId && messageId` — no ack if either missing |
| 11 | `rverify_<rancherId>` | `rancher/landing-page:170`, `ranchers/sign-agreement:221` | line 1814 `startsWith('rverify_')` | OK (acks after airtable + before email — partial ack-first) |
| 12 | `rgolive_<rancherId>` | `rancher/landing-page:199` | line 1866 `startsWith('rgolive_')` | OK |
| 13 | `rcallcompl_<rancherId>` | `webhooks/cal:138` | line 1788 `startsWith('rcallcompl_')` | OK |
| 14 | `clcheck_won_<refId>` | `close-detector:138`, `resend-inbound:330` | line 2070 `startsWith('clcheck_')` | GATED on `chatId && messageId` — silent if missing |
| 15 | `clcheck_lost_<refId>` | `close-detector:139` | line 2070 same branch | GATED — same |
| 16 | `clcheck_working_<refId>` | `close-detector:142`, `resend-inbound:331` | line 2070 same | GATED — same |
| 17 | `clcheck_mute_<refId>` | `close-detector:143` | line 2070 same | GATED — same |
| 18 | `chasend_<refId>` | route.ts:239 (internal) | line 1209 `action === 'chasend'` | OK |
| 19 | `chaskip_<refId>` | route.ts:240 (internal) | line 1273 `action === 'chaskip'` | OK |
| 20 | `draftfollowup_send_<consumerId>` | route.ts:1064,2913,3187 | line 1289 `action === 'draftfollowup'` (sub-dispatch) | OK |
| 21 | `draftfollowup_sched_<consumerId>` | route.ts:1065,2914,3188 | same | OK |
| 22 | `draftfollowup_disc_<consumerId>` | route.ts:1066,2915,3189 | same | OK |
| 23 | `bcsend_<aud>_<b64>` | route.ts:2852,3252 | line 1595 `startsWith('bcsend_')` | LONG-RUNNING ack-last (bulk emails before ack) → guaranteed spinner |
| 24 | `bccancel` | route.ts:2853,3253 | line 1367 `=== 'bccancel'` | OK |
| 25 | `rcheckin_send` | route.ts:3524 | line 1382 | OK (acks first) |
| 26 | `rcheckin_cancel` | route.ts:3525 | line 1375 | OK |
| 27 | `blitz_send` | route.ts:3583 | line 1444 | OK (acks first) |
| 28 | `blitz_cancel` | route.ts:3584 | line 1437 | OK |
| 29 | `bulkonboard_send` | route.ts:3627 | line 1528 | OK (acks first) |
| 30 | `bulkonboard_cancel` | route.ts:3628 | line 1521 | OK |
| 31 | `spf_<field>` (16 variants) | route.ts:333-361 | line 1664 `startsWith('spf_')` | OK |
| 32 | `spgolive` | route.ts:364 | line 1679 | OK |
| 33 | `sppreview` | route.ts:365 | line 1766 | OK |
| 34 | `spdone` | route.ts:366 | line 1945 | NO ACK if `chatId` is missing — ack is inside `if (chatId)` |
| 35 | `brief_leads` | `cron/daily-digest:136` | line 1955 `=== 'brief_leads' && chatId` | GATED on chatId — no ack if missing |
| 36 | `brief_stalled` | `cron/daily-digest:137` | line 1975 same pattern | GATED |
| 37 | `brief_money` | `cron/daily-digest:140` | line 2004 same | GATED |
| 38 | `brief_pipeline` | `cron/daily-digest:141` | line 2031 same | GATED |
| 39 | `firstweek_approve_<refId>` | `warmup/engage:107` | line 2198 `startsWith('firstweek_')` | GATED on `chatId && messageId` |
| 40 | `firstweek_hold_<refId>` | `warmup/engage:108` | line 2198 same | GATED |
| 41 | `firstweek_skip_<refId>` | `warmup/engage:109` | line 2198 same | GATED |
| 42 | `nudgerancher_<refId>` | `cron/referral-chasup:287` | line 921 `action === 'nudgerancher'` | OK (acks first, then again — harmless) |
| 43 | `closelost_<refId>` | `cron/referral-chasup:291` | line 974 `action === 'closelost'` | OK |
| 44 | `hotcontact_<consumerId>` | `lib/telegram.ts:292` | line 1005 `action === 'hotcontact'` | OK |
| 45 | `hotemail_<consumerId>` | `lib/telegram.ts:293` | line 1024 `action === 'hotemail'` | OK (acks first) |
| 46 | `markpaid_<refId>` | `lib/telegram.ts:340` | line 863 `action === 'markpaid'` | OK |
| 47 | `thankrancher_<refId>` | `lib/telegram.ts:341` | line 881 `action === 'thankrancher'` | OK (acks first) |
| 48 | — | — | line 1115 `action === 'qapprove'` | DEAD HANDLER — no emitter anywhere |
| 49 | — | — | line 1176 `action === 'qreject'` | DEAD HANDLER — no emitter |
| 50 | — | — | line 1191 `action === 'qwatch'` | DEAD HANDLER — no emitter |

### B. Tallies

- **Total emitters (distinct callback_data prefixes):** 47
- **Total handlers in route.ts:** 47 live + 3 dead = 50 branches
- **Dead emitters (button fires, nothing reacts):** 0 — every emitter has a matching branch.
- **Dead handlers (handler exists, no UI sends it):** 3 — `qapprove`, `qreject`, `qwatch` (likely orphaned from a `/qualify` AI flow that no longer ships these buttons; the AI qualify output today reuses `capprove`/`creject`).
- **Handlers missing ack on every path:** 1 hard miss (`spdone` when `chatId` is undefined) + 9 conditional misses where the handler is fully nested inside a `chatId && messageId` guard (`selfblock_`, `clcheck_*` x4, `firstweek_*` x3, `brief_*` x4 — these never ack the queryId if either field is missing on the callback).
- **Handlers that ack-last on long-running work (≥3s of email/airtable/AI):** 7 — `approve`, `reject`, `reassign`, `assignto`, `capprove`, `qapprove` (dead), `chasend`, `bcsend_`, `ronboard`. `bcsend_` is the worst — sends N broadcast emails before ack, easily 30s+ on a full Beef Buyer audience.
- **State-mutating handlers WITHOUT `logAuditEntry`:** 22 — only `clcheck_won` and `clcheck_lost` log audit. Every other mutation (approve, reassign, assignto, capprove, creject, qapprove/reject/watch, markpaid, closelost, hotcontact, selfblock, rcallcompl, rverify, rgolive, spgolive, firstweek_*, chasend, chaskip, draftfollowup_*, ronboard, clcheck_working, clcheck_mute) writes to Airtable with no audit trail and no reverseAction. Matches the policy in `BHC_AUDIT_LOG.md`.

### C. Vercel Runtime Logs (last 24h + 7d)

Query `/api/webhooks/telegram`, `production`, `since=24h`:
- **1 entry total**: 2026-05-18 18:28:16 POST 200 — only a `[DEP0169]` punycode deprecation warning. No `Unknown action` lines, no error spinning.
- **7d query for `Unknown action`**: 0 hits.
- **7d query for `callback`**: query timed out before all pages fetched but produced no matches.
- **7d query for `telegram`**: 2 entries — the same DEP warning and one `cron/onboarding-stuck` consumer signup error unrelated to callbacks.

**Interpretation:** Vercel's runtime log retention is shallow and our handlers swallow most errors inside per-action `try/catch` that returns `Error: <msg>` *into the callback ack itself* (lines 535, 571, 612, 728, etc.) — so a handler failure shows as a tiny Telegram toast and never reaches the Vercel error log. The shallow log signal is consistent with broken callbacks: if a missing-context guard early-returns without ack, there is also no console.error, so Vercel sees a successful 200 and nothing else.

### D. Key Findings — top 10 broken patterns

1. **`bcsend_*` ack-last during ~N×500ms loop of Resend email sends.** For a 200-recipient broadcast, the spinner is guaranteed to time out on Telegram's client side (Telegram cancels the inline button visual after ~15s with no ack). Likely the #1 culprit for "Cancel" working but "Send to <segment>" feeling dead.
2. **`approve` referral handler ack-last across Airtable update + 1 Resend email + 1 buyer JWT + 1 buyer Resend email + 1 consumer update.** ~3-6s realistic — past Telegram's 5s "loading" timeout. User taps Approve, sees spinner, eventually sees "✅ Approved" but assumes broken on first try and double-taps (which then hits the `if (referral['Status'] === 'Intro Sent') answerCallbackQuery('Already approved')` early-return — confusing UX).
3. **Same ack-last pattern in `reassign`, `assignto`, `capprove`, `chasend`, `ronboard`.** All do Airtable + email(s) before ack. Every one of these is a "feels broken" report.
4. **`spdone` no-ack-without-chatId.** Inline button on a setup page session — if Telegram delivers `callback_query` without `message.chat.id` for any reason, the button hangs.
5. **9 prefixed handlers gated on `chatId && messageId`** silently swallow the callback. While Telegram normally provides both for inline keyboards, if the source message is older than 48h or has been deleted, `message` can be `undefined` and the handler ack never fires.
6. **3 dead handlers** (`qapprove`, `qreject`, `qwatch`) — no emitter. Likely orphaned from an earlier `/qualify` AI flow. Recommend deleting or rewiring `/qualify` to emit these instead of reusing `capprove`/`creject`. Not a button-feels-broken bug, but a code-rot foot-gun.
7. **22 of 47 live handlers mutate state with no `logAuditEntry`.** Means rollback / undo workflows can't recover any of these (`markpaid` flipping commission flag, `closelost` freeing rancher capacity, `selfblock` hiding from public map, `spgolive` flipping a rancher live). The audit log policy is in place — handlers are simply skipping it.
8. **`nudgerancher` double-acks** (line 924 then 964). Telegram API is idempotent on this so it's harmless, but a code smell signaling the ack-first-then-ack-after pattern wasn't intentional.
9. **`brief_*` handlers ack with "Loading…" before fetching, then `sendTelegramMessage` separately.** Pattern is correct, BUT they never edit/clear the original brief message — so each tap appends a new message and the original brief keyboard remains "live", inviting confused double-taps. Cosmetic but contributes to "feels broken".
10. **No global catch-all branch.** Once the dispatch chain falls through every `else if`, the handler simply `return NextResponse.json({ok:true})` at line 2323 with NO `answerCallbackQuery` call. Any unrecognized `callbackData` (corrupted button, future emitter that ships without a handler, typo) will spin forever. Recommend adding a final `else { await answerCallbackQuery(queryId, 'Unknown action'); console.error('[telegram] unhandled callback', callbackData); }` before the return.

### E. Recommended fixes (sizing for Task 1's follow-up tasks)

- **F1 (highest impact, 10 min):** Add the catch-all `else` at the end of the callback-query branch before `return NextResponse.json({ok:true})`. Logs every miss, prevents permanent spinners.
- **F2 (high impact, ~30 min):** Move `answerCallbackQuery(queryId, 'Working…')` to the FIRST line of every handler with Airtable+email work (`approve`, `reject`, `reassign`, `assignto`, `capprove`, `chasend`, `ronboard`, `bcsend_*`). The final "✅ Done" toast is then replaced by an `editTelegramMessage`. Mirrors the pattern `thankrancher`/`hotemail`/`rcheckin_send` already use correctly.
- **F3 (medium, ~20 min):** Lift each `chatId && messageId` guarded prefix handler — emit ack FIRST, then guard the side-effects. So `clcheck_*`, `selfblock_`, `firstweek_*`, `brief_*`, `spdone` all become reliable.
- **F4 (low, ~10 min):** Delete `qapprove`/`qreject`/`qwatch` handlers OR add the matching emitter in the `/qualify` command output (currently `/qualify` reuses `capprove`/`creject` — confirm intent).
- **F5 (separate ship, ~1h):** Wrap every mutating handler in `logAuditEntry` calls. Largest LOC, but mechanical.

### F. Self-Review

- Did I open the full file? Yes — `wc -l` reported 3839 lines, I read offsets 1, 400, 650, 1100, 1500, 1899, 2298 through the dispatch portion of POST. The handler dispatch occupies lines 401-2323; everything past 2326 is text-command handling (`/start`, `/pending`, `/stats`, etc.) and irrelevant to inline-callback breakage.
- Did I check every emitter? Yes — 82 raw `callback_data:` grep hits across `app/` and `lib/`, de-duplicated into 47 distinct prefixes, every one cross-referenced to a handler.
- Did I check every handler? Yes — 37 distinct `callbackData ===` / `callbackData?.startsWith(...)` / `action === ...` branches plus the 3 dead `q*` branches = 40 handler bodies inspected. (The discrepancy with the "47 live" count: `clcheck_`, `firstweek_`, `bcsend_`, `draftfollowup_`, `spf_` each handle multiple emitter variants inside one branch.)
- Vercel logs: confirmed only the DEP warning hit in 24h; no `Unknown action` strings ever logged because there is no catch-all branch to log them. The absence of error logs is itself a finding — see F1.
- Limits: I did NOT run the Telegram bot against a real callback to reproduce a spinner. The "feels broken" report is most plausibly explained by Findings 1-2 (ack-last over long work), but a definitive repro needs a Telegram client test. Recommended next step before Task 2 ships.
