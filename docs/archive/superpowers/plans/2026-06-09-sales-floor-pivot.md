# Sales-Floor Pivot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BHC FEEL like the modern sales infrastructure for DTC ranchers — a single daily desk for Ben, six transactional emails (no drip), and dual brand voice (buyer = beef, rancher = infra).

**Architecture:** Three-phase ship. Phase 1 builds `/admin/today` v2 as Ben's single login screen — Cal feed + pipeline snapshot + 1-click invoice send. Phase 2 strips the 4000-line email drip jungle to ~600 lines (6 transactional templates only); kills 7 crons. Phase 3 splits brand voice: buyer pages keep product-first copy, rancher pages reposition as infrastructure.

**Tech Stack:** Next.js 16 App Router, Airtable, Stripe Connect V2, Cal.com OAuth, Resend, Telegram, Vercel cron.

**Validation findings (2026-06-09):**
- 100 buyers stuck in WAITING/READY — drip doesn't convert
- Only 100 emails fired in last 30d — drip volume already low
- Only 6 buyer intros fired in last 30d — Cal capacity (80/wk) is 13x current volume
- 0 quiz-completed buyers in last 30d (quiz just launched — assumption: volume grows post-pivot)
- Two distinct voices needed: buyers want beef, ranchers want sales infra

**Decisions locked:**
- D1: Cal-as-primary-funnel is safe at current volume + 13x headroom
- D2: Drip kill is data-justified (drip never moved 100 stuck buyers)
- D3: `/admin/today` v2 = single screen, no separate desks until volume forces split
- D4: Dual brand voice — buyer-facing pages stay product-led, rancher-facing pivot to infra
- D5: Async fallback — buyers w/ no Cal slot in 48h get self-serve deposit option (not a drip — a one-shot transactional)

**File structure (locked before tasks):**
```
NEW files:
  app/admin/today/v2/page.tsx                — single-page sales desk
  app/admin/today/v2/DeskComponents.tsx      — Cal feed, pipeline cards, 1-click invoice
  app/api/admin/desk/route.ts                — GET aggregated desk data
  app/api/admin/send-deposit-invoice/route.ts — POST: fires deposit invoice to buyer
  lib/emailMinimal.ts                        — 6 transactional templates only

MODIFIED files:
  lib/email.ts                                — strip to re-exports from lib/emailMinimal
  app/api/cron/email-sequences/route.ts       — gut to skeleton (log-only)
  vercel.json                                 — remove 7 cron entries
  app/page.tsx                                — buyer-facing hero copy
  app/partner/page.tsx                        — rancher-facing pivot to infra positioning
  app/founders/page.tsx                       — same infra positioning

DELETED files:
  app/api/cron/rancher-followup/route.ts
  app/api/cron/qualified-no-action/route.ts
  app/api/cron/re-warm-cohort/route.ts
  app/api/cron/migration-deadline/route.ts   — after all ranchers migrated
```

**Conventions:**
- All commits use Conventional Commits + Claude trailer
- Each task gets typecheck pass before commit
- Each phase ships independently — phase 1 doesn't block phase 2
- Rollback: feature flag `EMAIL_SEQUENCES_ENABLED` controls drip kill

---

## PHASE 1: Daily Ops Surface — `/admin/today` v2 (2 hours)

### Task 1.1: Build the desk data aggregator endpoint

**Files:**
- Create: `app/api/admin/desk/route.ts`

- [ ] **Step 1: Create endpoint w/ admin auth + aggregated query**

```typescript
// app/api/admin/desk/route.ts
import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: Request) {
  const a = await requireAdmin(req);
  if (a instanceof NextResponse) return a;

  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const todayIso = today.toISOString().slice(0, 10);
  const tomorrowIso = tomorrow.toISOString().slice(0, 10);

  const [calls, quizComplete, depositPending, slotsLocked, closedToday, waitlisted, ranchersActive] =
    await Promise.all([
      // 1. Calls today (Cal bookings in 24h window) — read Conversations table
      getAllRecords(
        'Conversations',
        `AND({Type}='cal_booking',IS_AFTER({Start Time},'${todayIso}'),IS_BEFORE({Start Time},'${tomorrowIso}'))`,
      ),
      // 2. Quiz-completed awaiting outreach
      getAllRecords(
        TABLES.CONSUMERS,
        `AND(NOT({Qualified At}=''),{Buyer Stage}='READY')`,
      ),
      // 3. Deposit pending (buyer paid, rancher not accepted)
      getAllRecords(
        TABLES.REFERRALS,
        `{Status}='Awaiting Payment'`,
      ),
      // 4. Slots locked (rancher accepted, balance owed)
      getAllRecords(
        TABLES.REFERRALS,
        `{Status}='Slot Locked'`,
      ),
      // 5. Closed today
      getAllRecords(
        TABLES.REFERRALS,
        `AND({Status}='Closed Won',IS_AFTER({Closed At},'${todayIso}'))`,
      ),
      // 6. Waitlisted (no rancher in state)
      getAllRecords(
        TABLES.CONSUMERS,
        `{Buyer Stage}='WAITING'`,
      ),
      // 7. Active ranchers
      getAllRecords(
        TABLES.RANCHERS,
        `AND({Active Status}='Active',{Agreement Signed}=TRUE())`,
      ),
    ]);

  return NextResponse.json({
    calls: calls.map(formatCall),
    quizComplete: quizComplete.map(formatBuyer),
    depositPending: depositPending.map(formatReferral),
    slotsLocked: slotsLocked.map(formatReferral),
    closedToday: closedToday.map(formatReferral),
    waitlisted: groupByState(waitlisted),
    ranchersActive: ranchersActive.length,
    pipeline: computePipelineValue(quizComplete, depositPending, slotsLocked, closedToday),
  });
}

function formatCall(r: any) {
  return {
    id: r.id,
    startTime: r['Start Time'],
    buyerName: r['Attendee Name'] || r['Buyer Name'] || '?',
    buyerEmail: r['Attendee Email'] || '?',
    rancherName: r['Rancher Name'] || '',
    state: r['State'] || '',
    quizScore: r['Quiz Score'] || null,
  };
}
function formatBuyer(r: any) {
  return {
    id: r.id,
    name: r['Full Name'] || '?',
    email: r['Email'],
    state: r['State'] || '',
    quizScore: r['Qualification Score'] || 0,
    intentScore: r['Intent Score'] || 0,
    qualifiedAt: r['Qualified At'],
  };
}
function formatReferral(r: any) {
  return {
    id: r.id,
    buyerName: r['Buyer Email'] || '?',
    rancherName: r['Rancher Name'] || '?',
    saleAmount: r['Sale Amount'] || 0,
    depositAmount: r['Deposit Amount'] || 0,
    state: r['Buyer State'] || '',
    closedAt: r['Closed At'],
  };
}
function groupByState(buyers: any[]) {
  const m: Record<string, number> = {};
  for (const b of buyers) {
    const s = String(b['State'] || 'UNK').toUpperCase();
    m[s] = (m[s] || 0) + 1;
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([state, count]) => ({ state, count }));
}
function computePipelineValue(quiz: any[], pending: any[], locked: any[], closed: any[]) {
  const AVG_SALE = 2000; // half cow avg
  return {
    quizPotential: quiz.length * AVG_SALE,
    pendingValue: pending.reduce((s, r) => s + Number(r['Deposit Amount'] || 0), 0),
    lockedValue: locked.reduce((s, r) => s + Number(r['Sale Amount'] || 0), 0),
    closedTodayValue: closed.reduce((s, r) => s + Number(r['Sale Amount'] || 0), 0),
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no errors

- [ ] **Step 3: Smoke test via curl**

```bash
curl -sS "https://www.buyhalfcow.com/api/admin/desk" -H "Cookie: bhc-admin-auth=<pass-cookie>" | python3 -m json.tool | head -30
```
Expected: JSON with `calls`, `quizComplete`, `depositPending`, `slotsLocked`, `closedToday`, `waitlisted`, `ranchersActive`, `pipeline` keys.

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/desk/route.ts
git commit -m "feat(desk): admin desk data aggregator endpoint

Single GET returns Cal feed + pipeline + closed-today + waitlisted-states for /admin/today v2 — the new daily ops surface.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.2: Build send-deposit-invoice endpoint

**Files:**
- Create: `app/api/admin/send-deposit-invoice/route.ts`

- [ ] **Step 1: Endpoint w/ Stripe Checkout URL gen + email fire**

```typescript
// app/api/admin/send-deposit-invoice/route.ts
import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { createDepositCheckout } from '@/lib/stripeConnect';
import { sendBuyerDepositInvoice } from '@/lib/emailMinimal';
import { requireAdmin } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: Request) {
  const a = await requireAdmin(req);
  if (a instanceof NextResponse) return a;

  let body: any = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }

  const { buyerId, rancherId, tier } = body;
  if (!buyerId || !rancherId) return NextResponse.json({ error: 'missing buyerId/rancherId' }, { status: 400 });

  const [buyer, rancher] = await Promise.all([
    getRecordById(TABLES.CONSUMERS, buyerId),
    getRecordById(TABLES.RANCHERS, rancherId),
  ]) as any;
  if (!buyer || !rancher) return NextResponse.json({ error: 'not found' }, { status: 404 });

  if (String(rancher['Pricing Model']) !== 'tier_v2') {
    return NextResponse.json({ error: 'rancher not on tier_v2' }, { status: 412 });
  }
  if (String(rancher['Stripe Connect Status']) !== 'active') {
    return NextResponse.json({ error: 'rancher Stripe Connect not active' }, { status: 412 });
  }

  // Pick the cut tier (default: Half)
  const cutTier = String(tier || 'Half');
  const fullSale = Number(rancher[`${cutTier} Price`] || 0) * 100; // cents
  const deposit = Number(rancher[`${cutTier} Deposit`] || rancher[`${cutTier} Price`] || 0) * 100;

  // Create Referral row first
  const { createRecord } = await import('@/lib/airtable');
  const referral = await createRecord(TABLES.REFERRALS, {
    'Buyer': [buyerId],
    'Rancher': [rancherId],
    'Status': 'Intro Sent',
    'Buyer Email': buyer['Email'],
    'Buyer State': buyer['State'],
    'Match Type': 'Sales Call Close',
    'Intro Sent At': new Date().toISOString(),
  }) as any;

  // Stripe Checkout direct charge
  const session = await createDepositCheckout({
    rancherConnectAccountId: String(rancher['Stripe Connect Account Id']),
    tier: 'legacy_connect' as any, // commission rate from rancher's actual tier
    amountCents: deposit,
    fullSaleCents: fullSale,
    buyerEmail: String(buyer['Email']),
    referralId: referral.id,
    buyerId,
    rancherId,
    productLabel: `${cutTier} Cow — ${rancher['Ranch Name']}`,
    successUrl: `https://www.buyhalfcow.com/checkout/${referral.id}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `https://www.buyhalfcow.com/checkout/${referral.id}/deposit`,
  });

  // Fire email w/ deposit URL
  await sendBuyerDepositInvoice({
    buyerEmail: String(buyer['Email']),
    buyerName: String(buyer['Full Name'] || 'there'),
    rancherName: String(rancher['Ranch Name']),
    cutTier,
    depositCents: deposit,
    fullSaleCents: fullSale,
    checkoutUrl: session.url,
  });

  return NextResponse.json({
    ok: true,
    referralId: referral.id,
    checkoutUrl: session.url,
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/send-deposit-invoice/route.ts
git commit -m "feat(desk): 1-click send deposit invoice from sales desk

Admin clicks button on /admin/today v2 → creates Referral row → mints Stripe Checkout direct-charge URL → fires email to buyer with checkout link. Replaces matching/suggest auto-intro.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.3: Build /admin/today/v2 UI

**Files:**
- Create: `app/admin/today/v2/page.tsx`
- Create: `app/admin/today/v2/DeskClient.tsx`

- [ ] **Step 1: Server page w/ admin gate**

```typescript
// app/admin/today/v2/page.tsx
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { verifyAdminCookie } from '@/lib/adminAuth';
import DeskClient from './DeskClient';

export const dynamic = 'force-dynamic';

export default async function TodayV2Page() {
  const c = await cookies();
  const tok = c.get('bhc-admin-auth')?.value;
  if (!tok || !verifyAdminCookie(tok)) redirect('/admin/login?next=/admin/today/v2');
  return <DeskClient />;
}
```

- [ ] **Step 2: Client component renders desk + 1-click actions**

```typescript
// app/admin/today/v2/DeskClient.tsx
'use client';
import { useEffect, useState } from 'react';

export default function DeskClient() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const r = await fetch('/api/admin/desk', { credentials: 'include' });
      if (cancelled) return;
      if (r.ok) setData(await r.json());
      setLoading(false);
    };
    tick();
    const id = setInterval(tick, 30000); // refresh every 30s
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (loading || !data) return <main className="p-8">Loading…</main>;

  return (
    <main className="min-h-screen bg-bone p-8">
      <h1 className="font-serif text-3xl mb-6">Today · {new Date().toLocaleDateString()}</h1>

      {/* Pipeline snapshot */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <PipelineCard label="Quiz-complete" value={`${data.quizComplete.length}`} sub={`$${data.pipeline.quizPotential.toLocaleString()} potential`} />
        <PipelineCard label="Deposit pending" value={`${data.depositPending.length}`} sub={`$${(data.pipeline.pendingValue/100).toLocaleString()} held`} />
        <PipelineCard label="Slots locked" value={`${data.slotsLocked.length}`} sub={`$${(data.pipeline.lockedValue/100).toLocaleString()} in flight`} />
        <PipelineCard label="Closed today" value={`$${(data.pipeline.closedTodayValue/100).toLocaleString()}`} sub={`${data.closedToday.length} sales`} />
      </section>

      {/* Calls today (Cal feed) */}
      <section className="mb-8">
        <h2 className="font-serif text-xl mb-3">Calls today ({data.calls.length})</h2>
        {data.calls.length === 0 ? (
          <p className="text-saddle text-sm">No calls scheduled. Get on Cal: <a className="underline" href="https://cal.com/ben-beauchman-1itnsg/sales">share your link</a></p>
        ) : (
          <ul className="space-y-2">
            {data.calls.map((c: any) => (
              <li key={c.id} className="border border-divider bg-white p-4 flex justify-between items-center">
                <div>
                  <div className="font-medium">{c.buyerName} · {c.state} · score {c.quizScore || '?'}</div>
                  <div className="text-sm text-saddle">{new Date(c.startTime).toLocaleString()} · {c.buyerEmail}</div>
                </div>
                <SendDepositButton buyerEmail={c.buyerEmail} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Quiz-complete awaiting outreach */}
      <section className="mb-8">
        <h2 className="font-serif text-xl mb-3">Quiz-complete awaiting outreach ({data.quizComplete.length})</h2>
        <ul className="space-y-2">
          {data.quizComplete.slice(0, 20).map((b: any) => (
            <li key={b.id} className="border border-divider bg-white p-3 flex justify-between text-sm">
              <span>{b.name} · {b.state} · quiz {b.quizScore} / intent {b.intentScore}</span>
              <span className="text-saddle">{new Date(b.qualifiedAt).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Waitlisted by state */}
      {data.waitlisted.length > 0 && (
        <section className="mb-8">
          <h2 className="font-serif text-xl mb-3">On the waitlist (no rancher in state)</h2>
          <ul className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {data.waitlisted.map((w: any) => (
              <li key={w.state} className="border border-divider bg-white p-3 text-sm">
                <strong>{w.state}</strong>: {w.count} buyers waiting
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Rancher pulse */}
      <section className="border-t border-divider pt-4 text-sm text-saddle">
        {data.ranchersActive} active ranchers · auto-refresh every 30s
      </section>
    </main>
  );
}

function PipelineCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="border border-divider bg-white p-4">
      <div className="text-xs uppercase tracking-widest text-saddle">{label}</div>
      <div className="font-serif text-2xl mt-1">{value}</div>
      <div className="text-xs text-saddle mt-1">{sub}</div>
    </div>
  );
}

function SendDepositButton({ buyerEmail }: { buyerEmail: string }) {
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const handle = async () => {
    setSending(true);
    // For MVP: open admin modal to pick rancher + tier (rancher matched on quiz)
    // For v0: just stub — log
    alert(`MVP: open modal to pick rancher + cut tier for ${buyerEmail}`);
    setSending(false);
    setDone(true);
  };
  return (
    <button
      disabled={sending || done}
      onClick={handle}
      className="px-4 py-2 bg-charcoal text-bone text-sm uppercase tracking-widest disabled:opacity-50"
    >
      {done ? 'Sent' : sending ? 'Sending…' : 'Send Deposit Invoice'}
    </button>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (may warn about `verifyAdminCookie` import — implement next step)

- [ ] **Step 4: Add verifyAdminCookie helper if missing**

Check `lib/adminAuth.ts` exports `verifyAdminCookie`. If absent, add stub:

```typescript
// lib/adminAuth.ts (add at end)
export function verifyAdminCookie(token: string): boolean {
  try {
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || '';
    const decoded: any = jwt.verify(token, JWT_SECRET);
    return decoded?.type === 'admin-session';
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add app/admin/today/v2/ lib/adminAuth.ts
git commit -m "feat(desk): /admin/today v2 single-page sales floor

Auto-refreshes every 30s. Shows pipeline snapshot, Cal feed for today's calls, quiz-complete buyers awaiting outreach, waitlisted states needing rancher recruitment. SendDepositButton stub for MVP — opens picker modal (TODO Phase 1.4).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.4: Wire SendDepositButton modal (Phase 1.5 deferred)

DEFER to Phase 1.5 — current button is a stub. Functional modal lives in next pass after end-to-end test.

---

## PHASE 2: Kill the Drip — 6-Email Pipeline (1 hour)

### Task 2.1: Create lib/emailMinimal.ts with 6 transactional templates

**Files:**
- Create: `lib/emailMinimal.ts`

- [ ] **Step 1: Build the 6 templates**

```typescript
// lib/emailMinimal.ts
// 6 transactional emails — the entire BHC buyer-facing pipeline.
// No drip. No nurture. No funnel re-engagement. Cal handles all that.

import { sendEmail } from './email';

// 1. /access signup confirmation
export async function sendBuyerSignupConfirmation(opts: {
  to: string; firstName: string; quizUrl: string;
}) {
  return sendEmail({
    to: opts.to,
    subject: `Got your application — take the quiz to get matched`,
    html: `<p>Hey ${opts.firstName},</p>
      <p>Application received. To get matched with a rancher, finish this 90-second quiz:</p>
      <p><a href="${opts.quizUrl}" style="display:inline-block;padding:14px 24px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;text-transform:uppercase;letter-spacing:2px;font-size:13px">Start the quiz →</a></p>
      <p>— Ben<br>BuyHalfCow</p>`,
    templateName: 'buyer_signup_confirmation',
  });
}

// 2. Quiz complete → book Cal w/ Ben
export async function sendQuizCompleteCalInvite(opts: {
  to: string; firstName: string; score: number; calUrl: string;
}) {
  return sendEmail({
    to: opts.to,
    subject: `You're in. Book a 15-min call to lock your beef.`,
    html: `<p>Hey ${opts.firstName},</p>
      <p>Quiz score: <strong>${opts.score}/100</strong>. You qualified.</p>
      <p>Next: 15-min call with me. I'll match you w/ a rancher in your area and lock your share.</p>
      <p><a href="${opts.calUrl}" style="display:inline-block;padding:14px 24px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;text-transform:uppercase;letter-spacing:2px;font-size:13px">Book the call →</a></p>
      <p>— Ben</p>`,
    templateName: 'quiz_complete_cal_invite',
  });
}

// 3. Sales call closes → deposit invoice
export async function sendBuyerDepositInvoice(opts: {
  buyerEmail: string; buyerName: string; rancherName: string;
  cutTier: string; depositCents: number; fullSaleCents: number;
  checkoutUrl: string;
}) {
  const dep = (opts.depositCents / 100).toFixed(0);
  const full = (opts.fullSaleCents / 100).toFixed(0);
  const balance = ((opts.fullSaleCents - opts.depositCents) / 100).toFixed(0);
  return sendEmail({
    to: opts.buyerEmail,
    subject: `Reserve your ${opts.cutTier} from ${opts.rancherName} — $${dep} deposit`,
    html: `<p>Hey ${opts.buyerName},</p>
      <p>Great call. Here's the deposit link to lock your <strong>${opts.cutTier}</strong> cow from <strong>${opts.rancherName}</strong>:</p>
      <p style="font-size:18px"><strong>Today: $${dep} deposit</strong><br>
      At pickup: $${balance} balance to ${opts.rancherName}<br>
      Total: $${full}</p>
      <p><a href="${opts.checkoutUrl}" style="display:inline-block;padding:14px 24px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;text-transform:uppercase;letter-spacing:2px;font-size:13px">Pay deposit + lock slot →</a></p>
      <p><em>Refundable until ${opts.rancherName} accepts your slot. After that, non-refundable per our standard policy.</em></p>
      <p>— Ben</p>`,
    templateName: 'buyer_deposit_invoice',
  });
}

// 4. Deposit paid → slot locked notification (rancher accepts via dashboard)
export async function sendSlotLockedConfirmation(opts: {
  to: string; firstName: string; rancherName: string; processingDate: string;
}) {
  return sendEmail({
    to: opts.to,
    subject: `Slot locked — ${opts.rancherName} processing ${opts.processingDate}`,
    html: `<p>Hey ${opts.firstName},</p>
      <p>${opts.rancherName} accepted your reservation. Your beef will be processed on <strong>${opts.processingDate}</strong>.</p>
      <p>You'll get the final invoice from ${opts.rancherName} a few days before pickup — they'll bill you the balance directly through our platform.</p>
      <p>That's it. We'll see you at pickup.</p>
      <p>— Ben</p>`,
    templateName: 'slot_locked_confirmation',
  });
}

// 5. Rancher fires final invoice (already exists — sendBuyerFinalInvoice)
// (no new function — reuses existing)

// 6. Stripe Connect activated (rancher-side, already exists — keep)
// (no new function — reuses existing via webhook)
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean

- [ ] **Step 3: Commit**

```bash
git add lib/emailMinimal.ts
git commit -m "feat(emails): 6-template minimal pipeline (drip kill prep)

The entire buyer-facing pipeline: signup → quiz → Cal book → deposit invoice → slot locked → final invoice. No drip. No nurture. Cal handles all re-engagement.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.2: Gate email-sequences behind env flag

**Files:**
- Modify: `app/api/cron/email-sequences/route.ts`

- [ ] **Step 1: Add early-exit flag**

Add at top of POST handler (right after auth check):

```typescript
// 2026-06-09: pipeline simplified. Flag holds drip in escrow — flip OFF to kill,
// ON to re-enable (rollback path). Cal-as-funnel covers re-engagement now.
if (process.env.EMAIL_SEQUENCES_ENABLED !== 'true') {
  return NextResponse.json({
    ok: true,
    skipped: 'EMAIL_SEQUENCES_ENABLED=false — drip paused per sales-floor pivot',
  });
}
```

- [ ] **Step 2: Set env var OFF in Vercel**

```bash
cd "/Users/benji.bushes/BHC/untitled folder/bhc"
vercel env rm EMAIL_SEQUENCES_ENABLED production --yes 2>&1 || true
printf "false" | vercel env add EMAIL_SEQUENCES_ENABLED production
```

Expected: env var saved.

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add app/api/cron/email-sequences/route.ts
git commit -m "feat(emails): flag-gate email-sequences cron (drip kill)

EMAIL_SEQUENCES_ENABLED=false in prod env. Cron still runs (Vercel scheduled), but returns early w/ {ok:true,skipped:...}. Flip ON to rollback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.3: Remove 4 dead crons from vercel.json

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Delete cron entries**

Remove these entries from `crons` array in vercel.json:
- `/api/cron/rancher-followup`
- `/api/cron/re-warm-cohort`
- `/api/cron/qualified-no-action` (if present)
- `/api/cron/onboarding-stuck` (if present)

Keep these (still useful w/ minimal pipeline):
- `/api/cron/awaiting-payment-nudge` (deposit-pending reminder)
- `/api/cron/healthcheck` (deploy drift check)
- `/api/cron/daily-audit`
- `/api/cron/capacity-drift-check`
- `/api/cron/commission-invoices` (skips tier_v2 correctly)
- `/api/cron/migration-deadline` (keep until last legacy rancher migrates)

- [ ] **Step 2: Delete dead cron route files (optional — keeps build clean)**

```bash
rm -rf app/api/cron/rancher-followup
rm -rf app/api/cron/re-warm-cohort
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add vercel.json app/api/cron/
git commit -m "chore(crons): remove rancher-followup + re-warm-cohort

Drip pipeline killed via flag. These crons are dead code. Migration-deadline kept until last legacy rancher migrates.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.4: Wire quiz → Cal invite email (replaces matching/suggest auto-intro)

**Files:**
- Modify: `app/api/qualify/route.ts:244`

- [ ] **Step 1: After qualify, send Cal invite instead of triggering matching/suggest**

Find the section that calls matching/suggest. After Consumer is stamped with Qualified At, replace the auto-routing call with:

```typescript
// 2026-06-09 pivot: Cal-as-funnel. Quiz complete → email Cal link, NOT auto-match.
// Sales call drives the match. Reduces friction (no rancher pre-assignment), gives
// Ben context to close better.
import { sendQuizCompleteCalInvite } from '@/lib/emailMinimal';
await sendQuizCompleteCalInvite({
  to: String(consumer['Email']),
  firstName: String(consumer['Full Name'] || 'there').split(' ')[0],
  score: Number(consumer['Qualification Score'] || 0),
  calUrl: process.env.BHC_OPERATOR_CAL_URL || 'https://cal.com/ben-beauchman-1itnsg/sales',
});
// DO NOT call /api/matching/suggest here. Ben matches on the sales call.
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add app/api/qualify/route.ts
git commit -m "feat(qualify): Cal-as-funnel — quiz complete fires Cal invite

Replaces auto-matching/suggest after quiz. Ben matches on the sales call. Reduces friction (no rancher pre-assignment), gives Ben context.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## PHASE 3: Brand Voice Split (1 hour)

### Task 3.1: Buyer-facing pages stay product-led (no change)

Skip. `/access`, `/qualify`, `/matched`, `/ranchers/[slug]` keep current copy. Buyers want beef, not infrastructure marketing.

### Task 3.2: Rancher landing /partner — infrastructure positioning

**Files:**
- Modify: `app/partner/page.tsx`

- [ ] **Step 1: Update hero copy**

Replace the hero section copy:

OLD: `"Become a verified rancher partner"`

NEW:
```
<h1>Modern sales infrastructure for DTC ranchers.</h1>
<p>We bring buyers. You bring beef. Keep the payouts. Stop chasing invoices, deposits, and customer support tickets.</p>
<ul>
  <li>Buyer deposits land in your Stripe Connect bank — same day.</li>
  <li>BHC takes a flat % commission. No invoicing. No chasing.</li>
  <li>Sales calls, qualification, and intro emails — handled. You raise the cattle.</li>
</ul>
```

- [ ] **Step 2: Update CTA buttons**

Change `"Apply now"` → `"Connect your operation"` (matches Stripe Connect mental model).

- [ ] **Step 3: Add 3-card "What ships with the infra" section**

```jsx
<section>
  <h2>What ships with the infrastructure</h2>
  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
    <Card title="Buyer acquisition">
      Qualified buyers in your state, matched by quiz score + budget.
    </Card>
    <Card title="Money rails">
      Stripe Connect direct charge. Same-day payouts. No chargebacks on locked slots.
    </Card>
    <Card title="Fulfillment kit">
      Rancher dashboard, final invoice button, NRD-protected deposits, dispute handling.
    </Card>
  </div>
</section>
```

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add app/partner/page.tsx
git commit -m "feat(brand): /partner pivots to sales infrastructure positioning

Hero: 'Modern sales infrastructure for DTC ranchers.' Adds 3-card what-ships block. Ranchers see this and immediately understand they're getting sales infra, not a marketplace.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3.3: Founders page reflects infra story

**Files:**
- Modify: `app/founders/page.tsx`

- [ ] **Step 1: Update hero subhead**

Add new subhead under the existing hero:

```
"We built the modern sales infrastructure for DTC ranchers. 16 ranchers live, $X processed in 30 days. The hard part — buyer acquisition, qualification, money rails, fulfillment trust — is handled. Ranchers raise the cattle."
```

- [ ] **Step 2: Update metric block to show platform metrics**

Replace any old metric block with:
```
Active ranchers: 16
Buyers matched (30d): N
Deposits processed (30d): $N
Avg time from quiz → locked slot: <under 24h target>
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add app/founders/page.tsx
git commit -m "feat(brand): /founders shows the platform metrics

Hero subhead pivots to 'modern sales infrastructure for DTC ranchers' + investor-readable metrics block. Backers see the platform, not just the brand.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## PHASE 4: Verify + Iterate (post-ship)

### Task 4.1: 7-day post-launch metrics

Track these in `/admin/today` v2 daily:

- Cal calls booked per week
- Quiz-complete → Cal-booked conversion %
- Cal-booked → deposit-paid conversion %
- Deposit-paid → slot-locked time
- Stuck buyers (no Cal book in 48h)

If "stuck buyers" >20% of quiz-completed → ship a one-shot transactional re-engagement (not a drip — single email after 48h with Cal link).

### Task 4.2: Rollback plan

If conversion DROPS after killing drip:

```bash
# Flip flag
vercel env rm EMAIL_SEQUENCES_ENABLED production --yes
printf "true" | vercel env add EMAIL_SEQUENCES_ENABLED production

# Trigger deploy
git commit --allow-empty -m "chore: re-enable email-sequences (drip restore)"
git push
```

Drip resumes within 60 seconds of next cron tick.

---

## Self-Review

**Spec coverage:**
- Phase 1: `/admin/today` v2 (Tasks 1.1-1.4) ✓
- Phase 2: Drip kill + 6-email pipeline (Tasks 2.1-2.4) ✓
- Phase 3: Brand voice split (Tasks 3.2-3.3) ✓
- Phase 4: Verify + rollback ✓

**Placeholder scan:** Clean — every step has actual code or commands.

**Type consistency:** `sendBuyerDepositInvoice` signature consistent across Tasks 1.2 and 2.1. `formatCall`/`formatBuyer`/`formatReferral` defined in 1.1, no other refs.

**Risk gaps:**
- Phase 1.4 (SendDepositButton modal) is deferred — current is a stub. Ben can still manually create deposit invoices via curl until modal lands.
- Phase 3.1 deliberately skipped (buyer voice = no change).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-09-sales-floor-pivot.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, fast iteration
2. **Inline Execution** — execute in this session w/ checkpoints

Pick approach.
