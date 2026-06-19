# Phase 0 — Inbound Revival + Deliverability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Recover every lost inbound reply and stop poisoning sender reputation — using webhook handlers that are already fully built but failing closed in production — then give Ben a trust surface that proves the loop is live.

**Architecture:** Almost zero new code. The two Resend webhook handlers (`resend-inbound`, `resend`) are complete and fail closed when their signing secrets are unset (which they are in prod today). Phase 0 = Ben's Gate 0 setup + a verification harness + a `/admin/health` deliverability panel so the loop is observable and trusted, + a loud operator alert if it ever silently breaks again.

**Tech stack:** Next.js 16 route handlers · Resend Inbound/Webhooks (Svix-signed) · Airtable Conversations/Consumers/Ranchers · existing `operatorSignal` Telegram alerting.

**Pre-req:** Ben completes **Gate 0** in the master plan (DNS + 2 Resend endpoints + `RESEND_INBOUND_WEBHOOK_SECRET` + `RESEND_WEBHOOK_SECRET`). Tasks 1–2 can be built and merged BEFORE Ben finishes (they're dark/safe); Tasks 3–4 verify AFTER.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `app/api/webhooks/resend-inbound/route.ts` | Inbound reply → thread + Telegram | Modify (loud-alert on fail-closed) |
| `lib/deliverabilityStats.ts` | Read inbound/bounce/suppression counts from Airtable | **Create** |
| `app/api/admin/deliverability/route.ts` | Admin JSON feed for the panel | **Create** |
| `app/admin/health/page.tsx` | Render the deliverability panel | Modify |
| `lib/__deliverability_tests__/stats.test.mjs` | Unit test the stats aggregator | **Create** |
| `scripts/verify-inbound-loop.mjs` | Post-setup E2E probe (gitignored, Ben runs) | **Create** |

---

### Task 1: Deliverability stats aggregator

**Files:**
- Create: `lib/deliverabilityStats.ts`
- Test: `lib/__deliverability_tests__/stats.test.mjs`

Pure function that takes already-fetched Airtable records and returns the trust numbers. Keep I/O out so it's unit-testable (the route does the fetching).

- [ ] **Step 1: Write the failing test**

```js
// lib/__deliverability_tests__/stats.test.mjs
import { summarizeDeliverability } from '../deliverabilityStats.ts';

const now = Date.parse('2026-06-19T18:00:00Z');
const h = (n) => new Date(now - n * 3600_000).toISOString();

const conversations = [
  { fields: { Direction: 'inbound', Timestamp: h(2) } },
  { fields: { Direction: 'inbound', Timestamp: h(30) } }, // >24h, excluded from 24h count
  { fields: { Direction: 'outbound', Timestamp: h(1) } },  // outbound, excluded
];
const suppressed = [
  { fields: { Bounced: true } },
  { fields: { Complained: true } },
  { fields: { Unsubscribed: true, Bounced: false, Complained: false } },
];

const r = summarizeDeliverability({ conversations, suppressed, nowMs: now });

const checks = [
  [r.inboundLast24h, 1, 'one inbound within 24h'],
  [r.inboundTotal, 2, 'two inbound total'],
  [r.bounced, 1, 'one bounced'],
  [r.complained, 1, 'one complained'],
  [r.suppressedTotal, 3, 'three suppressed total'],
  [r.healthy, true, 'healthy when inbound flowing'],
];
let pass = 0;
for (const [got, exp, d] of checks) {
  const ok = got === exp;
  console.log((ok ? '✓' : '✗ FAIL') + ` ${JSON.stringify(got)} (exp ${JSON.stringify(exp)}) ${d}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} passed`);
if (pass !== checks.length) process.exit(1);
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node "lib/__deliverability_tests__/stats.test.mjs"`
Expected: FAIL — `Cannot find module '../deliverabilityStats.ts'`

- [ ] **Step 3: Implement**

```ts
// lib/deliverabilityStats.ts
// Pure aggregation for the /admin/health deliverability panel. No I/O — the
// route fetches records and passes them in, so this stays unit-testable.

export interface DeliverabilitySummary {
  inboundLast24h: number;
  inboundTotal: number;
  bounced: number;
  complained: number;
  suppressedTotal: number;
  healthy: boolean; // true when at least one inbound reply has landed in 24h
}

export function summarizeDeliverability(input: {
  conversations: Array<{ fields: Record<string, any> }>;
  suppressed: Array<{ fields: Record<string, any> }>;
  nowMs: number;
}): DeliverabilitySummary {
  const { conversations, suppressed, nowMs } = input;
  const dayAgo = nowMs - 24 * 3600_000;

  const inbound = conversations.filter(
    (c) => String(c.fields.Direction || '').toLowerCase() === 'inbound',
  );
  const inboundLast24h = inbound.filter((c) => {
    const t = Date.parse(c.fields.Timestamp || '');
    return !isNaN(t) && t >= dayAgo;
  }).length;

  const bounced = suppressed.filter((s) => s.fields.Bounced === true).length;
  const complained = suppressed.filter((s) => s.fields.Complained === true).length;

  return {
    inboundLast24h,
    inboundTotal: inbound.length,
    bounced,
    complained,
    suppressedTotal: suppressed.length,
    healthy: inboundLast24h > 0,
  };
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `node "lib/__deliverability_tests__/stats.test.mjs"`
Expected: `6/6 passed`

- [ ] **Step 5: Commit**

```bash
git add "lib/deliverabilityStats.ts" "lib/__deliverability_tests__/stats.test.mjs"
git commit -m "feat(deliverability): pure stats aggregator for health panel"
```

---

### Task 2: Admin deliverability feed + health panel

**Files:**
- Create: `app/api/admin/deliverability/route.ts`
- Modify: `app/admin/health/page.tsx`

Wire the aggregator to real Airtable reads behind the existing admin auth, and render it so Ben can SEE inbound flowing + bounces suppressing.

- [ ] **Step 1: Create the API route**

```ts
// app/api/admin/deliverability/route.ts
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { summarizeDeliverability } from '@/lib/deliverabilityStats';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const [conversations, consumers, ranchers] = await Promise.all([
    getAllRecords('Conversations', '').catch(() => []),
    getAllRecords(
      TABLES.CONSUMERS,
      'OR({Unsubscribed}=TRUE(),{Bounced}=TRUE(),{Complained}=TRUE())',
    ).catch(() => []),
    getAllRecords(
      TABLES.RANCHERS,
      'OR({Unsubscribed}=TRUE(),{Bounced}=TRUE(),{Complained}=TRUE())',
    ).catch(() => []),
  ]);

  const summary = summarizeDeliverability({
    conversations: conversations as any[],
    suppressed: [...(consumers as any[]), ...(ranchers as any[])],
    nowMs: Date.now(),
  });

  return NextResponse.json({
    ok: true,
    summary,
    inboundConfigured: !!process.env.RESEND_INBOUND_WEBHOOK_SECRET,
    eventsConfigured: !!process.env.RESEND_WEBHOOK_SECRET,
  });
}
```

> **Verify before writing:** confirm the admin-auth helper export name. Recon shows rancher auth is `requireRancher()` in `lib/rancherAuth.ts`; the admin equivalent is in `lib/adminAuth.ts`. Open it and match the real export (`requireAdmin` / `resolveAdminSession`) before finalizing this import. If the shape differs, mirror whatever `app/api/admin/today/route.ts` already does for auth.

- [ ] **Step 2: Render the panel in `app/admin/health/page.tsx`**

Add a "Deliverability" card that fetches `/api/admin/deliverability` and shows: inbound (24h), inbound (total), bounced, complained, suppressed total, and two green/red dots for `inboundConfigured` / `eventsConfigured`. Match the existing card markup in that file (read it first; reuse its styling classes — do not invent new ones).

```tsx
// Add inside app/admin/health/page.tsx, following the file's existing card pattern.
// Fetch on mount; render the six numbers + the two config dots.
// (Use the same useEffect/fetch + card <div> classes already present in this file.)
```

- [ ] **Step 3: Typecheck**

Run: `cd "/Users/benji.bushes/BHC/untitled folder/bhc" && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add "app/api/admin/deliverability/route.ts" "app/admin/health/page.tsx"
git commit -m "feat(admin): deliverability trust panel on /admin/health"
```

---

### Task 3: Loud alert when the inbound loop fails closed

**Files:**
- Modify: `app/api/webhooks/resend-inbound/route.ts:251-256` (the fail-closed branch)

Today, an unset secret silently 401s every reply (the exact bug that lost replies for weeks). Make it scream once to the operator so this can never silently regress.

- [ ] **Step 1: Read the current fail-closed block**

Run: `sed -n '235,260p' "app/api/webhooks/resend-inbound/route.ts"` — confirm the branch at 251–256 that returns 401 when `RESEND_INBOUND_WEBHOOK_SECRET` is unset in production.

- [ ] **Step 2: Add a deduped operator alert in that branch**

```ts
// Inside the `else if (process.env.NODE_ENV === 'production')` branch,
// before `return NextResponse.json(... 401 ...)`:
const { operatorSignal } = await import('@/lib/operatorSignal');
await operatorSignal({
  level: 'LOUD',
  text: '🚨 Inbound replies are being DROPPED — RESEND_INBOUND_WEBHOOK_SECRET is unset in prod. Set it in Vercel + Resend Inbound endpoint.',
  dedupeKey: 'inbound-secret-missing',
  dedupeWindowMs: 6 * 3600_000, // at most once per 6h
}).catch(() => {});
```

> **Verify:** confirm `operatorSignal`'s real signature in `lib/operatorSignal.ts` (recon shows it uses `dedupeKey` + `dedupeWindowMs`). Match the actual param names before finalizing.

- [ ] **Step 3: Typecheck**

Run: `cd "/Users/benji.bushes/BHC/untitled folder/bhc" && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add "app/api/webhooks/resend-inbound/route.ts"
git commit -m "fix(inbound): LOUD operator alert when webhook secret missing (no more silent drops)"
```

---

### Task 4: Post-setup live verification (run AFTER Ben completes Gate 0)

**Files:**
- Create: `scripts/verify-inbound-loop.mjs` (add to `.gitignore`)

Per `bhc-mutation-guardrails` Rule 7, curl-200 is not proof. This task is a guided live check.

- [ ] **Step 1: Confirm the Conversations table exists with the fields the handler writes**

The inbound handler writes to a `Conversations` table (fields: `Timestamp, Direction, From, To, Subject, Body, Body Plain, Sender Type, Objection Category, Sentiment, Action Needed, AI Summary, Raw Headers, Linked Referral, Linked Consumer, Linked Rancher`). If it doesn't exist, the write throws and the reply is lost. Verify the table + fields exist in Airtable (via the Airtable MCP `get_table_schema` or the base UI). If missing, Ben creates it.

- [ ] **Step 2: Live E2E — reply to a real thread email**

1. From the inbox/thread, trigger one outbound email to a test address you control (or reply to an existing thread email).
2. Reply to it from that address with a one-line body.
3. Within ~1 min, confirm ALL of:
   - a new `Conversations` row (Direction=inbound) appears,
   - the message shows in the rancher inbox / buyer ask thread (`postMessage` wrote a `Thread Messages` row),
   - the Telegram operator channel got the mirrored card with AI classification.
4. Open `/admin/health` → Deliverability panel shows `inboundConfigured: green` and inbound(24h) ≥ 1.

- [ ] **Step 3: Verify bounce suppression**

Send a test to a known-dead address (e.g. `bounce@simulator.amazonses.com` style, or Resend's bounce simulator). Confirm within a minute that the recipient's Consumer/Rancher row flips `Bounced=true` + `Unsubscribed=true`, and `/admin/health` bounced count increments.

- [ ] **Step 4: Document the result**

Append a dated "Phase 0 verified live" note to this plan file with the timestamps observed. If any leg fails, STOP and debug that boundary (use `bhc-flow-debug`) before declaring Phase 0 done.

---

## Self-review

- **Spec coverage:** inbound revival (Gate 0 + Task 3 alert + Task 4 verify) ✓; deliverability/spam fix (Gate 0.3/0.4 + bounce-suppression verify) ✓; trust surface (Tasks 1–2) ✓.
- **No placeholders:** every code step has real code; the two "verify the export name" notes are deliberate accuracy guards, not deferrals — the engineer confirms one symbol against an existing file.
- **Type consistency:** `summarizeDeliverability` signature is identical in test, impl, and route.

## Done when
Inbound replies land in threads + Telegram, bounces auto-suppress, `/admin/health` shows the loop green, and a missing secret now alarms instead of silently dropping. That alone is expected to be the fastest close-rate lever on the board.
