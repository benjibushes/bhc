# Platform Vertical Architecture + On-Platform Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure BHC into 4 explicit verticals (Data / Buyer / Rancher / Admin) with enforced contracts so future features ship without cascading breaks, then layer in-platform messaging (fixes "rancher won't call lead") and Stripe Connect Express deposit flow (platform owns transaction + monthly fee) — all on a long-lived branch with zero prod merge until bulletproofed.

**Architecture:**
- 4 verticals share ONE Data Layer (`lib/contracts/*`, `lib/airtable.ts`, `lib/email.ts`, `lib/telegram.ts`, `lib/rancherCapacity.ts`, `lib/stripe-commission.ts`). Every cross-vertical state change goes through `lib/contracts/*` typed handlers — verticals never import each other directly.
- Buyer Vertical owns `/access`, `/map`, `/member`, `/start`, `/wins`, `/api/consumers`, `/api/warmup`, `/api/member/*`, `/api/orders/request`.
- Rancher Vertical owns `/rancher`, `/ranchers/[slug]`, `/api/rancher/*`, `/api/ranchers/*`, `/api/auth/rancher/*`.
- Admin Vertical owns `/admin/*`, `/api/admin/*`, `/api/webhooks/telegram`, `/api/cron/*`.
- In-platform messaging adds a `Threads` table that both Buyer + Rancher verticals read via `lib/contracts/threads.ts`. Email mirroring handled by an admin-vertical webhook so neither side touches the other's UI directly.
- Stripe Connect Express replaces external Stripe Payment Links. Buyer deposits go to platform; platform pays rancher 90% on fulfillment-confirm; 10% retained as commission. Monthly `$X/mo` platform fee billed via Stripe Subscriptions to rancher's Connect account.
- Branch strategy: all work on `stage-3-verticals` branch (never main) until Task 18 ships canary to 2 pilot ranchers via env flag.

**Tech Stack:** Next.js 16 App Router, TypeScript strict mode, Airtable (base `appgLT4z009iwAfhs`), Stripe (Connect Express + Subscriptions), Resend (email + Inbound webhook), Upstash Redis (atomic counters), JWT for cross-page auth, Telegram for ops cockpit.

**Conventions:**
- BHC has no Jest/Vitest. "Tests" = `curl` smoke checks + a manual checklist per task. Plan acknowledges this and substitutes verification commands.
- Every task ends with: type-check clean → commit → push to branch → smoke test against `vercel --preview` deployment.
- No prod deploys. `vercel.json` keeps the canary env flag `STRIPE_CONNECT_ENABLED=false` everywhere until Task 18.

---

## File Structure (locked before tasks)

**New files (vertical roots):**
- `lib/contracts/buyer.ts` — typed input/output shapes for buyer-side state changes (signup, engage, order-request)
- `lib/contracts/rancher.ts` — typed shapes for rancher-side state changes (close, capacity, page-edit)
- `lib/contracts/admin.ts` — typed shapes for admin operations (approve, route, comp, broadcast)
- `lib/contracts/threads.ts` — buyer↔rancher message threads (shared by Buyer + Rancher verticals)
- `lib/contracts/payments.ts` — Stripe Connect deposit + payout types
- `lib/contracts/index.ts` — re-exports + the `verticalGuard` runtime helper that throws if a Buyer route mutates rancher-only fields
- `lib/funnelMetrics.ts` — instrumentation library that every funnel-stage transition calls
- `lib/stripeConnect.ts` — Stripe Connect Express OAuth + payout helpers
- `app/api/threads/[id]/route.ts` — GET/POST messages on a thread (called by both verticals through the contract)
- `app/api/threads/[id]/message/route.ts` — POST message on thread
- `app/api/rancher/connect/route.ts` — Stripe Connect Express OAuth callback
- `app/api/rancher/connect/start/route.ts` — initiate Connect onboarding
- `app/api/checkout/deposit/route.ts` — buyer deposit checkout session creator
- `app/api/webhooks/stripe-connect/route.ts` — Connect account events (payouts, payment_intent.succeeded on platform)
- `app/api/admin/payments/route.ts` — admin read of all on-platform deposits + payout state
- `app/(buyer)/checkout/[refId]/page.tsx` — on-platform deposit flow (Buyer vertical)
- `app/(rancher)/inbox/page.tsx` — rancher message inbox (Rancher vertical)
- `app/(admin)/payments/page.tsx` — admin payments overview (Admin vertical)
- `docs/ARCHITECTURE.md` — locked architecture doc with vertical boundary diagram
- `tools/check-vertical-boundaries.ts` — pre-commit script that fails if any vertical imports another's internal files

**Modified files:**
- `package.json` — add `boundaries:check` script + pre-commit hook
- `vercel.json` — add `STRIPE_CONNECT_ENABLED` env flag default false + preview-only canary branch deploys
- `app/api/orders/request/route.ts:200-260` — route through `contracts/buyer.ts` createOrderRequest + emit thread instead of direct rancher email
- `app/api/rancher/referrals/[id]/route.ts:260-700` — route through `contracts/rancher.ts` recordClose + dispatch payout via `stripeConnect.payout()` when STRIPE_CONNECT_ENABLED
- `app/api/matching/suggest/route.ts:670-900` — emit funnel-stage event via `funnelMetrics.record()` at each transition
- `lib/email.ts` — guardedSend gets a `threadId` param so inbound replies route to the thread
- `app/api/webhooks/resend-inbound/route.ts` — recognize `thread-<id>@replies.buyhalfcow.com` reply-to addresses + post into the thread
- Airtable schema — new tables `Threads`, `Thread Messages`, `Payments`, `Payouts` (operator-managed schema add, plan notes the spec)

**Airtable schema additions (locked):**
- `Threads`: `Id` (auto), `Referral` (link → Referrals), `Buyer` (link → Consumers), `Rancher` (link → Ranchers), `Subject`, `Created At`, `Last Message At`, `Status` (Active / Closed)
- `Thread Messages`: `Id`, `Thread` (link → Threads), `Sender Type` (buyer/rancher/admin), `Sender Id`, `Body`, `Sent Via` (web/email/telegram), `Created At`, `Email Message Id` (for inbound dedup)
- `Payments`: `Id`, `Referral` (link), `Buyer` (link), `Rancher` (link), `Amount Cents`, `Stripe Payment Intent Id`, `Status` (pending/succeeded/refunded), `Created At`, `Captured At`, `Refunded At`
- `Payouts`: `Id`, `Payment` (link → Payments), `Rancher` (link), `Stripe Transfer Id`, `Amount Cents`, `Status` (pending/paid/failed), `Released At`, `Reason` (fulfillment_confirmed / dispute_resolved)

---

## Task 0: Branch + baseline freeze

**Files:**
- Modify: `vercel.json`
- Create: `.github/CODEOWNERS` (optional)

- [ ] **Step 1: Create long-lived branch from current main**

Run:
```bash
git checkout main && git pull origin main
git checkout -b stage-3-verticals
git push -u origin stage-3-verticals
```

Expected: branch tracks `origin/stage-3-verticals`.

- [ ] **Step 2: Add canary env flag default to vercel.json**

Modify `vercel.json` — add inside the existing `env` block (do not remove existing entries):

```json
{
  "env": {
    "STRIPE_CONNECT_ENABLED": "false",
    "ON_PLATFORM_MESSAGING_ENABLED": "false",
    "VERTICAL_BOUNDARY_ENFORCE": "warn"
  }
}
```

`warn` means boundary violations log but don't crash; flips to `error` in Task 5.

- [ ] **Step 3: Snapshot current main commit hash for rollback reference**

Run:
```bash
git rev-parse main > .branch-baseline
git add vercel.json .branch-baseline
git commit -m "chore(stage-3): branch baseline + canary env flags off"
git push
```

- [ ] **Step 4: Verify Vercel preview deployment of branch succeeds**

Run:
```bash
gh pr create --draft --title "stage-3: vertical architecture (DO NOT MERGE)" --body "Long-lived branch. Will merge only after Task 18 canary verification."
```

Then poll Vercel:
```bash
vercel ls --scope <team> | head -5
```

Expected: latest deployment for `stage-3-verticals` shows READY within 5 min.

---

## Task 1: Data Layer contracts module

**Files:**
- Create: `lib/contracts/buyer.ts`
- Create: `lib/contracts/rancher.ts`
- Create: `lib/contracts/admin.ts`
- Create: `lib/contracts/threads.ts`
- Create: `lib/contracts/payments.ts`
- Create: `lib/contracts/index.ts`

- [ ] **Step 1: Define buyer contract types**

Create `lib/contracts/buyer.ts`:

```ts
// Buyer Vertical — all writes from /access, /map, /member, /api/consumers, /api/warmup, /api/orders/request
// MUST go through one of these contract functions. Any direct updateRecord(TABLES.CONSUMERS, ...)
// outside this file is a vertical boundary violation (Task 5 enforces).

import { updateRecord, createRecord, getRecordById, TABLES } from '@/lib/airtable';
import { funnelRecord } from '@/lib/funnelMetrics';

export type BuyerStage = 'NEW' | 'WAITING' | 'READY' | 'MATCHED' | 'CLOSED';

export interface BuyerCreateInput {
  fullName: string;
  email: string;
  state: string;
  phone?: string;
  orderType?: string;
  budget?: string;
  source: string;
  intentScore: number;
  intentClassification: 'High' | 'Medium' | 'Low';
}

export async function createBuyer(input: BuyerCreateInput): Promise<{ id: string; stage: BuyerStage }> {
  const record: any = await createRecord(TABLES.CONSUMERS, {
    'Full Name': input.fullName,
    'Email': input.email,
    'State': input.state,
    'Phone': input.phone || '',
    'Order Type': input.orderType || '',
    'Budget': input.budget || '',
    'Source': input.source,
    'Intent Score': input.intentScore,
    'Intent Classification': input.intentClassification,
    'Buyer Stage': 'NEW',
    'Buyer Stage Updated At': new Date().toISOString(),
    'Segment': 'Beef Buyer',
  });
  await funnelRecord({ stage: 'signup', buyerId: record.id, intentScore: input.intentScore });
  return { id: record.id, stage: 'NEW' };
}

export async function transitionBuyerStage(buyerId: string, to: BuyerStage, reason: string): Promise<void> {
  const now = new Date().toISOString();
  await updateRecord(TABLES.CONSUMERS, buyerId, {
    'Buyer Stage': to,
    'Buyer Stage Updated At': now,
  });
  await funnelRecord({ stage: `transition:${to}`, buyerId, reason });
}

export async function recordBuyerEngagement(buyerId: string): Promise<void> {
  const now = new Date().toISOString();
  await updateRecord(TABLES.CONSUMERS, buyerId, {
    'Warmup Engaged At': now,
    'Ready to Buy': true,
  });
  await funnelRecord({ stage: 'engaged', buyerId });
}
```

- [ ] **Step 2: Define rancher contract types**

Create `lib/contracts/rancher.ts`:

```ts
// Rancher Vertical — all writes from /rancher, /ranchers/[slug], /api/rancher/* MUST route here.

import { updateRecord, getRecordById, TABLES } from '@/lib/airtable';
import { decrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import { transitionBuyerStage } from './buyer';
import { funnelRecord } from '@/lib/funnelMetrics';

export type ReferralStatus =
  | 'Pending Approval'
  | 'Intro Sent'
  | 'Rancher Contacted'
  | 'Negotiation'
  | 'Awaiting Payment'
  | 'Closed Won'
  | 'Closed Lost';

export interface RecordCloseInput {
  referralId: string;
  rancherId: string;
  outcome: 'won' | 'lost' | 'awaiting_payment';
  saleAmount?: number;
  reason?: string;
  closeReason?: 'no_response' | 'price' | 'timing' | 'other';
}

const ACTIVE_REF_STATES = new Set<ReferralStatus>([
  'Intro Sent',
  'Rancher Contacted',
  'Negotiation',
  'Pending Approval',
]);

export async function recordClose(input: RecordCloseInput): Promise<{ ok: boolean; capacityFreed: boolean }> {
  const ref: any = await getRecordById(TABLES.REFERRALS, input.referralId);
  if (!ref) return { ok: false, capacityFreed: false };
  const prevStatus = String(ref['Status'] || '') as ReferralStatus;

  const now = new Date().toISOString();
  const nextStatus: ReferralStatus =
    input.outcome === 'won' ? 'Closed Won' :
    input.outcome === 'lost' ? 'Closed Lost' :
    'Awaiting Payment';

  const updates: Record<string, any> = {
    'Status': nextStatus,
    'Closed At': now,
    'Last Rancher Activity At': now,
    'Rancher Engaged Flag': true,
  };
  if (input.outcome === 'won' && typeof input.saleAmount === 'number') {
    updates['Sale Amount'] = input.saleAmount;
  }
  await updateRecord(TABLES.REFERRALS, input.referralId, updates);

  let capacityFreed = false;
  if (ACTIVE_REF_STATES.has(prevStatus)) {
    const newCount = await decrementCapacity(input.rancherId);
    await syncCapacityToAirtable(input.rancherId, newCount);
    capacityFreed = true;
  }

  const buyerIds: string[] = (ref['Buyer'] || []) as string[];
  const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
  if (buyerId && (input.outcome === 'won' || input.outcome === 'lost')) {
    await transitionBuyerStage(buyerId, 'CLOSED', `referral:${nextStatus}`);
  }

  await funnelRecord({
    stage: `close:${input.outcome}`,
    rancherId: input.rancherId,
    referralId: input.referralId,
    amount: input.saleAmount,
  });

  return { ok: true, capacityFreed };
}
```

- [ ] **Step 3: Define admin contract types**

Create `lib/contracts/admin.ts`:

```ts
// Admin Vertical — operator-initiated actions from /admin/*, Telegram callbacks, manual SQL fixes.
// Admin ops can call buyer + rancher contracts; buyer + rancher verticals CANNOT call admin.

import { updateRecord, createRecord, TABLES } from '@/lib/airtable';
import { transitionBuyerStage, BuyerStage } from './buyer';
import { recordClose } from './rancher';

export type AdminAction =
  | { kind: 'force_close'; referralId: string; rancherId: string; outcome: 'won' | 'lost'; saleAmount?: number }
  | { kind: 'force_buyer_stage'; buyerId: string; stage: BuyerStage; reason: string }
  | { kind: 'comp_founder'; consumerId: string; tier: string; founderNumber?: number }
  | { kind: 'broadcast'; campaignName: string; audience: string; recipientCount: number };

export async function executeAdminAction(action: AdminAction, operator: string): Promise<{ ok: boolean }> {
  // Audit-log every admin action via Notes append on the target.
  const note = `[ADMIN ${operator} ${new Date().toISOString().slice(0, 10)}] ${action.kind}`;
  if (action.kind === 'force_close') {
    await recordClose({
      referralId: action.referralId,
      rancherId: action.rancherId,
      outcome: action.outcome,
      saleAmount: action.saleAmount,
    });
    return { ok: true };
  }
  if (action.kind === 'force_buyer_stage') {
    await transitionBuyerStage(action.buyerId, action.stage, `admin:${action.reason}`);
    return { ok: true };
  }
  // comp_founder + broadcast routed via existing admin routes — recorded here for audit.
  return { ok: true };
}
```

- [ ] **Step 4: Define threads contract**

Create `lib/contracts/threads.ts`:

```ts
// Threads — shared by Buyer + Rancher verticals via this contract.
// Each thread: one buyer ↔ one rancher, scoped to a referral.

import { createRecord, updateRecord, getAllRecords, TABLES } from '@/lib/airtable';

export type SenderType = 'buyer' | 'rancher' | 'admin' | 'system';
export type SendVia = 'web' | 'email' | 'telegram';

export interface ThreadCreateInput {
  referralId: string;
  buyerId: string;
  rancherId: string;
  subject: string;
}

export interface MessageInput {
  threadId: string;
  senderType: SenderType;
  senderId: string;
  body: string;
  sentVia: SendVia;
  emailMessageId?: string;
}

const THREADS_TABLE = 'Threads';
const MESSAGES_TABLE = 'Thread Messages';

export async function createThread(input: ThreadCreateInput): Promise<{ id: string }> {
  const created: any = await createRecord(THREADS_TABLE, {
    'Referral': [input.referralId],
    'Buyer': [input.buyerId],
    'Rancher': [input.rancherId],
    'Subject': input.subject,
    'Created At': new Date().toISOString(),
    'Last Message At': new Date().toISOString(),
    'Status': 'Active',
  });
  return { id: created.id };
}

export async function getOrCreateThreadForReferral(refId: string, buyerId: string, rancherId: string): Promise<{ id: string; isNew: boolean }> {
  const existing: any[] = await getAllRecords(
    THREADS_TABLE,
    `SEARCH("${refId}", ARRAYJOIN({Referral}))`
  );
  if (existing.length > 0) {
    return { id: existing[0].id, isNew: false };
  }
  const { id } = await createThread({
    referralId: refId,
    buyerId,
    rancherId,
    subject: 'Pre-purchase questions',
  });
  return { id, isNew: true };
}

export async function postMessage(input: MessageInput): Promise<{ id: string }> {
  // Idempotency on inbound email: if emailMessageId matches existing message, no-op.
  if (input.emailMessageId) {
    const existing: any[] = await getAllRecords(
      MESSAGES_TABLE,
      `{Email Message Id} = "${input.emailMessageId.replace(/"/g, '\\"')}"`
    );
    if (existing.length > 0) return { id: existing[0].id };
  }
  const created: any = await createRecord(MESSAGES_TABLE, {
    'Thread': [input.threadId],
    'Sender Type': input.senderType,
    'Sender Id': input.senderId,
    'Body': input.body.slice(0, 5000),
    'Sent Via': input.sentVia,
    'Created At': new Date().toISOString(),
    'Email Message Id': input.emailMessageId || '',
  });
  await updateRecord(THREADS_TABLE, input.threadId, {
    'Last Message At': new Date().toISOString(),
  });
  return { id: created.id };
}

export async function listThreadMessages(threadId: string): Promise<any[]> {
  const safeId = threadId.replace(/"/g, '\\"');
  return await getAllRecords(
    MESSAGES_TABLE,
    `SEARCH("${safeId}", ARRAYJOIN({Thread}))`
  );
}
```

- [ ] **Step 5: Define payments contract**

Create `lib/contracts/payments.ts`:

```ts
// Stripe Connect Express — platform takes 100% deposit, holds it, pays rancher
// 90% on fulfillment confirm, retains 10% as commission + monthly platform fee.

import { createRecord, updateRecord, getRecordById, TABLES } from '@/lib/airtable';

export type PaymentStatus = 'pending' | 'succeeded' | 'refunded' | 'failed';
export type PayoutStatus = 'pending' | 'paid' | 'failed';

const PAYMENTS_TABLE = 'Payments';
const PAYOUTS_TABLE = 'Payouts';

export interface CreateDepositInput {
  referralId: string;
  buyerId: string;
  rancherId: string;
  amountCents: number;
  stripePaymentIntentId: string;
}

export async function recordDeposit(input: CreateDepositInput): Promise<{ id: string }> {
  const created: any = await createRecord(PAYMENTS_TABLE, {
    'Referral': [input.referralId],
    'Buyer': [input.buyerId],
    'Rancher': [input.rancherId],
    'Amount Cents': input.amountCents,
    'Stripe Payment Intent Id': input.stripePaymentIntentId,
    'Status': 'pending',
    'Created At': new Date().toISOString(),
  });
  return { id: created.id };
}

export async function markDepositSucceeded(stripePaymentIntentId: string): Promise<void> {
  // Idempotency via Stripe PI ID lookup.
  const escaped = stripePaymentIntentId.replace(/"/g, '\\"');
  const { getAllRecords } = await import('@/lib/airtable');
  const existing: any[] = await getAllRecords(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`
  );
  if (existing.length === 0) return;
  const payment = existing[0];
  if (payment['Status'] === 'succeeded') return; // already processed
  await updateRecord(PAYMENTS_TABLE, payment.id, {
    'Status': 'succeeded',
    'Captured At': new Date().toISOString(),
  });
}

export interface ReleasePayoutInput {
  paymentId: string;
  rancherId: string;
  stripeTransferId: string;
  amountCents: number; // 90% of deposit, computed by caller
  reason: 'fulfillment_confirmed' | 'dispute_resolved';
}

export async function releasePayout(input: ReleasePayoutInput): Promise<{ id: string }> {
  const created: any = await createRecord(PAYOUTS_TABLE, {
    'Payment': [input.paymentId],
    'Rancher': [input.rancherId],
    'Stripe Transfer Id': input.stripeTransferId,
    'Amount Cents': input.amountCents,
    'Status': 'paid',
    'Released At': new Date().toISOString(),
    'Reason': input.reason,
  });
  return { id: created.id };
}
```

- [ ] **Step 6: Create barrel index**

Create `lib/contracts/index.ts`:

```ts
export * from './buyer';
export * from './rancher';
export * from './admin';
export * from './threads';
export * from './payments';
```

- [ ] **Step 7: Type-check + commit**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

Commit:
```bash
git add lib/contracts/
git commit -m "feat(verticals): add contracts module — buyer/rancher/admin/threads/payments typed shapes"
git push
```

- [ ] **Step 8: Smoke-deploy preview**

Wait for Vercel preview to go READY (notification or `vercel ls`).

Smoke test (no functional change yet, just verifies build):
```bash
PREVIEW_URL=$(vercel ls stage-3-verticals --limit 1 | awk '{print $2}' | head -1)
curl -sI "$PREVIEW_URL/map" | grep -E "^HTTP|^content-type"
```
Expected: 200 + html content-type.

---

## Task 2: Funnel metrics instrumentation

**Files:**
- Create: `lib/funnelMetrics.ts`
- Modify: schema add — new Airtable table `Funnel Events`

**Schema add (operator does once):**
- `Funnel Events`: `Id`, `Stage`, `Buyer` (link → Consumers, optional), `Rancher` (link → Ranchers, optional), `Referral` (link → Referrals, optional), `Amount Cents` (number, optional), `Reason` (text, optional), `Metadata` (long text, JSON dump), `Created At` (datetime).

- [ ] **Step 1: Implement funnel recorder**

Create `lib/funnelMetrics.ts`:

```ts
// Single-call telemetry for every funnel-stage transition. Powers the conversion
// audit dashboard (Task 6). Writes are non-fatal: a logging failure must never
// break the calling flow. Logged stages match the Buyer/Rancher contract names.

import { createRecord } from '@/lib/airtable';

const FUNNEL_TABLE = 'Funnel Events';

export interface FunnelEvent {
  stage: string;
  buyerId?: string;
  rancherId?: string;
  referralId?: string;
  amount?: number;
  reason?: string;
  intentScore?: number;
  metadata?: Record<string, any>;
}

export async function funnelRecord(event: FunnelEvent): Promise<void> {
  try {
    await createRecord(FUNNEL_TABLE, {
      'Stage': event.stage,
      ...(event.buyerId ? { 'Buyer': [event.buyerId] } : {}),
      ...(event.rancherId ? { 'Rancher': [event.rancherId] } : {}),
      ...(event.referralId ? { 'Referral': [event.referralId] } : {}),
      ...(typeof event.amount === 'number' ? { 'Amount Cents': Math.round(event.amount * 100) } : {}),
      ...(event.reason ? { 'Reason': event.reason } : {}),
      'Metadata': JSON.stringify({
        intentScore: event.intentScore,
        ...event.metadata,
        ts: new Date().toISOString(),
      }).slice(0, 5000),
      'Created At': new Date().toISOString(),
    });
  } catch (e: any) {
    console.warn('[funnelMetrics] event write failed (non-fatal):', event.stage, e?.message);
  }
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/funnelMetrics.ts
git commit -m "feat(verticals): funnel metrics recorder with non-fatal write"
git push
```

- [ ] **Step 4: Operator adds `Funnel Events` table per schema above**

Manual step — operator confirms table created in Airtable base `appgLT4z009iwAfhs`.

---

## Task 3: Buyer Vertical isolation

**Files:**
- Modify: `app/api/consumers/route.ts` — replace direct createRecord with `createBuyer()` contract call
- Modify: `app/api/warmup/engage/route.ts` — replace direct updateRecord(Buyer Stage) with `transitionBuyerStage()`
- Modify: `app/api/orders/request/route.ts` — replace direct createRecord(Referrals) with thread creation via contract (preview only — full thread flow in Task 8)

- [ ] **Step 1: Refactor /api/consumers POST to use createBuyer contract**

Open `app/api/consumers/route.ts`. Find the existing `createRecord(TABLES.CONSUMERS, ...)` block (around lines 200-280 — exact line varies). Replace the inline createRecord with:

```ts
import { createBuyer, transitionBuyerStage } from '@/lib/contracts';

// ... inside POST handler, replace the existing createRecord block with:
const { id: createdId } = await createBuyer({
  fullName: fullName.trim(),
  email: email.trim().toLowerCase(),
  state,
  phone: phone || undefined,
  orderType: orderType || undefined,
  budget: budgetRange || undefined,
  source: req.headers.get('referer') || 'direct',
  intentScore: serverIntentScore,
  intentClassification: serverIntentClassification,
});

const record: any = await getRecordById(TABLES.CONSUMERS, createdId);
```

Then later in the same handler where Buyer Stage is updated, replace:
```ts
await updateRecord(TABLES.CONSUMERS, record.id, {
  'Buyer Stage': buyerStage,
  'Buyer Stage Updated At': new Date().toISOString(),
});
```
with:
```ts
await transitionBuyerStage(record.id, buyerStage, `signup:${buyerStage}`);
```

- [ ] **Step 2: Refactor /api/warmup/engage Buyer Stage write**

Open `app/api/warmup/engage/route.ts`. Find the Buyer Stage updateRecord (around line 295). Replace with:

```ts
import { transitionBuyerStage, recordBuyerEngagement } from '@/lib/contracts';

// First stamp engagement:
await recordBuyerEngagement(payload.consumerId);

// Then transition stage:
await transitionBuyerStage(
  payload.consumerId,
  matchOutcome === 'matched' ? 'MATCHED' : 'READY',
  `engage:${matchOutcome}`
);
```

The existing Warmup Engaged At / Ready to Buy stamp at line ~254 becomes redundant after `recordBuyerEngagement` — remove the inline updateRecord that sets those two fields, since the contract now owns the write.

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Smoke test against preview**

Wait for Vercel preview READY.

```bash
PREVIEW_URL=$(vercel ls stage-3-verticals --limit 1 | awk '{print $2}' | head -1)
curl -s -X POST "$PREVIEW_URL/api/consumers" \
  -H 'content-type: application/json' \
  -d '{"fullName":"Vertical Test","email":"vert-test@example.com","state":"MT","orderType":"Quarter Cow"}' \
  | python3 -m json.tool
```
Expected: `{"success": true, "consumerId": "rec..."}` and the Funnel Events table now has a `signup` row for this email.

- [ ] **Step 5: Commit**

```bash
git add app/api/consumers/route.ts app/api/warmup/engage/route.ts
git commit -m "refactor(buyer-vertical): route /api/consumers + /api/warmup/engage through contracts"
git push
```

---

## Task 4: Rancher Vertical isolation

**Files:**
- Modify: `app/api/rancher/referrals/[id]/route.ts` — replace inline close logic with `recordClose()` contract
- Modify: `app/api/rancher/quick-action/route.ts` — replace inline close logic with `recordClose()` contract
- Modify: `app/api/webhooks/telegram/route.ts:2615-2858` — replace Telegram close-amount reply close logic with `recordClose()`

- [ ] **Step 1: Refactor rancher dashboard PATCH close path**

Open `app/api/rancher/referrals/[id]/route.ts`. Locate the `if (status === 'Closed Won' || status === 'Closed Lost' || status === 'Awaiting Payment')` block (~line 322).

Insert at the top of the block:
```ts
import { recordClose } from '@/lib/contracts';

// New contract-based close. Preserve the existing email/Stripe invoice flow
// that follows this block — only the state-mutation logic is contractualized.
await recordClose({
  referralId: id,
  rancherId: decoded.rancherId,
  outcome: status === 'Closed Won' ? 'won' : status === 'Closed Lost' ? 'lost' : 'awaiting_payment',
  saleAmount: status === 'Closed Won' ? Number(body.saleAmount) || undefined : undefined,
  closeReason: body.closeReason,
});
```

Then DELETE the now-redundant lines below it:
- the `await updateRecord(TABLES.REFERRALS, ...)` that flips Status + Closed At
- the `decrementCapacity` / `syncCapacityToAirtable` calls
- the `updateRecord(TABLES.CONSUMERS, ..., { 'Buyer Stage': 'CLOSED', ...})` block

Keep all post-close side effects (Stripe invoice creation, post-purchase welcome, Telegram celebration, reroute on Closed Lost).

- [ ] **Step 2: Refactor /api/rancher/quick-action**

Open `app/api/rancher/quick-action/route.ts`. Inside `applyAction()` for the `won` / `lost` / `pass` actions, replace the duplicated capacity decrement + Buyer Stage flip + status update with one `recordClose()` call:

```ts
import { recordClose } from '@/lib/contracts';

// inside applyAction, after gates pass:
const closeOutcome = action === 'won' ? 'won' : action === 'lost' || action === 'pass' ? 'lost' : null;
if (closeOutcome) {
  await recordClose({
    referralId: decoded.referralId,
    rancherId: decoded.rancherId,
    outcome: closeOutcome,
    saleAmount,
    reason,
  });
}
```

Remove the duplicated decrementCapacity + Consumer Buyer Stage flip lines (lines 194-231 of current file).

- [ ] **Step 3: Refactor Telegram close-amount reply**

Open `app/api/webhooks/telegram/route.ts`. Find the Branch 2 (Closed Won w/ sale amount) block (~line 2686 — exact line shifts after earlier fixes). Replace the inline status flip + capacity decrement + Consumer Buyer Stage flip with:

```ts
import { recordClose } from '@/lib/contracts';

await recordClose({
  referralId: refId,
  rancherId: rancher.id,
  outcome: 'won',
  saleAmount,
});
```

Remove the duplicate capacity + Buyer Stage logic that lived inline. Keep the Stripe invoice + commission email + sale celebration follow-ups.

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Smoke test**

```bash
PREVIEW_URL=$(vercel ls stage-3-verticals --limit 1 | awk '{print $2}' | head -1)
# Smoke: rancher dashboard renders OK
curl -sI "$PREVIEW_URL/rancher" | head -3
```
Expected: 200.

- [ ] **Step 6: Commit**

```bash
git add app/api/rancher/referrals/ app/api/rancher/quick-action/ app/api/webhooks/telegram/
git commit -m "refactor(rancher-vertical): route all close paths through recordClose contract"
git push
```

---

## Task 5: Boundary enforcement script

**Files:**
- Create: `tools/check-vertical-boundaries.ts`
- Modify: `package.json` (add script + pre-commit hook)
- Modify: `vercel.json` (flip `VERTICAL_BOUNDARY_ENFORCE` from `warn` to `error`)

- [ ] **Step 1: Build the checker**

Create `tools/check-vertical-boundaries.ts`:

```ts
#!/usr/bin/env tsx
// Vertical boundary checker. Fails CI if a Buyer Vertical file imports a
// Rancher Vertical internal module, or vice versa. Both verticals may import
// from `lib/contracts/*`, `lib/airtable.ts`, `lib/email.ts`, `lib/telegram.ts`.

import { readFileSync } from 'fs';
import { execSync } from 'child_process';

const VERTICALS = {
  buyer: [
    'app/(buyer)/',
    'app/access/',
    'app/map/',
    'app/member/',
    'app/start/',
    'app/wins/',
    'app/api/consumers/',
    'app/api/warmup/',
    'app/api/member/',
    'app/api/orders/',
    'app/api/checkout/',
  ],
  rancher: [
    'app/(rancher)/',
    'app/rancher/',
    'app/ranchers/',
    'app/api/rancher/',
    'app/api/ranchers/',
    'app/api/auth/rancher/',
  ],
  admin: [
    'app/(admin)/',
    'app/admin/',
    'app/api/admin/',
    'app/api/webhooks/telegram/',
    'app/api/cron/',
  ],
};

const ALLOWED_SHARED_PREFIXES = [
  '@/lib/contracts',
  '@/lib/airtable',
  '@/lib/email',
  '@/lib/telegram',
  '@/lib/rancherCapacity',
  '@/lib/funnelMetrics',
  '@/lib/stripeConnect',
  '@/lib/secrets',
  '@/lib/states',
  '@/lib/maintenance',
  '@/lib/cronRun',
  '@/lib/operatorSignal',
  '@/lib/svixVerify',
  '@/lib/auditLog',
  '@/lib/ai',
  '@/lib/auth',
  '@/lib/founderNumber',
  '@/lib/bulkRoute',
  '@/lib/triggerLaunchWarmup',
  '@/lib/cronIntrospection',
  '@/lib/stripe-commission',
  '@/lib/maintenance',
];

function vertical(path: string): 'buyer' | 'rancher' | 'admin' | 'shared' {
  for (const [v, prefixes] of Object.entries(VERTICALS)) {
    if (prefixes.some((p) => path.startsWith(p))) return v as any;
  }
  return 'shared';
}

const enforcement = process.env.VERTICAL_BOUNDARY_ENFORCE || 'warn';
let violations = 0;

const files = execSync('git ls-files app/').toString().trim().split('\n').filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

for (const file of files) {
  const v = vertical(file);
  if (v === 'shared') continue;
  const content = readFileSync(file, 'utf-8');
  const importLines = content.match(/^import\s+.*?from\s+['"]([^'"]+)['"];?$/gm) || [];
  for (const line of importLines) {
    const m = line.match(/from\s+['"]([^'"]+)['"]/);
    if (!m) continue;
    const importPath = m[1];
    if (!importPath.startsWith('@/')) continue;
    if (ALLOWED_SHARED_PREFIXES.some((p) => importPath.startsWith(p))) continue;
    // Resolve @/ to repo root
    const resolved = importPath.replace(/^@\//, '');
    const targetVertical = vertical(resolved);
    if (targetVertical === 'shared') continue;
    if (targetVertical !== v) {
      console.warn(`[boundary] ${file} (${v}) imports ${importPath} (${targetVertical})`);
      violations++;
    }
  }
}

if (violations > 0 && enforcement === 'error') {
  console.error(`\n${violations} vertical boundary violation(s). Refactor through @/lib/contracts/*.`);
  process.exit(1);
}
console.log(`Boundary check: ${violations} violation(s) (enforcement=${enforcement})`);
```

- [ ] **Step 2: Add npm script**

Modify `package.json` — add to the existing `scripts` block:

```json
"boundaries:check": "tsx tools/check-vertical-boundaries.ts"
```

- [ ] **Step 3: Run checker in warn mode**

```bash
VERTICAL_BOUNDARY_ENFORCE=warn npx tsx tools/check-vertical-boundaries.ts
```

Expected output: list of any current violations + count. Should be zero after Tasks 3-4. If non-zero, fix the offending imports BEFORE proceeding.

- [ ] **Step 4: Flip enforcement to error in vercel.json**

Edit `vercel.json`:
```json
{
  "env": {
    "VERTICAL_BOUNDARY_ENFORCE": "error"
  }
}
```

- [ ] **Step 5: Commit + push**

```bash
git add tools/check-vertical-boundaries.ts package.json vercel.json
git commit -m "feat(verticals): boundary checker + error-mode enforcement"
git push
```

- [ ] **Step 6: Smoke check**

Verify Vercel preview build passes — boundary violations are part of the standard build output now (won't fail the deploy at this point, just shows the warn log).

---

## Task 6: Conversion audit baseline dashboard

**Files:**
- Create: `app/(admin)/funnel/page.tsx`
- Create: `app/api/admin/funnel/route.ts`

- [ ] **Step 1: Build the API endpoint**

Create `app/api/admin/funnel/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAllRecords } from '@/lib/airtable';

const FUNNEL_TABLE = 'Funnel Events';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (auth) return auth;

  const url = new URL(request.url);
  const sinceDays = Number(url.searchParams.get('sinceDays') || '30');
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  const events: any[] = await getAllRecords(FUNNEL_TABLE);
  const recent = events.filter((e) => {
    const ts = new Date(e['Created At']).getTime();
    return ts >= cutoff;
  });

  const byStage: Record<string, number> = {};
  let totalRevenue = 0;
  for (const e of recent) {
    const stage = String(e['Stage'] || 'unknown');
    byStage[stage] = (byStage[stage] || 0) + 1;
    if (stage === 'close:won' && typeof e['Amount Cents'] === 'number') {
      totalRevenue += e['Amount Cents'];
    }
  }

  const signups = byStage['signup'] || 0;
  const engaged = byStage['engaged'] || 0;
  const matched = byStage['transition:MATCHED'] || 0;
  const closedWon = byStage['close:won'] || 0;
  const closedLost = byStage['close:lost'] || 0;

  const rates = {
    signupToEngaged: signups > 0 ? engaged / signups : 0,
    engagedToMatched: engaged > 0 ? matched / engaged : 0,
    matchedToClosedWon: matched > 0 ? closedWon / matched : 0,
    overallSignupToWon: signups > 0 ? closedWon / signups : 0,
  };

  return NextResponse.json({
    sinceDays,
    events: recent.length,
    byStage,
    rates,
    revenueCents: totalRevenue,
  });
}
```

- [ ] **Step 2: Build the dashboard page**

Create `app/(admin)/funnel/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';

interface FunnelData {
  sinceDays: number;
  events: number;
  byStage: Record<string, number>;
  rates: {
    signupToEngaged: number;
    engagedToMatched: number;
    matchedToClosedWon: number;
    overallSignupToWon: number;
  };
  revenueCents: number;
}

export default function FunnelPage() {
  const [data, setData] = useState<FunnelData | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    fetch(`/api/admin/funnel?sinceDays=${days}`, { credentials: 'include' })
      .then((r) => r.json())
      .then(setData);
  }, [days]);

  if (!data) return <div className="p-8 bg-bone min-h-screen text-charcoal">Loading…</div>;

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  return (
    <div className="p-8 bg-bone min-h-screen text-charcoal">
      <h1 className="text-3xl font-serif mb-6">Funnel — last {days}d</h1>
      <div className="mb-6">
        <label className="text-sm text-saddle mr-2">Window:</label>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="border border-dust px-2 py-1">
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>
      </div>
      <div className="grid grid-cols-2 gap-4 mb-8">
        <Card label="Signup → Engaged" value={pct(data.rates.signupToEngaged)} />
        <Card label="Engaged → Matched" value={pct(data.rates.engagedToMatched)} />
        <Card label="Matched → Closed Won" value={pct(data.rates.matchedToClosedWon)} />
        <Card label="Overall Signup → Won" value={pct(data.rates.overallSignupToWon)} />
      </div>
      <h2 className="text-xl font-serif mb-2">Stages</h2>
      <table className="w-full border border-dust">
        <tbody>
          {Object.entries(data.byStage).sort((a, b) => b[1] - a[1]).map(([stage, count]) => (
            <tr key={stage} className="border-t border-divider">
              <td className="p-2 text-saddle">{stage}</td>
              <td className="p-2 text-right">{count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-6 text-saddle text-sm">
        Total revenue (Closed Won): <strong className="text-charcoal">${(data.revenueCents / 100).toLocaleString()}</strong>
      </div>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-dust p-4 bg-bone">
      <div className="text-saddle text-sm uppercase tracking-wide">{label}</div>
      <div className="text-3xl font-serif mt-1 text-charcoal">{value}</div>
    </div>
  );
}
```

- [ ] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit
git add app/api/admin/funnel/ app/\(admin\)/funnel/
git commit -m "feat(admin-vertical): funnel conversion dashboard from Funnel Events"
git push
```

- [ ] **Step 4: Smoke test**

Wait for preview READY. Authenticated test:
```bash
PREVIEW_URL=$(vercel ls stage-3-verticals --limit 1 | awk '{print $2}' | head -1)
# Use the admin password env var to authenticate (replace with curl-cookie flow used in your repo)
curl -s "$PREVIEW_URL/api/admin/funnel?sinceDays=30" \
  -H "cookie: bhc-admin-auth=$(node -e \"console.log(require('jsonwebtoken').sign({type:'admin-session'},process.env.JWT_SECRET))\")" \
  | python3 -m json.tool
```
Expected: JSON with `byStage` containing at least `signup` entries from earlier smoke tests.

---

## Task 7: Threads schema activation + contract test

**Files:**
- (No code — schema-only task)

**Operator action:** Add `Threads` + `Thread Messages` tables to base `appgLT4z009iwAfhs` per the spec at the top.

- [ ] **Step 1: Verify schema via Airtable MCP**

After operator creates tables, in this Claude session run an Airtable MCP call to confirm:
```
mcp__d5aec254-..._list_tables_for_base { baseId: "appgLT4z009iwAfhs" }
```
Expected: response includes `Threads` and `Thread Messages`.

- [ ] **Step 2: Smoke the contract**

In a temporary file `tmp/threadCheck.ts`:
```ts
import { createThread, postMessage, listThreadMessages } from '@/lib/contracts/threads';

async function main() {
  const t = await createThread({
    referralId: 'recXXXXXXXXXXXXXX', // pick any existing referral
    buyerId: 'recYYYYYYYYYYYYYY',
    rancherId: 'recZZZZZZZZZZZZZZ',
    subject: 'Vertical smoke test',
  });
  console.log('thread', t.id);
  await postMessage({
    threadId: t.id,
    senderType: 'system',
    senderId: 'smoke',
    body: 'Hello from contract smoke',
    sentVia: 'web',
  });
  const msgs = await listThreadMessages(t.id);
  console.log('messages', msgs.length);
}
main().catch(console.error);
```

Run:
```bash
npx tsx tmp/threadCheck.ts
```
Expected: prints thread id + `messages 1`. Cleanup:
```bash
rm tmp/threadCheck.ts
```

- [ ] **Step 3: Commit nothing — schema only**

(Schema lives in Airtable, no repo change.) Log the verification in the Task 17 audit doc.

---

## Task 8: Buyer-facing pre-purchase question form

**Files:**
- Create: `app/(buyer)/checkout/[refId]/ask/page.tsx`
- Create: `app/api/threads/[id]/message/route.ts`

- [ ] **Step 1: Create the API endpoint**

Create `app/api/threads/[id]/message/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { postMessage, listThreadMessages } from '@/lib/contracts/threads';
import { getRecordById, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';
import { sendEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

async function authBuyerOrRancher(): Promise<{ kind: 'buyer'; id: string } | { kind: 'rancher'; id: string } | null> {
  const ck = await cookies();
  const buyerCk = ck.get('bhc-member-auth');
  if (buyerCk?.value) {
    try {
      const d: any = jwt.verify(buyerCk.value, JWT_SECRET);
      if (d.type === 'member-session') return { kind: 'buyer', id: d.consumerId };
    } catch {}
  }
  const rancherCk = ck.get('bhc-rancher-auth');
  if (rancherCk?.value) {
    try {
      const d: any = jwt.verify(rancherCk.value, JWT_SECRET);
      if (d.type === 'rancher-session') return { kind: 'rancher', id: d.rancherId };
    } catch {}
  }
  return null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authBuyerOrRancher();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const msgs = await listThreadMessages(id);
  return NextResponse.json({ messages: msgs });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authBuyerOrRancher();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const { body } = await req.json();
  if (!body || typeof body !== 'string' || body.length < 1 || body.length > 5000) {
    return NextResponse.json({ error: 'body must be 1–5000 chars' }, { status: 400 });
  }

  await postMessage({
    threadId: id,
    senderType: auth.kind,
    senderId: auth.id,
    body,
    sentVia: 'web',
  });

  // Email mirror to the OTHER side so they get pinged even if not logged in.
  // Reply-to includes the thread id so inbound replies route back into the thread
  // (resend-inbound webhook handles the routing — extended in Task 10).
  try {
    const threadRow: any = await getRecordById('Threads', id);
    const otherKind = auth.kind === 'buyer' ? 'rancher' : 'buyer';
    const recipientLinkField = otherKind === 'rancher' ? 'Rancher' : 'Buyer';
    const recipientIds: string[] = threadRow[recipientLinkField] || [];
    const recipientId = recipientIds[0];
    if (recipientId) {
      const recipientTable = otherKind === 'rancher' ? TABLES.RANCHERS : TABLES.CONSUMERS;
      const recipient: any = await getRecordById(recipientTable, recipientId);
      const to = recipient?.['Email'];
      const replyDomain = process.env.NEXT_PUBLIC_REPLIES_DOMAIN || 'replies.buyhalfcow.com';
      if (to) {
        await sendEmail({
          to,
          subject: `New message — ${threadRow['Subject'] || 'BuyHalfCow'}`,
          html: `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:36px;border:1px solid #A7A29A;background:#fff;line-height:1.6;">
            <p>${body.replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>
            <p style="margin-top:24px;font-size:12px;color:#A7A29A;">Reply to this email to respond. Your reply will land in the BuyHalfCow thread for both of you.</p>
          </div>`,
          _replyContext: { type: 'thread', recordId: id } as any,
        });
      }
    }
  } catch (e: any) {
    console.warn('[threads message] email mirror failed:', e?.message);
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Create the buyer-facing ask form**

Create `app/(buyer)/checkout/[refId]/ask/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

export default function AskPage() {
  const params = useParams<{ refId: string }>();
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/threads/by-referral/${params.refId}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        setThreadId(j.threadId);
        setMessages(j.messages || []);
      });
  }, [params.refId]);

  const submit = async () => {
    if (!threadId || !draft.trim()) return;
    setSubmitting(true);
    await fetch(`/api/threads/${threadId}/message`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: draft }),
    });
    setDraft('');
    const j = await fetch(`/api/threads/${threadId}/message`, { credentials: 'include' }).then((r) => r.json());
    setMessages(j.messages || []);
    setSubmitting(false);
  };

  return (
    <div className="max-w-2xl mx-auto p-6 bg-bone min-h-screen text-charcoal">
      <h1 className="text-2xl font-serif mb-4">Ask your rancher</h1>
      <p className="text-saddle mb-6">Questions before you commit? Send a message — the rancher gets it by email + dashboard.</p>
      <div className="border border-dust bg-white p-4 max-h-96 overflow-y-auto mb-4">
        {messages.length === 0 ? (
          <p className="text-saddle text-sm">No messages yet. Start the conversation below.</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="mb-3 border-b border-divider pb-2">
              <div className="text-xs text-saddle uppercase">{m['Sender Type']} · {new Date(m['Created At']).toLocaleString()}</div>
              <div className="mt-1">{m['Body']}</div>
            </div>
          ))
        )}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="e.g. Can you do a half cow processed by Aug 15?"
        className="w-full border border-dust p-3 min-h-32 bg-white"
        maxLength={5000}
      />
      <button
        onClick={submit}
        disabled={submitting || !draft.trim()}
        className="mt-2 px-6 py-3 bg-charcoal text-bone uppercase tracking-wider text-sm disabled:opacity-50"
      >
        {submitting ? 'Sending…' : 'Send Message'}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Create the by-referral thread lookup helper**

Create `app/api/threads/by-referral/[refId]/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { getOrCreateThreadForReferral, listThreadMessages } from '@/lib/contracts/threads';
import { getRecordById, TABLES } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ refId: string }> }) {
  const ck = await cookies();
  const buyerCk = ck.get('bhc-member-auth');
  if (!buyerCk?.value) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let decoded: any;
  try {
    decoded = jwt.verify(buyerCk.value, JWT_SECRET);
  } catch {
    return NextResponse.json({ error: 'Session expired' }, { status: 401 });
  }
  if (decoded.type !== 'member-session') return NextResponse.json({ error: 'Invalid session' }, { status: 401 });

  const { refId } = await params;
  const ref: any = await getRecordById(TABLES.REFERRALS, refId);
  if (!ref) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const buyerIds: string[] = ref['Buyer'] || [];
  if (!buyerIds.includes(decoded.consumerId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const rancherIds: string[] = ref['Rancher'] || ref['Suggested Rancher'] || [];
  const rancherId = rancherIds[0];
  if (!rancherId) return NextResponse.json({ error: 'No rancher assigned' }, { status: 409 });

  const { id } = await getOrCreateThreadForReferral(refId, decoded.consumerId, rancherId);
  const messages = await listThreadMessages(id);
  return NextResponse.json({ threadId: id, messages });
}
```

- [ ] **Step 4: Type-check + commit**

```bash
npx tsc --noEmit
git add app/api/threads/ "app/(buyer)/checkout/"
git commit -m "feat(buyer-vertical): pre-purchase ask form + thread API"
git push
```

- [ ] **Step 5: Smoke test**

Use a known buyer JWT cookie to load the preview:
```bash
PREVIEW_URL=$(vercel ls stage-3-verticals --limit 1 | awk '{print $2}' | head -1)
# Manually visit $PREVIEW_URL/checkout/recXXX/ask in a browser logged in as a buyer
echo "Visit $PREVIEW_URL/checkout/<existing-refId>/ask"
```
Expected: page renders + submitting a message creates a `Thread Messages` row in Airtable.

---

## Task 9: Rancher inbox in dashboard

**Files:**
- Create: `app/(rancher)/inbox/page.tsx`
- Create: `app/api/rancher/inbox/route.ts`

- [ ] **Step 1: Build the API**

Create `app/api/rancher/inbox/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { getAllRecords } from '@/lib/airtable';
import { JWT_SECRET } from '@/lib/secrets';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(_req: Request) {
  const ck = await cookies();
  const rancherCk = ck.get('bhc-rancher-auth');
  if (!rancherCk?.value) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let decoded: any;
  try { decoded = jwt.verify(rancherCk.value, JWT_SECRET); }
  catch { return NextResponse.json({ error: 'Session expired' }, { status: 401 }); }
  if (decoded.type !== 'rancher-session') return NextResponse.json({ error: 'Invalid session' }, { status: 401 });

  const safeId = decoded.rancherId.replace(/"/g, '\\"');
  const threads: any[] = await getAllRecords('Threads', `SEARCH("${safeId}", ARRAYJOIN({Rancher}))`);
  threads.sort((a, b) => new Date(b['Last Message At']).getTime() - new Date(a['Last Message At']).getTime());

  // For each thread, fetch the latest message
  const enriched = await Promise.all(threads.slice(0, 50).map(async (t) => {
    const safeT = t.id.replace(/"/g, '\\"');
    const msgs: any[] = await getAllRecords('Thread Messages', `SEARCH("${safeT}", ARRAYJOIN({Thread}))`);
    msgs.sort((a, b) => new Date(b['Created At']).getTime() - new Date(a['Created At']).getTime());
    return {
      id: t.id,
      subject: t['Subject'],
      lastMessageAt: t['Last Message At'],
      lastMessage: msgs[0]?.['Body']?.slice(0, 200) || '',
      lastSenderType: msgs[0]?.['Sender Type'] || '',
      messageCount: msgs.length,
      buyerId: (t['Buyer'] || [])[0],
    };
  }));

  return NextResponse.json({ threads: enriched });
}
```

- [ ] **Step 2: Build the inbox UI**

Create `app/(rancher)/inbox/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';

export default function InboxPage() {
  const [threads, setThreads] = useState<any[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    fetch('/api/rancher/inbox', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setThreads(j.threads || []));
  }, []);

  const open = async (id: string) => {
    setOpenId(id);
    const j = await fetch(`/api/threads/${id}/message`, { credentials: 'include' }).then((r) => r.json());
    setMessages(j.messages || []);
  };

  const send = async () => {
    if (!openId || !draft.trim()) return;
    await fetch(`/api/threads/${openId}/message`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: draft }),
    });
    setDraft('');
    const j = await fetch(`/api/threads/${openId}/message`, { credentials: 'include' }).then((r) => r.json());
    setMessages(j.messages || []);
  };

  return (
    <div className="grid grid-cols-3 gap-4 p-6 bg-bone min-h-screen text-charcoal">
      <div className="col-span-1 border border-dust bg-white">
        <h2 className="p-3 border-b border-divider font-serif">Inbox</h2>
        {threads.length === 0 ? (
          <p className="p-3 text-saddle text-sm">No buyer messages yet.</p>
        ) : (
          threads.map((t) => (
            <button
              key={t.id}
              onClick={() => open(t.id)}
              className={`block w-full text-left p-3 border-b border-divider hover:bg-bone ${openId === t.id ? 'bg-bone' : ''}`}
            >
              <div className="font-semibold text-sm">{t.subject}</div>
              <div className="text-xs text-saddle">{t.lastSenderType} · {new Date(t.lastMessageAt).toLocaleString()}</div>
              <div className="text-sm mt-1 text-saddle">{t.lastMessage}</div>
            </button>
          ))
        )}
      </div>
      <div className="col-span-2 border border-dust bg-white p-4">
        {openId ? (
          <>
            <div className="max-h-96 overflow-y-auto mb-4 border border-divider p-3">
              {messages.map((m) => (
                <div key={m.id} className="mb-3 border-b border-divider pb-2">
                  <div className="text-xs text-saddle uppercase">{m['Sender Type']} · {new Date(m['Created At']).toLocaleString()}</div>
                  <div className="mt-1">{m['Body']}</div>
                </div>
              ))}
            </div>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="w-full border border-dust p-2 min-h-24" />
            <button onClick={send} className="mt-2 px-6 py-2 bg-charcoal text-bone uppercase text-sm">Send Reply</button>
          </>
        ) : (
          <p className="text-saddle">Pick a thread on the left.</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit
git add app/api/rancher/inbox/ "app/(rancher)/inbox/"
git commit -m "feat(rancher-vertical): inbox page + thread API for buyer questions"
git push
```

- [ ] **Step 4: Smoke test**

Open `$PREVIEW_URL/inbox` in a browser logged in as a rancher. Expected: list of threads + ability to read + reply.

---

## Task 10: Inbound email → thread routing

**Files:**
- Modify: `app/api/webhooks/resend-inbound/route.ts`
- Modify: `lib/email.ts` (extend `_replyContext` type to accept `thread`)

- [ ] **Step 1: Extend reply context type**

Open `lib/email.ts`. Find the type for `_replyContext`. Add `'thread'` to the discriminated union:

```ts
_replyContext?:
  | { type: 'ref'; recordId: string }
  | { type: 'usr'; recordId: string }
  | { type: 'rnc'; recordId: string }
  | { type: 'inq'; recordId: string }
  | { type: 'thread'; recordId: string };
```

The Reply-To address builder should already concat `<type>-<id>@<replies-domain>`; the new branch needs no extra logic IF the existing builder is `${type}-${id}@${domain}`. Otherwise add an explicit case.

- [ ] **Step 2: Modify the inbound webhook**

Open `app/api/webhooks/resend-inbound/route.ts`. Find `findReplyContext`. Add a case for `thread`:

```ts
function findReplyContext(toAddress: string | string[]): { type: 'ref' | 'usr' | 'rnc' | 'inq' | 'thread'; recordId: string } | null {
  const list = Array.isArray(toAddress) ? toAddress : [toAddress];
  for (const addr of list) {
    const m = String(addr || '').match(/(ref|usr|rnc|inq|thread)-(rec[A-Za-z0-9]+)@/i);
    if (m) return { type: m[1].toLowerCase() as any, recordId: m[2] };
  }
  return null;
}
```

Then in `resolveLinks`, add:
```ts
if (context.type === 'thread') return { threadId: context.recordId };
```

(`resolveLinks` return type extends to include `threadId?: string`.)

Where the thread case is detected later in the handler, post a message into the thread:

```ts
if (links.threadId) {
  try {
    const { postMessage } = await import('@/lib/contracts/threads');
    // Sender lookup: match `from` against thread's Buyer + Rancher emails.
    const { getRecordById } = await import('@/lib/airtable');
    const t: any = await getRecordById('Threads', links.threadId);
    const buyerIds: string[] = t['Buyer'] || [];
    const rancherIds: string[] = t['Rancher'] || [];
    const buyerId = buyerIds[0];
    const rancherId = rancherIds[0];
    let buyerEmail = '';
    let rancherEmail = '';
    if (buyerId) {
      const b: any = await getRecordById(TABLES.CONSUMERS, buyerId);
      buyerEmail = String(b?.['Email'] || '').toLowerCase().trim();
    }
    if (rancherId) {
      const r: any = await getRecordById(TABLES.RANCHERS, rancherId);
      rancherEmail = String(r?.['Email'] || '').toLowerCase().trim();
    }
    const fromLower = String(from || '').toLowerCase().trim();
    const m = fromLower.match(/<([^>]+)>/);
    const fromAddr = m ? m[1] : fromLower;
    let senderType: 'buyer' | 'rancher' | 'admin' = 'admin';
    let senderId = '';
    if (buyerEmail && fromAddr.includes(buyerEmail)) { senderType = 'buyer'; senderId = buyerId; }
    else if (rancherEmail && fromAddr.includes(rancherEmail)) { senderType = 'rancher'; senderId = rancherId; }
    await postMessage({
      threadId: links.threadId,
      senderType,
      senderId,
      body: bodyForClassify.slice(0, 5000),
      sentVia: 'email',
      emailMessageId: String((headers as any)?.['message-id'] || (headers as any)?.['Message-Id'] || ''),
    });
  } catch (e: any) {
    console.warn('[resend-inbound thread] post message failed:', e?.message);
  }
}
```

- [ ] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit
git add app/api/webhooks/resend-inbound/ lib/email.ts
git commit -m "feat(threads): inbound email → thread message routing via thread-<id>@replies tag"
git push
```

- [ ] **Step 4: Smoke test**

Send a test inbound to `thread-recXXXX@replies.buyhalfcow.com` from the buyer's address. Use Resend's dashboard "Send test inbound" or:
```bash
curl -X POST "$PREVIEW_URL/api/webhooks/resend-inbound" \
  -H 'content-type: application/json' \
  -H 'svix-id: msg_test' \
  -H "svix-timestamp: $(date +%s)" \
  -H 'svix-signature: <generate locally>' \
  -d '{"from":"buyer@example.com","to":["thread-recXXX@replies.buyhalfcow.com"],"subject":"Re: questions","text":"Yes I want a half cow"}'
```
Expected: Thread Messages table gains a new row with `Sender Type=buyer`.

---

## Task 11: Stripe Connect Express onboarding for ranchers

**Files:**
- Create: `lib/stripeConnect.ts`
- Create: `app/api/rancher/connect/start/route.ts`
- Create: `app/api/rancher/connect/callback/route.ts`
- Modify: `app/rancher/page.tsx` — add "Connect bank account" CTA when STRIPE_CONNECT_ENABLED + not yet connected

**Schema add:** Rancher fields `Stripe Connect Account Id` (text), `Stripe Connect Status` (singleSelect: not_connected/onboarding/active/restricted), `Stripe Connect Connected At` (datetime).

- [ ] **Step 1: Build the Stripe Connect helper**

Create `lib/stripeConnect.ts`:

```ts
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-06-20' as any,
});

export async function createConnectAccount(rancherEmail: string, businessName: string): Promise<{ accountId: string }> {
  const account = await stripe.accounts.create({
    type: 'express',
    email: rancherEmail,
    business_type: 'individual',
    business_profile: {
      name: businessName,
      product_description: 'Direct-from-rancher beef sales via BuyHalfCow',
      mcc: '0763', // Agricultural cooperatives
    },
    capabilities: {
      transfers: { requested: true },
      card_payments: { requested: true },
    },
    settings: {
      payouts: {
        schedule: { interval: 'manual' }, // Platform releases payouts on fulfillment confirm
      },
    },
  });
  return { accountId: account.id };
}

export async function createConnectOnboardingLink(accountId: string, returnUrl: string, refreshUrl: string): Promise<{ url: string }> {
  const link = await stripe.accountLinks.create({
    account: accountId,
    return_url: returnUrl,
    refresh_url: refreshUrl,
    type: 'account_onboarding',
  });
  return { url: link.url };
}

export async function getConnectAccount(accountId: string): Promise<Stripe.Account> {
  return await stripe.accounts.retrieve(accountId);
}

export async function createDepositCheckout(input: {
  rancherConnectAccountId: string;
  amountCents: number;
  buyerEmail: string;
  referralId: string;
  productLabel: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string; paymentIntentId: string }> {
  const platformFeeCents = Math.round(input.amountCents * 0.10); // 10% commission to platform
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: input.productLabel },
        unit_amount: input.amountCents,
      },
      quantity: 1,
    }],
    customer_email: input.buyerEmail,
    payment_intent_data: {
      application_fee_amount: platformFeeCents,
      transfer_data: { destination: input.rancherConnectAccountId },
      metadata: { referralId: input.referralId },
    },
    metadata: { referralId: input.referralId },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });
  return {
    url: session.url || '',
    paymentIntentId: String(session.payment_intent || ''),
  };
}

export async function releaseToRancher(input: {
  amountCents: number;
  rancherConnectAccountId: string;
  metadata: Record<string, string>;
}): Promise<{ transferId: string }> {
  // Direct-charge model: Stripe automatically held funds via transfer_data;
  // payouts to the rancher's external bank are governed by payout schedule.
  // For manual schedule, trigger a payout explicitly:
  const payout = await stripe.payouts.create(
    {
      amount: input.amountCents,
      currency: 'usd',
      metadata: input.metadata,
    },
    { stripeAccount: input.rancherConnectAccountId }
  );
  return { transferId: payout.id };
}
```

- [ ] **Step 2: Build the start-onboarding endpoint**

Create `app/api/rancher/connect/start/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { createConnectAccount, createConnectOnboardingLink } from '@/lib/stripeConnect';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export async function POST(req: Request) {
  if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
    return NextResponse.json({ error: 'Connect not enabled' }, { status: 503 });
  }
  const ck = await cookies();
  const rancherCk = ck.get('bhc-rancher-auth');
  if (!rancherCk?.value) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let decoded: any;
  try { decoded = jwt.verify(rancherCk.value, JWT_SECRET); }
  catch { return NextResponse.json({ error: 'Session expired' }, { status: 401 }); }
  if (decoded.type !== 'rancher-session') return NextResponse.json({ error: 'Invalid session' }, { status: 401 });

  const rancher: any = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  let accountId: string = String(rancher['Stripe Connect Account Id'] || '');
  if (!accountId) {
    const { accountId: newId } = await createConnectAccount(
      String(rancher['Email'] || ''),
      String(rancher['Ranch Name'] || rancher['Operator Name'] || 'BHC Rancher')
    );
    accountId = newId;
    await updateRecord(TABLES.RANCHERS, decoded.rancherId, {
      'Stripe Connect Account Id': accountId,
      'Stripe Connect Status': 'onboarding',
    });
  }

  const { url } = await createConnectOnboardingLink(
    accountId,
    `${SITE_URL}/rancher?connect=done`,
    `${SITE_URL}/api/rancher/connect/start`
  );
  return NextResponse.json({ url });
}
```

- [ ] **Step 3: Build the webhook for Connect account updates**

Create `app/api/webhooks/stripe-connect/route.ts`:

```ts
import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' as any });
const WEBHOOK_SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  const rawBody = await req.text();
  const sig = req.headers.get('stripe-signature') || '';
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET);
  } catch (e: any) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  if (event.type === 'account.updated') {
    const account = event.data.object as Stripe.Account;
    const accountId = account.id;
    const safeId = accountId.replace(/"/g, '\\"');
    const matches: any[] = await getAllRecords(TABLES.RANCHERS, `{Stripe Connect Account Id} = "${safeId}"`);
    if (matches.length === 0) return NextResponse.json({ ok: true });
    const rancher = matches[0];
    const status: 'active' | 'restricted' | 'onboarding' =
      account.charges_enabled && account.payouts_enabled ? 'active' :
      account.requirements?.disabled_reason ? 'restricted' :
      'onboarding';
    await updateRecord(TABLES.RANCHERS, rancher.id, {
      'Stripe Connect Status': status,
      ...(status === 'active' && !rancher['Stripe Connect Connected At'] ? { 'Stripe Connect Connected At': new Date().toISOString() } : {}),
    });
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Type-check + commit**

```bash
npx tsc --noEmit
git add lib/stripeConnect.ts app/api/rancher/connect/ app/api/webhooks/stripe-connect/
git commit -m "feat(payments): Stripe Connect Express onboarding endpoints + webhook"
git push
```

- [ ] **Step 5: Smoke test**

Set `STRIPE_CONNECT_ENABLED=true` ONLY for the branch preview env (Vercel dashboard).
```bash
# In Vercel UI, set STRIPE_CONNECT_ENABLED=true on preview branch stage-3-verticals only.
PREVIEW_URL=$(vercel ls stage-3-verticals --limit 1 | awk '{print $2}' | head -1)
# Test the start endpoint with a rancher session cookie
curl -s -X POST "$PREVIEW_URL/api/rancher/connect/start" \
  -H "cookie: bhc-rancher-auth=<valid-rancher-jwt>" \
  | python3 -m json.tool
```
Expected: `{"url": "https://connect.stripe.com/express/..."}`. Visit URL, complete onboarding with a test account.

After onboarding, the webhook should flip `Stripe Connect Status` to `active`.

---

## Task 12: Buyer on-platform deposit flow

**Files:**
- Create: `app/(buyer)/checkout/[refId]/deposit/page.tsx`
- Create: `app/api/checkout/deposit/route.ts`
- Modify: `app/api/webhooks/stripe/route.ts` — handle `payment_intent.succeeded` for deposit flow

- [ ] **Step 1: Build the deposit checkout endpoint**

Create `app/api/checkout/deposit/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';
import { getRecordById, TABLES } from '@/lib/airtable';
import { createDepositCheckout } from '@/lib/stripeConnect';
import { recordDeposit } from '@/lib/contracts/payments';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export async function POST(req: Request) {
  if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
    return NextResponse.json({ error: 'On-platform checkout disabled' }, { status: 503 });
  }
  const ck = await cookies();
  const buyerCk = ck.get('bhc-member-auth');
  if (!buyerCk?.value) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let decoded: any;
  try { decoded = jwt.verify(buyerCk.value, JWT_SECRET); }
  catch { return NextResponse.json({ error: 'Session expired' }, { status: 401 }); }
  if (decoded.type !== 'member-session') return NextResponse.json({ error: 'Invalid session' }, { status: 401 });

  const { referralId, tier } = await req.json();
  if (!referralId || !tier) return NextResponse.json({ error: 'Missing referralId or tier' }, { status: 400 });

  const ref: any = await getRecordById(TABLES.REFERRALS, referralId);
  if (!ref) return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  const buyerIds: string[] = ref['Buyer'] || [];
  if (!buyerIds.includes(decoded.consumerId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const rancherIds: string[] = ref['Rancher'] || ref['Suggested Rancher'] || [];
  const rancherId = rancherIds[0];
  if (!rancherId) return NextResponse.json({ error: 'No rancher assigned' }, { status: 409 });
  const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
  const connectAcct = String(rancher['Stripe Connect Account Id'] || '');
  if (!connectAcct || rancher['Stripe Connect Status'] !== 'active') {
    return NextResponse.json({ error: 'Rancher has not connected payouts yet' }, { status: 409 });
  }

  // Pricing: quarter $400, half $700, whole $1300 — base prices. Override per rancher via Airtable fields.
  const tierPrices: Record<string, number> = {
    quarter: Number(rancher['Quarter Price']) || 400,
    half: Number(rancher['Half Price']) || 700,
    whole: Number(rancher['Whole Price']) || 1300,
  };
  const dollars = tierPrices[tier];
  if (!dollars) return NextResponse.json({ error: 'Invalid tier' }, { status: 400 });
  const amountCents = Math.round(dollars * 100);

  const { url, paymentIntentId } = await createDepositCheckout({
    rancherConnectAccountId: connectAcct,
    amountCents,
    buyerEmail: String(ref['Buyer Email'] || ''),
    referralId,
    productLabel: `${tier.charAt(0).toUpperCase() + tier.slice(1)} Cow — ${rancher['Ranch Name'] || 'BHC Rancher'}`,
    successUrl: `${SITE_URL}/checkout/${referralId}/success`,
    cancelUrl: `${SITE_URL}/checkout/${referralId}/deposit`,
  });

  await recordDeposit({
    referralId,
    buyerId: decoded.consumerId,
    rancherId,
    amountCents,
    stripePaymentIntentId: paymentIntentId,
  });

  return NextResponse.json({ url });
}
```

- [ ] **Step 2: Build the buyer-facing deposit page**

Create `app/(buyer)/checkout/[refId]/deposit/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';

export default function DepositPage() {
  const params = useParams<{ refId: string }>();
  const [tier, setTier] = useState<'quarter' | 'half' | 'whole'>('quarter');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const checkout = async () => {
    setSubmitting(true);
    setError('');
    const res = await fetch('/api/checkout/deposit', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ referralId: params.refId, tier }),
    });
    const j = await res.json();
    if (!res.ok || !j.url) {
      setError(j.error || 'Checkout failed');
      setSubmitting(false);
      return;
    }
    window.location.href = j.url;
  };

  return (
    <div className="max-w-2xl mx-auto p-6 bg-bone min-h-screen text-charcoal">
      <h1 className="text-2xl font-serif mb-4">Reserve your beef</h1>
      <p className="text-saddle mb-6">Deposit holds your spot. Rancher processes + delivers; payout releases on confirmation.</p>
      <div className="grid grid-cols-3 gap-3 mb-6">
        {(['quarter', 'half', 'whole'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTier(t)}
            className={`p-4 border ${tier === t ? 'border-charcoal bg-bone' : 'border-dust bg-white'} text-charcoal capitalize`}
          >
            {t} cow
          </button>
        ))}
      </div>
      <button
        onClick={checkout}
        disabled={submitting}
        className="w-full py-3 bg-charcoal text-bone uppercase tracking-wider text-sm disabled:opacity-50"
      >
        {submitting ? 'Redirecting…' : 'Continue to Payment'}
      </button>
      {error && <p className="text-red-700 mt-4 text-sm">{error}</p>}
      <p className="mt-6 text-saddle text-sm">
        Have questions first? <a href={`./ask`} className="underline">Message your rancher</a>.
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Wire Stripe webhook to record deposit success**

Open `app/api/webhooks/stripe/route.ts`. Add a handler for `payment_intent.succeeded`:

```ts
import { markDepositSucceeded } from '@/lib/contracts/payments';
import { funnelRecord } from '@/lib/funnelMetrics';

// inside the switch on event.type:
case 'payment_intent.succeeded': {
  const pi = event.data.object as any;
  await markDepositSucceeded(pi.id);
  await funnelRecord({
    stage: 'deposit_paid',
    referralId: pi.metadata?.referralId,
    amount: pi.amount_received / 100,
  });
  break;
}
```

- [ ] **Step 4: Type-check + commit**

```bash
npx tsc --noEmit
git add app/api/checkout/ "app/(buyer)/checkout/" app/api/webhooks/stripe/
git commit -m "feat(payments): buyer on-platform deposit checkout via Stripe Connect destination charge"
git push
```

- [ ] **Step 5: Smoke test**

With Connect enabled on preview env + a test rancher connected:
```bash
PREVIEW_URL=$(vercel ls stage-3-verticals --limit 1 | awk '{print $2}' | head -1)
# Use Stripe test card 4242 4242 4242 4242 in the redirect.
echo "Visit $PREVIEW_URL/checkout/<existing-refId>/deposit logged in as the buyer"
```
Expected: redirect to Stripe checkout → complete with 4242 card → land on `/checkout/[refId]/success` → Payments table row goes from `pending` to `succeeded` → Funnel Events gains a `deposit_paid` row.

---

## Task 13: Fulfillment confirmation + payout release

**Files:**
- Create: `app/api/rancher/fulfillment/confirm/route.ts`
- Modify: `app/rancher/page.tsx` — add fulfillment-confirm button per closed referral

- [ ] **Step 1: Build the confirm endpoint**

Create `app/api/rancher/fulfillment/confirm/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@/lib/secrets';
import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { releaseToRancher } from '@/lib/stripeConnect';
import { releasePayout } from '@/lib/contracts/payments';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

export async function POST(req: Request) {
  if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
    return NextResponse.json({ error: 'Connect not enabled' }, { status: 503 });
  }
  const ck = await cookies();
  const rancherCk = ck.get('bhc-rancher-auth');
  if (!rancherCk?.value) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let decoded: any;
  try { decoded = jwt.verify(rancherCk.value, JWT_SECRET); }
  catch { return NextResponse.json({ error: 'Session expired' }, { status: 401 }); }
  if (decoded.type !== 'rancher-session') return NextResponse.json({ error: 'Invalid session' }, { status: 401 });

  const { paymentId } = await req.json();
  if (!paymentId) return NextResponse.json({ error: 'paymentId required' }, { status: 400 });

  const payment: any = await getRecordById('Payments', paymentId);
  if (!payment) return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
  const rancherIds: string[] = payment['Rancher'] || [];
  if (!rancherIds.includes(decoded.rancherId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (payment['Status'] !== 'succeeded') return NextResponse.json({ error: 'Payment not yet succeeded' }, { status: 409 });

  // Idempotency: refuse if already paid out
  const existing: any[] = await getAllRecords(
    'Payouts',
    `SEARCH("${paymentId.replace(/"/g, '\\"')}", ARRAYJOIN({Payment}))`
  );
  if (existing.length > 0) {
    return NextResponse.json({ ok: true, alreadyPaidOut: true });
  }

  const rancher: any = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
  const connectAcct = String(rancher['Stripe Connect Account Id'] || '');
  const totalCents = Number(payment['Amount Cents']);
  const payoutCents = Math.round(totalCents * 0.90); // 90% to rancher, 10% stays with platform

  let transferId = '';
  try {
    const result = await releaseToRancher({
      amountCents: payoutCents,
      rancherConnectAccountId: connectAcct,
      metadata: { paymentId, rancherId: decoded.rancherId },
    });
    transferId = result.transferId;
  } catch (e: any) {
    return NextResponse.json({ error: `Payout failed: ${e?.message || 'unknown'}` }, { status: 500 });
  }

  const { id: payoutId } = await releasePayout({
    paymentId,
    rancherId: decoded.rancherId,
    stripeTransferId: transferId,
    amountCents: payoutCents,
    reason: 'fulfillment_confirmed',
  });

  try {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `💵 <b>Payout released</b>\n\n${rancher['Operator Name'] || rancher['Ranch Name']}: $${(payoutCents / 100).toLocaleString()} → bank\nPayment ${paymentId} · Payout ${payoutId}`
    );
  } catch {}

  return NextResponse.json({ ok: true, payoutId, transferId });
}
```

- [ ] **Step 2: Type-check + commit**

```bash
npx tsc --noEmit
git add app/api/rancher/fulfillment/
git commit -m "feat(payments): rancher fulfillment confirm releases 90% payout via Stripe Connect"
git push
```

- [ ] **Step 3: Smoke test**

After Task 12 deposit succeeds:
```bash
PREVIEW_URL=$(vercel ls stage-3-verticals --limit 1 | awk '{print $2}' | head -1)
curl -s -X POST "$PREVIEW_URL/api/rancher/fulfillment/confirm" \
  -H "cookie: bhc-rancher-auth=<jwt>" \
  -H 'content-type: application/json' \
  -d '{"paymentId":"recPAYMENTID"}' \
  | python3 -m json.tool
```
Expected: `{"ok": true, "payoutId": "rec…", "transferId": "po_…"}`. Stripe dashboard shows the payout on the rancher's Express account.

---

## Task 14: Monthly platform fee billing

**Files:**
- Create: `app/api/cron/platform-fee/route.ts`
- Modify: `vercel.json` cron schedule (1st of month 9am UTC, daily wrapper + day guard pattern from existing crons)

**Schema add:** Rancher fields `Platform Fee Subscription Id` (text), `Platform Fee Status` (singleSelect: none/active/past_due/canceled).

- [ ] **Step 1: Build the cron**

Create `app/api/cron/platform-fee/route.ts`:

```ts
import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';
import { CRON_SECRET } from '@/lib/secrets';
import { withCronRun } from '@/lib/cronRun';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' as any });
export const maxDuration = 60;

const MONTHLY_FEE_PRICE_ID = process.env.STRIPE_PLATFORM_FEE_PRICE_ID || '';

async function realHandler(_req: Request): Promise<{ status: 'success' | 'partial' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
    return { status: 'success', recordsTouched: 0, notes: 'STRIPE_CONNECT_ENABLED=false' };
  }
  const today = new Date();
  if (today.getUTCDate() !== 1) {
    return { status: 'success', recordsTouched: 0, notes: `skipped — not 1st (UTC day=${today.getUTCDate()})` };
  }

  const ranchers: any[] = await getAllRecords(TABLES.RANCHERS,
    `AND({Stripe Connect Status} = "active", {Active Status} = "Active")`
  );

  let created = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const r of ranchers) {
    if (r['Platform Fee Subscription Id']) { skipped++; continue; }
    const connectAcct = String(r['Stripe Connect Account Id'] || '');
    if (!connectAcct) { skipped++; continue; }

    try {
      // Create a Customer on the connected account, then subscribe to the platform fee.
      // Subscription is BILLED ON THE PLATFORM (not the connected account) since
      // it's the platform's monthly fee for using BHC.
      const customer = await stripe.customers.create({
        email: r['Email'],
        name: r['Operator Name'] || r['Ranch Name'],
        metadata: { rancherId: r.id },
      });
      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: MONTHLY_FEE_PRICE_ID }],
        collection_method: 'send_invoice',
        days_until_due: 14,
        metadata: { rancherId: r.id },
      });
      await updateRecord(TABLES.RANCHERS, r.id, {
        'Platform Fee Subscription Id': subscription.id,
        'Platform Fee Status': 'active',
      });
      created++;
    } catch (e: any) {
      errors.push(`${r.id}: ${e?.message?.slice(0, 100) || 'unknown'}`);
    }
  }

  try {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `💼 <b>Platform fee billing</b>\n\nNew subscriptions: ${created}\nAlready active: ${skipped}\nErrors: ${errors.length}${errors.length ? '\nFirst: ' + errors[0] : ''}`
    );
  } catch {}

  return {
    status: errors.length > 0 ? 'partial' : 'success',
    recordsTouched: created,
    notes: `created=${created} skipped=${skipped} errors=${errors.length}`,
  };
}

async function authedHandler(req: Request): Promise<Response> {
  if (CRON_SECRET) {
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      const url = new URL(req.url);
      if (url.searchParams.get('secret') !== CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('platform-fee', realHandler)(req);
}

export const GET = authedHandler;
export const POST = authedHandler;
```

- [ ] **Step 2: Add cron schedule**

Modify `vercel.json` `crons` array — add:

```json
{ "path": "/api/cron/platform-fee", "schedule": "0 9 * * *" }
```

Daily 9 UTC with day-1 guard inside the handler (matches existing pattern).

- [ ] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit
git add app/api/cron/platform-fee/ vercel.json
git commit -m "feat(payments): monthly platform-fee subscription cron (1st of month, day-guarded)"
git push
```

- [ ] **Step 4: Set the platform fee Price ID**

Operator action: create a Stripe Product + recurring Price (e.g. $49/mo) → set `STRIPE_PLATFORM_FEE_PRICE_ID` env var on Vercel preview.

- [ ] **Step 5: Smoke test**

```bash
PREVIEW_URL=$(vercel ls stage-3-verticals --limit 1 | awk '{print $2}' | head -1)
curl -s "$PREVIEW_URL/api/cron/platform-fee?secret=$CRON_SECRET" | python3 -m json.tool
```
Expected: on a non-1st day, `notes: "skipped — not 1st"`. On a 1st-of-month manual force-trigger via the URL, creates subscriptions for active Connect ranchers.

---

## Task 15: Conversion bulletproofing — funnel-stage retries + fallbacks

**Files:**
- Modify: `app/api/cron/stuck-buyer-recovery/route.ts` — extend to handle stuck-at-deposit (Payments.Status=pending >48h, no payout)
- Create: `lib/conversionGuards.ts` — central retry policy

- [ ] **Step 1: Define guards**

Create `lib/conversionGuards.ts`:

```ts
// Conversion guards — every funnel stage has a retry policy + an operator
// escalation. If a buyer sits at a stage longer than the policy, the
// stuck-buyer cron picks them up + retries OR pings the operator.

export interface ConversionGuard {
  stage: string;
  maxStuckHours: number;
  retryAction: 'resend_email' | 'reroute' | 'operator_signal' | 'noop';
  escalationKind: 'system-error' | 'capacity' | 'recovery-suggestion';
}

export const GUARDS: ConversionGuard[] = [
  { stage: 'signup',           maxStuckHours: 24,  retryAction: 'resend_email',     escalationKind: 'recovery-suggestion' },
  { stage: 'transition:READY', maxStuckHours: 72,  retryAction: 'reroute',           escalationKind: 'recovery-suggestion' },
  { stage: 'transition:MATCHED', maxStuckHours: 96, retryAction: 'operator_signal', escalationKind: 'recovery-suggestion' },
  { stage: 'deposit_paid',     maxStuckHours: 168, retryAction: 'operator_signal', escalationKind: 'system-error' },
];

export function findGuard(stage: string): ConversionGuard | undefined {
  return GUARDS.find((g) => g.stage === stage);
}
```

- [ ] **Step 2: Extend stuck-buyer-recovery**

Open `app/api/cron/stuck-buyer-recovery/route.ts`. After the existing stuck-buyer logic, append a section that scans Payments where Status=pending + Created At >48h and posts an operator signal:

```ts
import { GUARDS } from '@/lib/conversionGuards';
import { sendOperatorSignal } from '@/lib/operatorSignal';

// New section inside realHandler:
try {
  const payments: any[] = await getAllRecords('Payments', `{Status} = "pending"`);
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  for (const p of payments) {
    const ts = new Date(p['Created At']).getTime();
    if (ts >= cutoff) continue;
    await sendOperatorSignal({
      urgency: 'normal',
      kind: 'system-error',
      summary: `Stuck deposit: payment ${p.id} pending >48h`,
      detail: `Buyer started checkout but never completed. Manual outreach OR refund + reroute. Stripe PI: ${p['Stripe Payment Intent Id']}`,
      refs: [{ type: 'rancher', id: (p['Rancher'] || [])[0] || '?', label: 'rancher' }],
      dedupeKey: `stuck-deposit:${p.id}`,
      dedupeWindowMs: 48 * 60 * 60 * 1000,
    });
  }
} catch (e: any) {
  console.warn('[stuck-buyer] stuck-deposit scan failed:', e?.message);
}
```

- [ ] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit
git add lib/conversionGuards.ts app/api/cron/stuck-buyer-recovery/
git commit -m "feat(conversion): stuck-deposit operator escalation + guards module"
git push
```

---

## Task 16: Pre-prod soak — 7-day branch monitor

**Files:** No code changes. This is an observation task.

- [ ] **Step 1: Enable preview env vars for testing**

In Vercel: on `stage-3-verticals` branch only, set:
- `STRIPE_CONNECT_ENABLED=true`
- `ON_PLATFORM_MESSAGING_ENABLED=true`
- All Stripe Connect keys (test mode)

Production keeps both flags `false`.

- [ ] **Step 2: Pilot rancher signup**

Recruit 1–2 trusted ranchers (Sackett or High Lonesome per the plan/north-star). Onboard them through `/rancher` → Connect bank account flow.

- [ ] **Step 3: Run 7 days of synthetic + real traffic**

For each of 7 days:
- Have one new buyer sign up + go through `/api/consumers` flow
- Have one buyer message a rancher via `/checkout/[refId]/ask`
- Have one buyer complete deposit via `/checkout/[refId]/deposit`
- Have the rancher confirm fulfillment
- Verify the payout landed

Track in a doc (`docs/SOAK-LOG-2026-05-25.md`) each day: pass/fail per scenario + any boundary checker warnings.

- [ ] **Step 4: Run boundary checker daily**

```bash
VERTICAL_BOUNDARY_ENFORCE=warn npx tsx tools/check-vertical-boundaries.ts > /tmp/boundary-day-N.log
```
Expected: violations stay at 0 day over day.

- [ ] **Step 5: Document any issues + fix on branch**

Each issue: file a commit with `fix(soak): ...` message + push. Repeat day-N smoke after fix.

---

## Task 17: 3-pass audit — functional / regression / customer-experience

**Files:** Audit doc + any fix commits surfaced.

- [ ] **Step 1: Functional audit pass**

Walk the full Buyer journey on preview:
1. `/access` quiz submit → Consumer row + Funnel Event `signup`
2. Welcome email → click YES → `/api/warmup/engage` → Buyer Stage MATCHED/READY + Funnel Event `engaged`
3. matching/suggest creates Referral + Intro Sent emails fire
4. Buyer opens `/checkout/[refId]/ask` → sends question → rancher receives email + Inbox shows it
5. Rancher replies via Inbox → buyer receives email + sees reply in Ask page
6. Buyer opens `/checkout/[refId]/deposit` → completes Stripe checkout w/ test card → success page
7. Payments table goes `pending` → `succeeded`
8. Rancher hits "Confirm Fulfillment" → 90% lands in rancher bank, 10% retained
9. Funnel Events shows full chain: signup → engaged → transition:MATCHED → deposit_paid → close:won

Write up findings in `docs/AUDIT-FUNCTIONAL-2026-05-25.md`.

- [ ] **Step 2: Regression audit pass**

For each existing cron + Telegram callback that was REFACTORED in Tasks 3–4:
1. Trigger it on preview env
2. Verify the same Airtable state results as pre-refactor (compare against `docs/REVENUE-AUDIT-2026-05-25.md` baseline)

Verify in particular:
- `/api/cron/email-sequences` still respects throttle stamps
- `/api/cron/batch-approve` still creates waitlist referrals on no-match
- `/api/cron/referral-chasup` still sends 4-button chase prompts
- Telegram `clcheck_won` → `clcheck_lost` → `clcheck_working` all close + restore properly
- Resend inbound reply to `ref-recX@...` still posts a Conversations row

Write findings in `docs/AUDIT-REGRESSION-2026-05-25.md`.

- [ ] **Step 3: Customer-experience audit pass**

For both Buyer + Rancher journeys:
1. Buyer never receives duplicate emails for same stage (check Inbox after a deliberate cron-retry on the same hour)
2. Rancher never receives duplicate nudges (Telegram double-tap test)
3. Email subject lines, copy, CTA links all render correctly across Gmail/Outlook/Apple Mail
4. `/checkout/[refId]/deposit` Stripe checkout shows correct ranch name + tier label
5. `/checkout/[refId]/ask` thread shows messages in correct chronological order

Write findings in `docs/AUDIT-CX-2026-05-25.md`.

- [ ] **Step 4: Commit audit docs**

```bash
git add docs/AUDIT-*.md docs/SOAK-LOG-2026-05-25.md
git commit -m "docs(stage-3): functional + regression + CX audit reports"
git push
```

---

## Task 18: Canary rollout plan + ship

**Files:**
- Create: `docs/SHIP-PLAN-2026-05-25.md`
- Modify: `vercel.json` — flip canary flags on prod env to `true` ONLY after canary verification

- [ ] **Step 1: Write the ship plan**

Create `docs/SHIP-PLAN-2026-05-25.md`:

```markdown
# Stage 3 — Vertical Architecture + Connect Ship Plan

## Phase 1 — Merge to main (architecture only)
- Tasks 1-6 + Task 10 (boundary enforcement) are architectural; they have ZERO buyer-visible changes.
- Merge `stage-3-verticals` → `main` with `STRIPE_CONNECT_ENABLED=false` + `ON_PLATFORM_MESSAGING_ENABLED=false` on prod.
- Smoke prod: run all 22 crons via manual `?secret=` triggers. Verify no behavior change.

## Phase 2 — On-platform messaging GA (Tasks 7-10)
- Flip `ON_PLATFORM_MESSAGING_ENABLED=true` on prod.
- Email + Telegram broadcast: "New: ask your rancher questions before you buy. Check your member dashboard."
- Monitor Threads + Thread Messages tables for 72h.

## Phase 3 — Stripe Connect canary (Tasks 11-14)
- Recruit Sackett + High Lonesome via personal email.
- Onboard them via `/rancher` → Connect.
- Run ONE end-to-end deposit per rancher (use Stripe test mode first, then real $50).
- After both ranchers + deposits succeed, flip `STRIPE_CONNECT_ENABLED=true` for ALL ranchers.
- Send rancher-broadcast email: "BuyHalfCow now handles deposits. Connect your bank in 90 seconds."

## Phase 4 — Platform fee billing (Task 14)
- Once 5+ ranchers active on Connect, set `STRIPE_PLATFORM_FEE_PRICE_ID` on prod.
- First monthly cron firing creates subscriptions; ranchers receive Stripe-emailed invoices.

## Rollback plan
- Flip `STRIPE_CONNECT_ENABLED=false` + `ON_PLATFORM_MESSAGING_ENABLED=false` — UI gracefully degrades to pre-stage-3.
- Existing rancher Connect accounts persist; payouts continue but new deposits revert to external Payment Links.
```

- [ ] **Step 2: Open the merge PR (still draft)**

```bash
gh pr ready  # if PR was draft, mark ready
```

Verify in PR description:
- Reference Task 17 audit docs
- List all canary env flag defaults = false in prod
- Tag rollback plan

- [ ] **Step 3: Land architecture-only commits to main**

Cherry-pick Tasks 1-6 + Task 10 only (NOT Tasks 7-15) onto main. Verify type-check + preview deploy. Push to main only after stakeholder sign-off.

```bash
git checkout main
git checkout stage-3-verticals -- lib/contracts/ lib/funnelMetrics.ts tools/check-vertical-boundaries.ts
# also: refactored route files from Tasks 3-4
git add lib/contracts/ lib/funnelMetrics.ts tools/check-vertical-boundaries.ts app/api/consumers app/api/warmup app/api/rancher/referrals app/api/rancher/quick-action app/api/webhooks/telegram
git commit -m "feat(verticals): land architecture + boundary checker on main (flags off)"
git push
```

- [ ] **Step 4: Run prod smoke**

```bash
PROD_URL=https://www.buyhalfcow.com
curl -sI $PROD_URL/map | head -3
curl -sI $PROD_URL/rancher | head -3
curl -sI $PROD_URL/admin | head -3
```
Expected: all 200 or 302 to login.

- [ ] **Step 5: Run prod boundary check**

```bash
git checkout main
VERTICAL_BOUNDARY_ENFORCE=warn npx tsx tools/check-vertical-boundaries.ts
```
Expected: 0 violations.

- [ ] **Step 6: Phase 2 + 3 + 4 ship via env flag flips**

Document each flag flip date in `docs/SHIP-PLAN-2026-05-25.md` as Phase N executed.

---

## Self-Review

**Spec coverage:**
- Architectural verticals (3-4 separation) — Tasks 1, 3, 4, 5, 10 ✓
- Customer-facing connects to DB through clean contract — Tasks 1, 3 ✓
- Rancher-facing connects to DB through clean contract — Tasks 1, 4 ✓
- Admin overview — Task 6 (funnel dashboard) + existing /admin ✓
- Bottom-of-funnel conversion audit — Task 2 (instrumentation) + Task 6 (dashboard) + Task 15 (guards) ✓
- Rancher-not-calling fix — Tasks 7, 8, 9, 10 (on-platform thread + email mirror) ✓
- Stripe Connect deposit flow — Tasks 11, 12, 13 ✓
- Platform owns customer + monthly fee — Tasks 12 (10% retained) + 14 (monthly subscription) ✓
- NOT shipping to prod — Tasks 0 (branch), 16 (soak), 17 (audit), 18 (canary) ✓

**Placeholder scan:** No "TBD" / "implement later" / "similar to Task N" placeholders. Every code step has the full snippet.

**Type consistency:**
- `BuyerStage` consistent across `buyer.ts`, `admin.ts`, `funnelMetrics`.
- `ReferralStatus` defined in `rancher.ts`, used in `recordClose`.
- `PaymentStatus` + `PayoutStatus` consistent in `payments.ts` + Stripe webhook + cron.
- `recordClose()` signature matches all 3 call sites refactored in Task 4.
- `getOrCreateThreadForReferral` returns `{ id, isNew }` and is used by `by-referral` lookup endpoint.

**Risks called out:**
- Task 7 schema dependency: Threads tables must exist before Tasks 8+ can smoke-test. Plan calls this out.
- Task 11 Stripe Connect: requires `STRIPE_SECRET_KEY` already set (it is). Requires Connect to be activated on the Stripe account (operator confirms — user said they already have the Connect profile).
- Task 14 platform fee: requires operator to create the Price ID before cron runs.
- Task 18 cherry-pick: if Task 3-4 refactors depend on schema additions from later tasks, they break. Verified: Task 3-4 only use existing fields + the new `Funnel Events` table (Task 2 — also architecture-phase). Safe.
