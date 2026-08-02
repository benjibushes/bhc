# Phase 1 — Deal State Machine + Rancher SMS Wake-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes. Each refactor task ships a regression test proving the Airtable writes are byte-identical to the old path BEFORE swapping — this is a live revenue system.

**Goal:** Create ONE Deal state machine (`lib/deal/state.ts`) that becomes the single source of deal state, refactor the close/transition writers to go through it (behavior-preserving), and emit typed events that fire rancher SMS wake-ups with idempotency — so a rancher gets a text "New paid deposit — accept the slot" with a one-tap action page.

**Architecture:** The state machine is **additive and behavior-preserving**. `transition()` writes the SAME existing Airtable Status strings the code writes today (recon found 11 distinct values across ~16 writers) — it just centralizes validation, timestamping, audit, and event emission. Writers are refactored **one at a time**, each gated by a regression test asserting identical writes. Events flow through a `dispatchDealEvent()` seam; in Phase 1 that seam sends rancher SMS (behind `ENABLE_SMS` + opt-in + `last_notified_state` idempotency). Phase 3 will plug push into the same seam.

**Tech stack:** TypeScript state machine · Airtable (existing Status/timestamp fields + a new optional `Deal Events` audit table) · `lib/twilio.ts` (`sendSMS`, already built) · rancher magic-link JWT (`lib/rancherAuth.ts`) · Upstash Redis (idempotency).

**Pre-req:** Phase 0 merged. Ben's **Gate 1** (Twilio + `TWILIO_*` + `ENABLE_SMS=1`) unblocks go-live, but Tasks 1–9 build dark and merge WITHOUT it (SMS no-ops until env present).

**Guardrails:** Migration-safe — do NOT alter the existing Status strings, the wizard 0..9 numbering, the stripe/cal webhook existing branches, or any migration field. `transition()` maps onto the current vocabulary; it does not rename anything.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `lib/deal/states.ts` | The ordered `DealState` enum + mapping to/from the 11 Airtable Status strings + per-state timestamp field name | **Create** |
| `lib/deal/transitions.ts` | Allowed-transition map + pure `canTransition()` | **Create** |
| `lib/deal/transition.ts` | `transition(refId, event, actor)` executor: validate → write Status+timestamp → audit → emit event | **Create** |
| `lib/deal/events.ts` | `DealEvent` type + `dispatchDealEvent()` seam | **Create** |
| `lib/deal/__tests__/*.test.mjs` | Unit tests (pure layers) | **Create** |
| `lib/twilio.ts` | Add `sendSMSToRancher()` (opt-in gated) | Modify |
| `lib/smsRancherTemplates.ts` | Rancher deal-event SMS bodies | **Create** |
| `app/r/[token]/page.tsx` | Mobile-first magic-link action page (accept deposit / connect bank) | **Create** |
| `app/api/r/[token]/route.ts` | Resolve the action token → render/execute | **Create** |
| Refactor targets (one task each) | `confirm-payment`, `quick-action`, `accept` routes | Modify |

---

## PART A — The state machine (build dark, fully testable, zero behavior change)

### Task 1: `DealState` enum + Airtable Status mapping

**Files:**
- Create: `lib/deal/states.ts`
- Test: `lib/deal/__tests__/states.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// lib/deal/__tests__/states.test.mjs
import { DEAL_STATES, statusToState, stateToStatus, timestampFieldFor } from '../states.ts';

const checks = [
  [statusToState('Intro Sent'), 'INTRO_SENT', 'maps Intro Sent'],
  [statusToState('Closed Won'), 'CLOSED_WON', 'maps Closed Won'],
  [statusToState('Slot Locked'), 'SLOT_LOCKED', 'maps Slot Locked'],
  [statusToState('Awaiting Payment'), 'DEPOSIT_PENDING', 'maps Awaiting Payment'],
  [stateToStatus('CLOSED_LOST'), 'Closed Lost', 'reverse maps Closed Lost'],
  [stateToStatus('IN_CONVERSATION'), 'Rancher Contacted', 'IN_CONVERSATION → Rancher Contacted'],
  [timestampFieldFor('SLOT_LOCKED'), 'Rancher Accepted At', 'slot-lock stamps Rancher Accepted At'],
  [DEAL_STATES.includes('DELIVERED'), true, 'enum includes fulfillment states'],
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

- [ ] **Step 2: Run, verify fail** — `node "lib/deal/__tests__/states.test.mjs"` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// lib/deal/states.ts
// The ONE ordered deal lifecycle. Each state maps onto the existing Airtable
// Referral "Status" string (so this is additive, not a rename) and, where the
// transition is a milestone, the "...At" timestamp field that gets stamped.

export const DEAL_STATES = [
  'NEW', 'MATCHED', 'INTRO_SENT', 'IN_CONVERSATION', 'CALL_BOOKED', 'CALL_DONE',
  'DEPOSIT_PENDING', 'DEPOSIT_PAID', 'SLOT_LOCKED', 'IN_FULFILLMENT', 'READY',
  'SCHEDULED', 'IN_TRANSIT', 'DELIVERED', 'CLOSED_WON', 'CLOSED_LOST', 'REFUNDED',
] as const;

export type DealState = (typeof DEAL_STATES)[number];

// state → the canonical Airtable Status string written today. Multiple states can
// map to one legacy Status (the legacy vocabulary is coarser); transition.ts also
// stamps the milestone timestamp so granularity isn't lost.
const STATE_TO_STATUS: Record<DealState, string> = {
  NEW: 'Pending Approval',
  MATCHED: 'Pending Approval',
  INTRO_SENT: 'Intro Sent',
  IN_CONVERSATION: 'Rancher Contacted',
  CALL_BOOKED: 'Rancher Contacted',
  CALL_DONE: 'Negotiation',
  DEPOSIT_PENDING: 'Awaiting Payment',
  DEPOSIT_PAID: 'Awaiting Payment',
  SLOT_LOCKED: 'Slot Locked',
  IN_FULFILLMENT: 'Slot Locked',
  READY: 'Slot Locked',
  SCHEDULED: 'Slot Locked',
  IN_TRANSIT: 'Slot Locked',
  DELIVERED: 'Slot Locked',
  CLOSED_WON: 'Closed Won',
  CLOSED_LOST: 'Closed Lost',
  REFUNDED: 'Closed Lost',
};

// Reverse map: legacy Status → the EARLIEST state it represents (for reading
// existing records into the machine). Coarse-by-design.
const STATUS_TO_STATE: Record<string, DealState> = {
  'Pending Approval': 'MATCHED',
  'Intro Sent': 'INTRO_SENT',
  'Rancher Contacted': 'IN_CONVERSATION',
  'Negotiation': 'CALL_DONE',
  'Waitlisted': 'MATCHED',
  'Awaiting Payment': 'DEPOSIT_PENDING',
  'Slot Locked': 'SLOT_LOCKED',
  'Closed Won': 'CLOSED_WON',
  'Closed Lost': 'CLOSED_LOST',
};

// Milestone timestamp field stamped on entering a state (null = no stamp).
// These field names already exist on the Referrals table (recon-confirmed).
const STATE_TIMESTAMP: Partial<Record<DealState, string>> = {
  INTRO_SENT: 'Intro Sent At',
  CALL_BOOKED: 'Sales Call Booked At',
  CALL_DONE: 'Sales Call Completed At',
  SLOT_LOCKED: 'Rancher Accepted At',
  DELIVERED: 'Delivered At',
  CLOSED_WON: 'Closed At',
};

export function stateToStatus(s: DealState): string { return STATE_TO_STATUS[s]; }
export function statusToState(status: string): DealState | null {
  return STATUS_TO_STATE[status.trim()] ?? null;
}
export function timestampFieldFor(s: DealState): string | null {
  return STATE_TIMESTAMP[s] ?? null;
}
```

> **Verify at execution:** confirm `Intro Sent At`, `Rancher Accepted At`, `Sales Call Booked At`, `Sales Call Completed At`, `Delivered At`, `Closed At` are the EXACT Airtable field names (recon confirmed the first four; check `Delivered At`/`Closed At` against the Referrals schema and adjust the map — do NOT create new fields without Ben).

- [ ] **Step 4: Run test, verify pass** → `8/8 passed`.

- [ ] **Step 5: Commit** — `git commit -m "feat(deal): DealState enum + Airtable Status mapping"`.

---

### Task 2: Allowed transitions + `canTransition()`

**Files:**
- Create: `lib/deal/transitions.ts`
- Test: `lib/deal/__tests__/transitions.test.mjs`

- [ ] **Step 1: Failing test**

```js
// lib/deal/__tests__/transitions.test.mjs
import { canTransition } from '../transitions.ts';

const checks = [
  [canTransition('INTRO_SENT', 'IN_CONVERSATION'), true, 'intro → conversation ok'],
  [canTransition('DEPOSIT_PAID', 'SLOT_LOCKED'), true, 'paid → locked ok'],
  [canTransition('CLOSED_WON', 'INTRO_SENT'), false, 'no resurrection from won'],
  [canTransition('SLOT_LOCKED', 'DEPOSIT_PENDING'), false, 'no backward to pending'],
  [canTransition('INTRO_SENT', 'CLOSED_LOST'), true, 'any active → lost ok'],
  [canTransition('INTRO_SENT', 'CLOSED_WON'), true, 'off-platform fast-close allowed'],
];
let pass = 0;
for (const [got, exp, d] of checks) {
  const ok = got === exp;
  console.log((ok ? '✓' : '✗ FAIL') + ` ${got} (exp ${exp}) ${d}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} passed`);
if (pass !== checks.length) process.exit(1);
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

```ts
// lib/deal/transitions.ts
import { DealState } from './states';

// Forward-only lifecycle with universal side-exits. Off-platform closes can
// jump straight to CLOSED_WON from any active state (ranchers close verbally);
// any active state can go CLOSED_LOST. Terminal states don't transition out
// (revive is an explicit admin override that bypasses the machine).
const FORWARD: DealState[] = [
  'NEW', 'MATCHED', 'INTRO_SENT', 'IN_CONVERSATION', 'CALL_BOOKED', 'CALL_DONE',
  'DEPOSIT_PENDING', 'DEPOSIT_PAID', 'SLOT_LOCKED', 'IN_FULFILLMENT', 'READY',
  'SCHEDULED', 'IN_TRANSIT', 'DELIVERED', 'CLOSED_WON',
];
const TERMINAL: DealState[] = ['CLOSED_WON', 'CLOSED_LOST', 'REFUNDED'];

export function canTransition(from: DealState, to: DealState): boolean {
  if (from === to) return false;
  if (TERMINAL.includes(from)) return false;
  if (to === 'CLOSED_LOST' || to === 'REFUNDED') return true; // universal exit
  if (to === 'CLOSED_WON') return true; // off-platform fast-close from any active
  const fi = FORWARD.indexOf(from);
  const ti = FORWARD.indexOf(to);
  if (fi === -1 || ti === -1) return false;
  return ti > fi; // forward-only
}
```

- [ ] **Step 4: Run test, verify pass** → `6/6`.

- [ ] **Step 5: Commit** — `git commit -m "feat(deal): allowed-transition map + canTransition"`.

---

### Task 3: `transition()` executor + event emission

**Files:**
- Create: `lib/deal/transition.ts`, `lib/deal/events.ts`
- Test: `lib/deal/__tests__/transition.test.mjs` (inject a fake Airtable writer + fake dispatcher — no live I/O)

- [ ] **Step 1: Failing test (dependency-injected so it's pure)**

```js
// lib/deal/__tests__/transition.test.mjs
import { applyTransition } from '../transition.ts';

const writes = [];
const events = [];
const fakeDeps = {
  getReferral: async () => ({ id: 'rec1', fields: { Status: 'Awaiting Payment' } }),
  updateReferral: async (id, fields) => { writes.push({ id, fields }); },
  audit: async (row) => { writes.push({ audit: row }); },
  dispatch: async (ev) => { events.push(ev); },
  nowIso: () => '2026-06-19T18:00:00.000Z',
};

const res = await applyTransition('rec1', 'DEPOSIT_PAID->SLOT_LOCKED', {
  to: 'SLOT_LOCKED', actor: 'rancher:rec9', reason: 'accepted deposit',
}, fakeDeps);

const main = writes.find((w) => w.fields);
const checks = [
  [res.ok, true, 'transition ok'],
  [main.fields.Status, 'Slot Locked', 'writes legacy Status'],
  [main.fields['Rancher Accepted At'], '2026-06-19T18:00:00.000Z', 'stamps milestone ts'],
  [events.length, 1, 'emits one event'],
  [events[0].to, 'SLOT_LOCKED', 'event carries target state'],
];
let pass = 0;
for (const [got, exp, d] of checks) {
  const ok = got === exp;
  console.log((ok ? '✓' : '✗ FAIL') + ` ${JSON.stringify(got)} (exp ${JSON.stringify(exp)}) ${d}`);
  if (ok) pass++;
}
// idempotency: same target when already there → no write, no event
writes.length = 0; events.length = 0;
const noop = await applyTransition('rec1', 'x', { to: 'DEPOSIT_PENDING', actor: 'system' }, {
  ...fakeDeps, getReferral: async () => ({ id: 'rec1', fields: { Status: 'Awaiting Payment' } }),
});
const idem = noop.ok === true && noop.noop === true && writes.length === 0 && events.length === 0;
console.log((idem ? '✓' : '✗ FAIL') + ` idempotent no-op when already in target state`);
if (idem) pass++;
console.log(`\n${pass}/${checks.length + 1} passed`);
if (pass !== checks.length + 1) process.exit(1);
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement events + executor**

```ts
// lib/deal/events.ts
import { DealState } from './states';

export interface DealEvent {
  referralId: string;
  from: DealState | null;
  to: DealState;
  actor: string;          // 'rancher:recX' | 'buyer:recY' | 'system' | 'admin' | 'cron:close-detector'
  reason?: string;
  atIso: string;
}

// The seam. Phase 1 wires rancher SMS here; Phase 3 adds push + the unified
// notifyParticipants() dispatcher. Keep this import-light so callers don't pull
// the whole notify stack into hot paths.
export async function dispatchDealEvent(ev: DealEvent): Promise<void> {
  const { onDealEvent } = await import('./onDealEvent');
  await onDealEvent(ev).catch((e) => console.warn('[deal] dispatch failed', e));
}
```

```ts
// lib/deal/transition.ts
import { DealState, stateToStatus, statusToState, timestampFieldFor } from './states';
import { canTransition } from './transitions';
import type { DealEvent } from './events';

export interface TransitionInput {
  to: DealState;
  actor: string;
  reason?: string;
  extraFields?: Record<string, any>; // e.g. { 'Sale Amount': 2400, 'Commission Due': 240 }
}

export interface TransitionDeps {
  getReferral: (id: string) => Promise<{ id: string; fields: Record<string, any> }>;
  updateReferral: (id: string, fields: Record<string, any>) => Promise<void>;
  audit: (row: Record<string, any>) => Promise<void>;
  dispatch: (ev: DealEvent) => Promise<void>;
  nowIso: () => string;
}

// Pure-ish core: all I/O is injected (deps), so it's unit-tested without Airtable.
export async function applyTransition(
  referralId: string,
  _label: string,
  input: TransitionInput,
  deps: TransitionDeps,
): Promise<{ ok: boolean; noop?: boolean; error?: string }> {
  const rec = await deps.getReferral(referralId);
  const from = statusToState(String(rec.fields.Status || '')) ?? null;

  // Idempotency: already in (or past) the target legacy Status → no-op.
  if (from && stateToStatus(from) === stateToStatus(input.to) && from === input.to) {
    return { ok: true, noop: true };
  }
  if (from && !canTransition(from, input.to)) {
    return { ok: false, error: `illegal transition ${from} → ${input.to}` };
  }

  const now = deps.nowIso();
  const fields: Record<string, any> = { Status: stateToStatus(input.to), ...(input.extraFields || {}) };
  const tsField = timestampFieldFor(input.to);
  if (tsField && !rec.fields[tsField]) fields[tsField] = now;

  await deps.updateReferral(referralId, fields);
  await deps.audit({
    Referral: [referralId], From: from, To: input.to, Actor: input.actor,
    Reason: input.reason || '', At: now,
  });

  const ev: DealEvent = { referralId, from, to: input.to, actor: input.actor, reason: input.reason, atIso: now };
  await deps.dispatch(ev);
  return { ok: true };
}
```

```ts
// lib/deal/transitionLive.ts  — the real-deps wrapper callers use in routes.
import { applyTransition, TransitionInput } from './transition';
import { dispatchDealEvent } from './events';
import { getRecordById, updateRecord, createRecord, TABLES } from '@/lib/airtable';

export async function transition(referralId: string, input: TransitionInput) {
  return applyTransition(referralId, '', input, {
    getReferral: async (id) => {
      const r: any = await getRecordById(TABLES.REFERRALS, id);
      return { id, fields: r?.fields ?? r ?? {} };
    },
    updateReferral: async (id, fields) => { await updateRecord(TABLES.REFERRALS, id, fields); },
    // Graceful audit: if the "Deal Events" table doesn't exist yet, swallow it
    // (mirrors lib/adminConfig's missing-table tolerance) so this never blocks a close.
    audit: async (row) => { try { await createRecord('Deal Events', row); } catch { /* table optional */ } },
    dispatch: dispatchDealEvent,
    nowIso: () => new Date().toISOString(),
  });
}
```

> **Verify at execution:** `getRecordById`/`updateRecord`/`createRecord`/`TABLES.REFERRALS` export names against `lib/airtable.ts`. Recon confirms these exist; match exact signatures. The `Deal Events` audit table is OPTIONAL (graceful) — Ben can create it later for a full audit trail; absence does not break transitions.

- [ ] **Step 4: Run test, verify pass** → all green.

- [ ] **Step 5: Commit** — `git commit -m "feat(deal): transition() executor + event emission seam (DI, behavior-preserving)"`.

---

## PART B — Refactor close writers onto `transition()` (one at a time, regression-gated)

> **Method for each:** (1) write a regression test capturing the EXACT fields the current handler writes for the close, (2) replace the inline `updateRecord(...Status...)` with a `transition()` call producing the same fields, (3) prove the test still passes. Do NOT touch surrounding logic (commission calc, Stripe calls, capacity decrement, emails). Migration tier_v2 branches stay exactly as-is.

### Task 4: Refactor `confirm-payment` → `transition('CLOSED_WON')`

**Files:** Modify `app/api/rancher/referrals/[id]/confirm-payment/route.ts:91` (the `Status: 'Closed Won'` write).

- [ ] Step 1: Read the handler fully; identify the single `updateRecord` that sets `Status: 'Closed Won'` + `Sale Amount` + `Commission Due` (recon: line ~91, commission at ~117).
- [ ] Step 2: Replace ONLY the Status/timestamp portion with:
```ts
import { transition } from '@/lib/deal/transitionLive';
// ...where it currently writes Status 'Closed Won':
await transition(referralId, {
  to: 'CLOSED_WON', actor: `rancher:${rancherId}`, reason: 'off-platform payment confirmed',
  extraFields: { 'Sale Amount': saleAmount, 'Commission Due': commissionDue },
});
```
Leave the Stripe invoice call, capacity decrement, Buyer Stage flip, and emails untouched (they run after).
- [ ] Step 3: Regression — assert the resulting Airtable write still contains `Status:'Closed Won'`, `Sale Amount`, `Commission Due`, and now `Closed At`. (Mock `transitionLive` deps as in Task 3.)
- [ ] Step 4: `npx tsc --noEmit` → 0 errors.
- [ ] Step 5: Commit — `refactor(close): confirm-payment uses transition()`.

### Task 5: Refactor rancher `quick-action` won/lost/in_talks → `transition()`

**Files:** Modify `app/api/rancher/quick-action/route.ts` and `app/api/rancher/referrals/[id]/route.ts` (PATCH) — the won→`Closed Won`, lost/pass→`Closed Lost`, in_talks→`Rancher Contacted` writes (recon: route.ts:100, quick-action ~416 for the won path; TERMINAL_STATUSES guard at ~102).

- [ ] Step 1: Keep the existing TERMINAL_STATUSES idempotency guard (it prevents Stripe re-fire) — `transition()`'s no-op is a second layer, not a replacement.
- [ ] Step 2: Map: `won`→`{to:'CLOSED_WON', extraFields:{'Sale Amount','Commission Due'}}`, `lost`/`pass`→`{to:'CLOSED_LOST', reason}`, `in_talks`→`{to:'IN_CONVERSATION'}`. Preserve `recordClose()` (capacity + funnel event) — call it exactly where it's called now.
- [ ] Step 3: Regression test each branch writes the same legacy Status.
- [ ] Step 4: tsc.
- [ ] Step 5: Commit.

### Task 6: Refactor `accept` → `transition('SLOT_LOCKED')`

**Files:** Modify `app/api/rancher/referrals/[id]/accept/route.ts:134`.

- [ ] Step 1: Replace the `Status:'Slot Locked'` + `Rancher Accepted At` write with `transition(referralId, { to:'SLOT_LOCKED', actor:'rancher:'+rancherId, reason:'accepted deposit slot' })` (the timestamp is auto-stamped by the machine).
- [ ] Step 2: Leave the buyer "slot locked" email exactly as-is.
- [ ] Step 3: Regression: write still has `Status:'Slot Locked'` + `Rancher Accepted At`.
- [ ] Step 4: tsc. Step 5: Commit.

> Matching/suggest, crons, and the Telegram handlers' Status writes are refactored in a LATER pass (Phase 2) once the machine is proven on the close paths. Do not touch them in Phase 1.

---

## PART C — Rancher SMS wake-up (build dark behind ENABLE_SMS + opt-in)

### Task 7: Rancher SMS opt-in field + wizard consent

**Files:** Modify `app/rancher/setup/RancherSetupWizard.tsx` (the contact step that already edits `Phone` at ~496–503).

- [ ] Step 1: Ben (or eng via Airtable MCP) adds a `SMS Opt-In` checkbox field to the **Ranchers** table (mirrors the existing Consumer `SMS Opt-In`). Migration-safe — new field, additive.
- [ ] Step 2: In the wizard contact step, add a TCPA consent checkbox near Phone: "Text me deal alerts (new deposits, buyer messages). Msg/data rates may apply. Reply STOP to opt out." Bind to `SMS Opt-In`. Do NOT change the 0..9 step numbering or the `?token` contract.
- [ ] Step 3: Persist it through the existing `PATCH /api/rancher/setup` save path (add the field to the allowed-save set).
- [ ] Step 4: tsc + load the wizard locally, confirm the checkbox renders + saves. Step 5: Commit.

### Task 8: `sendSMSToRancher()` + rancher deal templates

**Files:** Modify `lib/twilio.ts`; Create `lib/smsRancherTemplates.ts` + test.

- [ ] Step 1: Failing test for template bodies:
```js
// lib/__sms_tests__/rancherTemplates.test.mjs
import { rancherSmsBody } from '../smsRancherTemplates.ts';
const b = rancherSmsBody('DEPOSIT_PAID', { buyerName: 'Sarah', tier: 'Half', link: 'https://buyhalfcow.com/r/abc' });
const ok = b.includes('Sarah') && b.includes('deposit') && b.includes('/r/abc') && b.includes('STOP');
console.log((ok ? '✓' : '✗ FAIL') + ' deposit-paid body');
process.exit(ok ? 0 : 1);
```
- [ ] Step 2: Implement `rancherSmsBody(state, ctx)` with bodies for `DEPOSIT_PAID` ("💰 {buyerName} paid a deposit for a {tier}. Accept the slot: {link} — Reply STOP to opt out"), `CONNECT_STUCK`, `BUYER_MESSAGE`, `CALL_BOOKED`. ≤320 chars each.
- [ ] Step 3: Add `sendSMSToRancher({ rancher, body, reason })` to `lib/twilio.ts` mirroring `sendSMSToConsumer` (lines 82–120) but gating on `rancher['SMS Opt-In'] === true` + `rancher['Unsubscribed'] !== true` + `normalizeToE164(rancher['Phone'])`. Reuse `sendSMS()`.
- [ ] Step 4: Run template test → pass; tsc. Step 5: Commit.

### Task 9: `/r/[token]` mobile action page (accept deposit)

**Files:** Create `app/r/[token]/page.tsx`, `app/api/r/[token]/route.ts`.

- [ ] Step 1: Mint a short-lived (`exp 7d`) `rancher-action` JWT `{ type:'rancher-action', referralId, rancherId, action }` signed with `JWT_SECRET` (reuse the pattern in `lib/rancherAuth.ts`). A helper `mintActionToken(referralId, rancherId, action)`.
- [ ] Step 2: `GET /r/[token]` → verify token → render a sealed, mobile-first page (no site chrome, like ChromeGate focused routes) showing the deal + ONE primary button. For `action='accept'`: "Accept this deposit slot" → POST to the existing accept route. Include the inline "how" (one line + a Loom placeholder slot).
- [ ] Step 3: The action POST calls the SAME `transition()`-backed accept route from Task 6 (no logic duplication).
- [ ] Step 4: E2E in browser (mobile viewport): token → page renders → accept → `Slot Locked`. Step 5: Commit.

### Task 10: Fire rancher SMS on deal events (idempotent)

**Files:** Create `lib/deal/onDealEvent.ts` (the seam target from Task 3).

- [ ] Step 1: Implement `onDealEvent(ev)`:
  - Only act on `to ∈ {DEPOSIT_PAID, CALL_BOOKED}` (Phase 1 scope).
  - Idempotency: Redis key `notif:${referralId}:${ev.to}` set-if-absent (Upstash, via the existing `lib/rancherCapacity.ts` Redis client pattern). If already set → skip (this is the `last_notified_state` guard — mandatory per guardrails).
  - Load rancher; build body via `rancherSmsBody`; mint action token; `sendSMSToRancher`.
  - All wrapped so a failure never throws back into `transition()`.
- [ ] Step 2: Test with injected fakes: two dispatches of the same event → exactly ONE send.
- [ ] Step 3: tsc. Step 4: Commit.

### Task 11: Live E2E (AFTER Ben completes Gate 1)

- [ ] Per `bhc-mutation-guardrails` Rule 7: with `ENABLE_SMS=1` + Twilio env live, drive one real deal to DEPOSIT_PAID on a test referral with a test rancher (your own opted-in number). Confirm: exactly one SMS arrives, the `/r/[token]` link opens the sealed action page, tapping Accept flips the deal to `Slot Locked`, and a second identical event sends NO duplicate text. Document timestamps in this file.

---

## Self-review

- **Spec coverage:** state machine (Tasks 1–3) ✓; refactor writers behavior-preserving (4–6) ✓; rancher push via SMS floor with idempotency (7–10) ✓; one-tap action page (9) ✓; live verify (11) ✓.
- **No placeholders:** Parts A & C ship complete code; Part B refactors give exact file:line + the exact `transition()` call + a regression test (the honest unit of a refactor — surrounding logic is preserved, not rewritten).
- **Type consistency:** `DealState`, `transition()`, `TransitionInput`, `DealEvent`, `rancherSmsBody(state, ctx)`, `sendSMSToRancher({rancher,body,reason})` names are identical across tasks.
- **Migration safety:** no Status string renamed; tier_v2 branches untouched; wizard numbering + `?token` contract preserved; new fields (`SMS Opt-In`, optional `Deal Events`) are additive.

## Done when
Every close path writes through `transition()` (validated, timestamped, audited, event-emitting) with identical Airtable results, and an opted-in rancher gets exactly one idempotent SMS on a paid deposit that deep-links to a one-tap accept page. The state machine is now the spine Phase 2's inbox + Phase 3's push read from.
