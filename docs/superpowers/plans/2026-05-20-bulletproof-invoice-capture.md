# Bulletproof Invoice Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Ashcraft-pattern leak: deals marked Closed Won without sale amount captured, commission ad-hoc-edited, invoices fired against placeholder data, ranchers invoiced before they've collected. Every close in BHC produces a correct commission invoice — no manual reconciliation, no rancher disputes mid-pipeline.

**Architecture decision:** Two-stage close. Rancher reports a close → state moves to `Awaiting Payment` (deal closed off-platform, buyer hasn't paid yet OR hasn't received product). When rancher confirms cash received, state moves to `Closed Won` and commission invoice fires automatically. Per-rancher commission rate locked at agreement-signing time so there's never ambiguity.

**Tech Stack:** Next.js 16 App Router, Vercel Cron, Airtable, Stripe, Telegram Bot API, existing `lib/cronRun.ts::withCronRun`, existing `lib/operatorSignal.ts::sendOperatorSignal`, existing `lib/commission.ts::calcCommission`.

---

## Context — The Eric Turner / Ashcraft case study

Reference: `rec6u9xNRJMsYjzQF` (2026-05-20).

Buyer (Eric Turner, TX) signed up. Matched to John & Kellie Ashcraft (Ashcraft Beef). Off-platform deal closed (rancher contacted buyer directly, agreed pickup-on-delivery in Houston). Ben tapped "Won" on Telegram close-detector card. `clcheck_won` handler at `app/api/webhooks/telegram/route.ts:2094-2115` flipped `Status='Closed Won'` + `Closed At=now` with NO financial validation. Soft text-prompt "reply with sale $" was ignored. Later, manual Airtable edits set Sale=$1 (placeholder — actual amount unknown until delivery) + Commission=$95. Stripe invoice fired against John for $95 based on a $1 sale.

Three problems compounded:
1. Close-detector Telegram path bypasses the saleAmount gate that the dashboard close-flow enforces (post PR #30).
2. Off-platform close with future payment has no state to live in — "Closed Won" implies money received.
3. Ashcraft's commission rate was never pinned. Each deal has notes like "contact John on commission rate" — proves the inconsistency.

Blast radius today (2026-05-20): 3 of 5 Ashcraft closes (60%) show commission-confusion. 11 total Closed Won referrals in the base — all have Stripe Invoice URLs (the URL gate works); 3 have notes flagging unresolved commission.

---

## File Structure

**Files modified:**
- `app/api/webhooks/telegram/route.ts` — `clcheck_won` callback gated by saleAmount + commission-rate readiness; new `clcheck_awaiting` button
- `app/api/rancher/referrals/[id]/route.ts` — accept new `Awaiting Payment` status; refuse Closed Won → invoice flow if rancher missing Commission Rate
- `app/api/rancher/quick-action/route.ts` — same gates as dashboard
- `lib/stripe-commission.ts` (`createCommissionInvoice`) — refuse to fire if Sale Amount < `MIN_SALE_AMOUNT` OR ratio outside `[0.03, 0.20]`
- `lib/commission.ts` — `calcCommission` reads per-rancher rate, falls back to env default
- `app/api/cron/nightly-rancher-audit/route.ts` — add Check 11: Commission/Sale ratio anomalies + missing invoice URLs on Closed Won
- `app/api/cron/daily-audit/route.ts` — add `get_invoice_anomalies` AI tool
- `app/api/ranchers/sign-agreement/route.ts` — require Commission Rate at agreement time
- `app/rancher/sign-agreement/page.tsx` — surface commission rate during sign

**Files created:**
- `app/api/rancher/referrals/[id]/confirm-payment/route.ts` — rancher confirms cash received; flips status to Closed Won + fires invoice
- `app/api/cron/awaiting-payment-nudge/route.ts` — daily cron nudges ranchers stuck in Awaiting Payment >14d
- `docs/COMMISSION-FLOW.md` — canonical state-machine doc

**Airtable changes (via MCP):**
- Referrals.Status singleSelect: add `Awaiting Payment` choice
- Referrals: add `Payment Confirmed At` (dateTime), `Payment Confirmation Method` (singleSelect: cash / check / venmo / square / stripe / wire / other)
- Ranchers: add `Commission Rate` (percent, 4-decimal — supports e.g. 0.0525). Required for any Closed Won path.
- Ranchers: add `Commission Rate Locked At` (dateTime). Audit trail of when the rate was set + by whom.

---

## Task 1 — Airtable schema additions

**Files:** Airtable MCP only.

- [ ] **Step 1: Add `Awaiting Payment` to Referrals.Status singleSelect**

Via Airtable MCP `update_field` on `tblBfimb4Gt8C0fu4` field `fldBvSsIoIDcjjOGF`. Add choice `Awaiting Payment` (color amber).

- [ ] **Step 2: Add Referrals.Payment Confirmed At (dateTime)**

```
create_field baseId=appgLT4z009iwAfhs tableId=tblBfimb4Gt8C0fu4
field: { name: "Payment Confirmed At", type: "dateTime", options: { dateFormat: { name: "iso" }, timeFormat: { name: "24hour" }, timeZone: "client" } }
```

- [ ] **Step 3: Add Referrals.Payment Confirmation Method (singleSelect)**

Choices: `cash`, `check`, `venmo`, `square`, `stripe`, `wire`, `other`.

- [ ] **Step 4: Add Ranchers.Commission Rate (percent, precision 4)**

```
create_field baseId=appgLT4z009iwAfhs tableId=tbl08y9Be45zNG0OG
field: { name: "Commission Rate", type: "percent", options: { precision: 4 } }
```

- [ ] **Step 5: Add Ranchers.Commission Rate Locked At (dateTime)**

Same shape as other dateTime fields.

- [ ] **Step 6: Backfill Commission Rate on existing live ranchers**

Manual via Airtable UI. Read each Live rancher's current de-facto rate from past Closed Won notes; set explicit value. Default fallback for ranchers without a locked rate = `COMMISSION_RATE_DEFAULT` env var (existing, currently 0.10).

**For Ashcraft specifically:** review the 5 closed deals, agree on rate with John directly, set `Commission Rate` once, then go reconcile the 3 disputed invoices manually outside this plan.

- [ ] **Step 7: Commit schema notes**

```bash
git add docs/superpowers/plans/2026-05-20-bulletproof-invoice-capture.md
git commit -m "docs(plan): bulletproof invoice capture v1"
```

---

## Task 2 — `calcCommission` reads per-rancher rate

**Files:**
- Modify: `lib/commission.ts`

- [ ] **Step 1: Read current calcCommission**

```bash
grep -n "calcCommission\|getCommissionRate\|COMMISSION_RATE" lib/commission.ts
```

- [ ] **Step 2: Add rancher-aware overload**

```typescript
// lib/commission.ts

export function getRancherCommissionRate(rancher: any): number {
  const raw = rancher?.['Commission Rate'];
  if (typeof raw === 'number' && !Number.isNaN(raw) && raw > 0) {
    return Math.min(Math.max(raw, 0), 1);
  }
  // Fall back to env default (no rancher-specific rate set yet).
  return getCommissionRate();
}

/**
 * Per-rancher commission. Pass the rancher record + sale amount.
 * Prefer this over the env-default-only calcCommission when you have
 * the rancher record handy — guarantees the rate matches what the
 * rancher agreed to at sign-agreement time.
 */
export function calcCommissionForRancher(rancher: any, saleAmount: number): number {
  const rate = getRancherCommissionRate(rancher);
  return Math.round(saleAmount * rate * 100) / 100;
}
```

Keep existing `calcCommission(saleAmount)` for backward compat — internally calls `getCommissionRate()`.

- [ ] **Step 3: Add unit-test-equivalent smoke check**

```bash
# Pull two ranchers via MCP; one with rate set, one without. Eyeball
# calcCommissionForRancher returns expected value.
```

- [ ] **Step 4: Commit**

```bash
git add lib/commission.ts
git commit -m "feat(commission): per-rancher commission rate

calcCommissionForRancher(rancher, sale) reads rancher's Commission Rate
field, falls back to env default. Bounded [0, 1]. Keeps existing
calcCommission(sale) for backward compat."
```

---

## Task 3 — Hard-gate the Telegram `clcheck_won` callback

**Files:**
- Modify: `app/api/webhooks/telegram/route.ts:2094-2115`

- [ ] **Step 1: Read current handler**

```bash
grep -n "clcheck_won\|clcheck_lost\|clcheck_working\|clcheck_mute" app/api/webhooks/telegram/route.ts
```

- [ ] **Step 2: Replace one-tap close with two-step capture**

Behavior change:
- Tap "Won" → bot replies "💰 How much was the sale? Reply with amount (or `awaiting` if not paid yet)"
- User replies with number → bot writes `Sale Amount` + flips status `Closed Won` + fires invoice
- User replies `awaiting` → bot flips status to new `Awaiting Payment` state — invoice deferred
- User replies anything else → bot re-prompts

Implementation: add a "pending close" state keyed by `chatId + messageId` to a new ephemeral table OR Airtable `Telegram Pending Closes` (5 LOC create). Reply handler checks for pending close before falling through to AI chat.

```typescript
// Sketch
else if (action === 'clcheck_won') {
  const refId = fullReferralId;
  // Persist pending-close context
  await createRecord('Telegram Pending Closes', {
    'Chat ID': chatId,
    'Referral ID': refId,
    'Created At': new Date().toISOString(),
    'Expires At': new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  await answerCallbackQuery(queryId, '💰 Need sale amount');
  await editTelegramMessage(chatId, messageId,
    `<b>📝 Confirming Closed Won</b>\n\n` +
    `Buyer: ${ref['Buyer Name']}\n` +
    `Rancher: ${rancherName}\n\n` +
    `Reply with the <b>sale dollar amount</b> (e.g. <code>$2400</code>), or reply <code>awaiting</code> if buyer hasn't paid yet.`
  );
}
```

Plain-text message handler at top of webhook (before AI fallback) checks `Telegram Pending Closes` for an unexpired row matching `chatId`. If found + the text parses to a positive number, fire the full close flow (Sale Amount + calcCommissionForRancher + createCommissionInvoice). If text === "awaiting", flip status to `Awaiting Payment`.

- [ ] **Step 3: Validate**

Manually test in dev. Tap Won on a test ref. Reply $500. Verify Stripe invoice created. Reply "awaiting" on another test. Verify status='Awaiting Payment' + no invoice.

- [ ] **Step 4: Commit**

```bash
git add app/api/webhooks/telegram/route.ts
git commit -m "fix(telegram): clcheck_won hard-gates on sale amount

Previously one-tap Won flipped Status without capturing sale amount.
Soft text prompt 'reply with \$' was ignored repeatedly (Ashcraft pattern,
2026-05-20). Now two-step: tap Won → bot requires sale amount OR
'awaiting' reply before any state change. Awaiting Payment is the new
state for off-platform closes where buyer pays on delivery."
```

---

## Task 4 — `Awaiting Payment` status + confirm-payment endpoint

**Files:**
- Create: `app/api/rancher/referrals/[id]/confirm-payment/route.ts`
- Modify: `app/api/rancher/referrals/[id]/route.ts` (accept new status)

- [ ] **Step 1: Build confirm-payment endpoint**

```typescript
// app/api/rancher/referrals/[id]/confirm-payment/route.ts
// Rancher POSTs here when they've received payment from a buyer on an
// Awaiting Payment referral. Flips status Closed Won + computes
// commission against rancher's locked rate + fires invoice.
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { calcCommissionForRancher } from '@/lib/commission';
import { createCommissionInvoice } from '@/lib/stripe-commission';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { JWT_SECRET } from '@/lib/secrets';
import jwt from 'jsonwebtoken';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  // Verify rancher session (cookie OR token query param). Same auth as
  // /api/rancher/referrals/[id] PATCH — extract into shared helper if not
  // already done.
  // ...
  const { id } = await ctx.params;
  const body = await request.json();
  const saleAmount = Number(body.saleAmount);
  const method = String(body.method || 'other');

  if (!Number.isFinite(saleAmount) || saleAmount < 50) {
    return NextResponse.json({ error: 'Sale amount must be ≥ $50' }, { status: 400 });
  }

  const ref = await getRecordById(TABLES.REFERRALS, id);
  if (ref?.['Status'] !== 'Awaiting Payment') {
    return NextResponse.json({ error: 'Referral not in Awaiting Payment state' }, { status: 400 });
  }

  // Look up rancher to get locked commission rate
  const rancherId = (ref['Rancher'] || [])[0] || (ref['Suggested Rancher'] || [])[0];
  const rancher = rancherId ? await getRecordById(TABLES.RANCHERS, rancherId) : null;
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  const commission = calcCommissionForRancher(rancher, saleAmount);
  await updateRecord(TABLES.REFERRALS, id, {
    'Status': 'Closed Won',
    'Sale Amount': saleAmount,
    'Commission Due': commission,
    'Payment Confirmed At': new Date().toISOString(),
    'Payment Confirmation Method': method,
    'Closed At': new Date().toISOString(),
  });

  try {
    await createCommissionInvoice({ referralId: id, rancher, saleAmount, commission });
  } catch (e: any) {
    await sendOperatorSignal({
      urgency: 'loud',
      kind: 'sale',
      summary: `Stripe invoice failed for ${ref['Buyer Name']} → ${rancher['Operator Name']}: ${e.message}`,
    });
  }

  return NextResponse.json({ ok: true, saleAmount, commission });
}
```

- [ ] **Step 2: Update dashboard to surface Awaiting Payment + Confirm Payment button**

In `app/rancher/page.tsx`, render confirm-payment button on rows where `status === 'Awaiting Payment'`. Wires to the new endpoint.

- [ ] **Step 3: Commit**

```bash
git add app/api/rancher/referrals/[id]/confirm-payment app/rancher/page.tsx
git commit -m "feat(commission): Awaiting Payment state + confirm-payment flow

Two-stage close: rancher reports close → status='Awaiting Payment'
(no invoice yet). When rancher actually receives money, they confirm
via dashboard → status='Closed Won' + Stripe invoice fires against
rancher's locked Commission Rate. Stops invoicing rancher before
they've collected from the buyer."
```

---

## Task 5 — Hard floor + ratio guard in createCommissionInvoice

**Files:**
- Modify: `lib/stripe-commission.ts`

- [ ] **Step 1: Add sanity gates**

```typescript
// At top of createCommissionInvoice
const MIN_SALE_AMOUNT = Number(process.env.MIN_SALE_AMOUNT_FOR_INVOICE) || 50;
const MIN_RATIO = 0.03; // commissions below 3% are wrong
const MAX_RATIO = 0.20; // commissions above 20% are wrong

if (saleAmount < MIN_SALE_AMOUNT) {
  await sendOperatorSignal({
    urgency: 'loud',
    kind: 'sale',
    summary: `Refused invoice: Sale Amount $${saleAmount} below $${MIN_SALE_AMOUNT} floor. Referral ${referralId}.`,
  });
  throw new Error(`Sale amount $${saleAmount} below floor`);
}

const ratio = commission / saleAmount;
if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
  await sendOperatorSignal({
    urgency: 'loud',
    kind: 'sale',
    summary: `Refused invoice: ${(ratio * 100).toFixed(1)}% commission ratio outside [${MIN_RATIO * 100}%, ${MAX_RATIO * 100}%]. Sale=$${saleAmount} Commission=$${commission}. Referral ${referralId}.`,
  });
  throw new Error(`Commission ratio ${ratio} outside bounds`);
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/stripe-commission.ts
git commit -m "fix(stripe-commission): minimum sale + ratio guards

Refuse invoice when Sale Amount < \$50 (env override via
MIN_SALE_AMOUNT_FOR_INVOICE) OR commission/sale ratio outside
[3%, 20%]. Fires operator alert with details. Catches the
\$1 placeholder + 9500% ratio pattern from the Ashcraft case."
```

---

## Task 6 — Lock commission rate at sign-agreement

**Files:**
- Modify: `app/api/ranchers/sign-agreement/route.ts`
- Modify: `app/rancher/sign-agreement/page.tsx`

- [ ] **Step 1: Surface commission rate on sign-agreement page**

Show the rate the rancher is agreeing to (default 10% or per-deal overridden). They check a box "I agree to the X% commission on closed sales".

- [ ] **Step 2: Stamp Commission Rate on signing**

```typescript
// In sign-agreement POST handler
await updateRecord(TABLES.RANCHERS, decoded.rancherId, {
  'Agreement Signed': true,
  'Agreement Signed At': now,
  'Signature Name': signatureName.trim(),
  'Onboarding Status': 'Agreement Signed',
  'Commission Rate': agreedRate, // NEW
  'Commission Rate Locked At': now, // NEW
});
```

- [ ] **Step 3: Backfill existing signed ranchers**

Manual sweep via Airtable UI OR a one-off admin script that sets Commission Rate = env default for any signed rancher with empty rate. Document the sweep in audit log.

- [ ] **Step 4: Refuse Closed Won flow if rancher Commission Rate empty**

In every close path (dashboard PATCH + quick-action + telegram clcheck_won + confirm-payment), check `getRancherCommissionRate(rancher)` returns > 0 from rancher record (not env fallback). If env fallback would be used, refuse + alert operator. Forces explicit rate-setting per rancher.

- [ ] **Step 5: Commit**

```bash
git add app/api/ranchers/sign-agreement/route.ts app/rancher/sign-agreement/page.tsx
git commit -m "feat(ranchers): lock commission rate at agreement signing

Sign-agreement page now displays the commission rate the rancher is
agreeing to. POST stamps Commission Rate + Commission Rate Locked At
on the Rancher row. Close-flow paths refuse to proceed if the rancher
has no locked rate (prevents the 'we never agreed on a rate'
disputes the Ashcraft pattern caused)."
```

---

## Task 7 — Nightly invoice-anomaly audit

**Files:**
- Modify: `app/api/cron/nightly-rancher-audit/route.ts`

- [ ] **Step 1: Add Check 11**

```typescript
// At end of per-referral checks
if (status === 'Closed Won' && !ref['Stripe Invoice URL']) {
  issues.push({
    severity: 'critical',
    rancher: rancherName,
    refId: ref.id,
    text: `${rancherName}: ${ref['Buyer Name']} Closed Won missing Stripe Invoice URL`,
  });
}

if (status === 'Closed Won') {
  const sale = Number(ref['Sale Amount']) || 0;
  const commission = Number(ref['Commission Due']) || 0;
  if (sale > 0) {
    const ratio = commission / sale;
    if (ratio < 0.03 || ratio > 0.20) {
      issues.push({
        severity: 'critical',
        rancher: rancherName,
        refId: ref.id,
        text: `${rancherName}: ${ref['Buyer Name']} ratio ${(ratio * 100).toFixed(1)}% (sale=$${sale} commission=$${commission})`,
      });
    }
  }
  if (sale < 50) {
    issues.push({
      severity: 'critical',
      rancher: rancherName,
      refId: ref.id,
      text: `${rancherName}: ${ref['Buyer Name']} Sale Amount $${sale} below $50 floor`,
    });
  }
}

if (status === 'Awaiting Payment') {
  const closedAt = ref['Closed At'] ? new Date(ref['Closed At']).getTime() : 0;
  if (closedAt && now - closedAt > 14 * DAY) {
    issues.push({
      severity: 'warn',
      rancher: rancherName,
      refId: ref.id,
      text: `${rancherName}: ${ref['Buyer Name']} Awaiting Payment >14 days. Nudge rancher to confirm.`,
    });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add app/api/cron/nightly-rancher-audit/route.ts
git commit -m "feat(audit): invoice anomaly checks (11, 12, 13)

Adds three nightly checks:
- Closed Won missing Stripe Invoice URL = critical
- Closed Won with commission/sale ratio outside [3%, 20%] = critical
- Closed Won with sale < \$50 floor = critical
- Awaiting Payment >14 days = warn (rancher needs nudge)"
```

---

## Task 8 — Awaiting-payment nudge cron

**Files:**
- Create: `app/api/cron/awaiting-payment-nudge/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Build cron**

Daily 17 UTC. Pulls Referrals where `Status='Awaiting Payment'` AND `Closed At` >14d ago AND no recent nudge. For each, send rancher an email + Telegram card asking "did you receive payment from <buyer>? [Yes — confirm now] [Still waiting] [Never paid → mark Closed Lost]". Throttle 1 nudge per 7d per referral.

- [ ] **Step 2: Schedule in vercel.json**

```json
{ "path": "/api/cron/awaiting-payment-nudge", "schedule": "0 17 * * *" }
```

- [ ] **Step 3: Commit**

```bash
git add app/api/cron/awaiting-payment-nudge/route.ts vercel.json
git commit -m "feat(cron): awaiting-payment-nudge

Daily 17 UTC. Nudges ranchers stuck >14d in Awaiting Payment with a
3-button Telegram card (Yes/Still waiting/Never paid). Throttled
1/week per referral. Prevents the 'closed off-platform, forgot to
confirm' rot."
```

---

## Task 9 — Document the commission flow

**Files:**
- Create: `docs/COMMISSION-FLOW.md`

- [ ] **Step 1: Write the canonical state-machine doc**

```markdown
# BHC Commission Flow

## State machine

```
[Pending Approval] → [Intro Sent] → [Rancher Contacted] → [Negotiation]
                                                              ↓
                                              [Awaiting Payment]  [Closed Lost]
                                                              ↓
                                                       [Closed Won]
                                                              ↓
                                                  Stripe invoice fires
```

## Rules

1. **Commission Rate locked at agreement signing.** Every Active rancher MUST have a `Commission Rate` set on their record. Defaults to the env value at sign-agreement, can be admin-overridden post-signing.

2. **Closed Won fires invoice immediately.** Sale Amount + per-rancher commission rate → Stripe invoice → `Stripe Invoice URL` persisted.

3. **Awaiting Payment defers invoice.** When rancher closes off-platform but buyer hasn't paid yet, status → Awaiting Payment. NO invoice. Rancher confirms via dashboard's "Confirm Payment Received" button when cash lands → status flips to Closed Won + invoice fires.

4. **Sanity gates.** Sale Amount must be ≥ $50. Commission/sale ratio must be within [3%, 20%]. Either violation: invoice refused + operator alert fires loud.

5. **No status changes without sale data.** Every close path (dashboard PATCH, rancher quick-action email button, Telegram clcheck_won) must gate hard on Sale Amount > 0.

6. **Audit nightly.** nightly-rancher-audit checks every Closed Won for missing invoice URL + ratio anomaly + sale floor. awaiting-payment-nudge cron pings ranchers stuck >14d.

## Failure modes (known, blocked as of 2026-05-20)

- ❌ Tap "Won" in Telegram → flip status without sale (BLOCKED: two-step capture)
- ❌ Sale $1 placeholder + manual $95 commission (BLOCKED: floor + ratio guards)
- ❌ Invoice fires before rancher collected (BLOCKED: Awaiting Payment state)
- ❌ Ad-hoc commission rate per deal (BLOCKED: per-rancher locked rate)
- ❌ Closed Won missing Stripe Invoice URL (DETECTED: nightly audit)
```

- [ ] **Step 2: Commit**

```bash
git add docs/COMMISSION-FLOW.md
git commit -m "docs(commission): canonical state-machine + rules

Two-stage close. Per-rancher commission rate. Sanity floors + ratio
guards. Nightly audits. Born from the 2026-05-20 Ashcraft/Eric Turner
incident — codify the model so it doesn't drift."
```

---

## Task 10 — Retro-fix the Ashcraft 3 deals

**Not in this plan — separate runbook.** Steps for Ben to execute manually after the code ships:

1. Call/email John Ashcraft. Agree on his commission rate. Lock it on his Rancher record.
2. Pull all 5 of his Closed Won deals. For each: confirm actual Sale Amount with John, confirm buyer has actually paid, fix Sale Amount + Commission Due in Airtable, cancel + reissue Stripe invoice if necessary.
3. Apologize for the mess. Comp him one tier on the Founders Wall as goodwill (use the new `/comp` command from PR #34).

---

## Verification (manual, end of all tasks)

- [ ] Tap clcheck_won on test referral → bot prompts for amount → reply $500 → invoice fires
- [ ] Same flow, reply "awaiting" → status='Awaiting Payment' → NO invoice
- [ ] On Awaiting Payment ref, hit confirm-payment with amount → status='Closed Won' → invoice fires
- [ ] Try to fire invoice via dashboard with Sale=$1 → 400 error + operator alert
- [ ] Try commission/sale ratio 0.50 → invoice refused + operator alert
- [ ] Sign a new rancher's agreement → Commission Rate stamped at signing time
- [ ] Wait 24h: nightly audit Telegram card shows new Check 11/12/13 results
- [ ] Wait 14d on an Awaiting Payment ref: nudge cron fires

---

## Rollback

Every task is its own commit. Revert individually if any breaks production. Schema additions are forward-compatible — existing closes don't break when new fields exist empty.

For the `Awaiting Payment` state: if it confuses ranchers, fold it back into Closed Won + add a separate `Payment Received At` field instead. The Awaiting Payment vs Closed Won distinction is the architectural call — easy to flip later.
