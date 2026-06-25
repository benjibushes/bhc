# Self-Serve Immediate-Deposit Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a Connect-active (tier_v2 + Stripe Connect `active`) rancher page, "Reserve your share" takes the buyer straight to a Stripe deposit (cut + email only), instead of detouring through the 5-step `/access` qualification quiz.

**Architecture:** A new `POST /api/checkout/reserve` mints consumer + buyer-session + referral (pinned to the chosen rancher) in one call, then returns a `depositUrl` the client redirects to (`/checkout/[refId]/deposit`). The testable decision logic (eligibility gates, referral-field shape, deposit URL) lives in a pure `lib/reserveDeposit.ts`; the session-cookie minting lives in `lib/buyerAuth.ts`. The rancher page's `onConnect` CTAs are rewired from the quiz to a minimal client capture component. Legacy ranchers and the cold-traffic `/access` quiz are untouched.

**Tech Stack:** Next.js 16 App Router, TypeScript, Airtable, Stripe Connect, `jsonwebtoken`, `node:test` via `tsx` (test runner: `npm test` = `tsx --test lib/**/*.test.ts`).

**Why this is safe:** The deposit endpoint already requires (a) a `bhc-member-auth` buyer session and (b) a Referral with `Rancher:[id]` + `Buyer:[consumerId]` (`app/api/checkout/deposit/route.ts:49-58,70-96`). Today only the quiz mints both. This plan mints the same two artifacts directly for a buyer who self-selected the rancher. It does NOT auto-route on Intent Score (the qualify-before-routing rule is about BHC choosing a rancher for a cold buyer; here the buyer chose and is paying).

---

## Decisions locked (from design approval)

- **Fast path collects email + cut only.** Fulfillment is the rancher's job; Stripe Checkout collects the cardholder name; phone is optional later. `name` is accepted if present but never required.
- **CTA layout on `onConnect` ranchers:** PRIMARY "Reserve your share — deposit now" (fast path) + SECONDARY "Prefer to talk first? Book a 15-min call" (existing operator/Cal path). Legacy ranchers keep `RancherOrderForm`.
- **Capacity:** the reserve endpoint bumps capacity exactly like `app/api/orders/request/route.ts:220-228` (Redis INCR + Airtable mirror + `Last Assigned At`) on referral create, to hold the slot during checkout. An abandoned checkout leaves a `Pending` referral that the 6-hourly `capacity-drift-check` reconciles back (Pending is not a held status), so the hold is transient and self-healing. The canonical held-status mismatch (separate audit finding) is OUT OF SCOPE here.
- **Referral status:** created as `Status: 'Pending'`, `Match Type: 'Direct (Rancher Page) — Deposit'`, NO `Approval Status: 'Pending Rancher Response'` (that lead-only flag triggers the "rancher reach out" expectation). The deposit webhook owns later transitions (`Awaiting Payment` → `Closed Won`).
- **No rancher email** is sent by the reserve path (unlike the lead path). The buyer is paying now, not waiting for a callback.

## File structure

- **Create** `lib/reserveDeposit.ts` — pure helpers: `assertReserveEligible`, `buildReserveReferralFields`, `depositPathFor`. One responsibility: the reserve decision/shape logic, unit-testable with fixtures.
- **Create** `lib/reserveDeposit.test.ts` — `node:test` coverage for the three helpers.
- **Modify** `lib/buyerAuth.ts` — add `mintBuyerSessionToken` (pure) + `setBuyerSessionCookie` (applies it to a `NextResponse`). Mirrors `app/api/qualify/route.ts:498-515` exactly.
- **Create** `lib/buyerAuth.test.ts` — `node:test` coverage for `mintBuyerSessionToken` round-trip.
- **Create** `app/api/checkout/reserve/route.ts` — thin POST handler wiring the libs + Airtable I/O + session cookie.
- **Create** `app/ranchers/[slug]/DepositReserveForm.tsx` — minimal client component (cut select + email → POST reserve → redirect).
- **Modify** `app/ranchers/[slug]/page.tsx` — for `onConnect`, render `DepositReserveForm` + the secondary "book a call" CTA in place of the `/access?rancher=` links at `:704-731`, `:1086-1088`, `:1157-1160`. Legacy branch unchanged.

> **WIP guard:** `app/ranchers/[slug]/RancherOrderForm.tsx`, `lib/airtable.ts`, `lib/demoRanchers.ts`, `public/demo/` have uncommitted local changes (Ben's demo-staging + a 1-word "lbs" copy fix). Do NOT revert or restage them. This plan does not modify `RancherOrderForm.tsx` (legacy ranchers keep using it as-is).

---

### Task 1: Buyer-session minter in `lib/buyerAuth.ts`

**Files:**
- Modify: `lib/buyerAuth.ts` (add two exports after the existing `requireBuyer`)
- Test: `lib/buyerAuth.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `lib/buyerAuth.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { mintBuyerSessionToken } from './buyerAuth';

// signJwt/mint read process.env.JWT_SECRET at call time.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-buyerauth';

test('mintBuyerSessionToken signs a member-session JWT with the buyer claims', () => {
  const token = mintBuyerSessionToken({
    consumerId: 'recABC',
    email: 'Buyer@Example.com',
    name: 'Jane Buyer',
    state: 'NE',
  });
  const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
  assert.equal(decoded.type, 'member-session');
  assert.equal(decoded.consumerId, 'recABC');
  assert.equal(decoded.email, 'buyer@example.com'); // lowercased
  assert.equal(decoded.name, 'Jane Buyer');
  assert.equal(decoded.state, 'NE');
});

test('mintBuyerSessionToken tolerates missing name/state', () => {
  const token = mintBuyerSessionToken({ consumerId: 'recX', email: 'a@b.co' });
  const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
  assert.equal(decoded.name, '');
  assert.equal(decoded.state, '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test lib/buyerAuth.test.ts`
Expected: FAIL — `mintBuyerSessionToken` is not exported.

- [ ] **Step 3: Write the implementation**

In `lib/buyerAuth.ts`, add the import for `NextResponse` is already present? It imports `NextResponse` already (line 13). Add `signJwt` import and the two functions at the end of the file:

```typescript
import { signJwt } from '@/lib/jwt';

const BHC_MEMBER_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, matches /api/qualify

export interface BuyerSessionClaims {
  consumerId: string;
  email: string;
  name?: string;
  state?: string;
}

/**
 * Mint a member-session JWT identical to the one /api/qualify + /api/warmup/engage
 * issue (app/api/qualify/route.ts:498-508). resolveBuyerSession reads it back.
 */
export function mintBuyerSessionToken(claims: BuyerSessionClaims): string {
  return signJwt(
    {
      type: 'member-session',
      consumerId: claims.consumerId,
      email: (claims.email || '').trim().toLowerCase(),
      state: claims.state || '',
      name: claims.name || '',
    },
    { expiresIn: '30d' },
  );
}

/**
 * Set the bhc-member-auth cookie on a NextResponse. Mirrors the cookie options
 * at app/api/qualify/route.ts:509-515 EXACTLY so resolveBuyerSession works on
 * both the quiz path and the direct-deposit path.
 */
export function setBuyerSessionCookie(res: NextResponse, claims: BuyerSessionClaims): NextResponse {
  res.cookies.set(BHC_MEMBER_COOKIE, mintBuyerSessionToken(claims), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: BHC_MEMBER_COOKIE_MAX_AGE,
    path: '/',
  });
  return res;
}
```

Note: `BHC_MEMBER_COOKIE` is already defined at the top of the file (`'bhc-member-auth'`, line 17). Reuse it — do not redefine.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test lib/buyerAuth.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add lib/buyerAuth.ts lib/buyerAuth.test.ts
git commit -m "feat(buyer-auth): add mintBuyerSessionToken + setBuyerSessionCookie"
```

---

### Task 2: Pure reserve logic in `lib/reserveDeposit.ts`

**Files:**
- Create: `lib/reserveDeposit.ts`
- Test: `lib/reserveDeposit.test.ts`

**Context the implementer needs:**
- `isRancherOnConnect(rancher)` — `lib/rancherEligibility.ts:154`, true iff `Pricing Model==='tier_v2'` AND `Stripe Connect Status==='active'` (case-insensitive).
- `isRancherOperationalForBuyers(rancher)` — `lib/rancherEligibility.ts` (same module). Returns boolean.
- `isValidTierPrice(p)` — `lib/pricing.ts:124`, returns `p === 0 || p >= MIN_TIER_PRICE` (MIN_TIER_PRICE=100). For the reserve gate we need price PRESENT and ≥ MIN_TIER_PRICE, so check `price >= MIN_TIER_PRICE` directly (a 0/unset price must fail, unlike `isValidTierPrice`).
- Per-cut price fields on a rancher record: `'Quarter Price'`, `'Half Price'`, `'Whole Price'`.

- [ ] **Step 1: Write the failing test**

Create `lib/reserveDeposit.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReserveEligible, buildReserveReferralFields, depositPathFor } from './reserveDeposit';

const activeRancher = {
  id: 'recRanch',
  'Ranch Name': 'Renick Valley',
  'Operator Name': 'Renick',
  'Pricing Model': 'tier_v2',
  'Stripe Connect Status': 'active',
  'Active Status': 'Active',
  'Quarter Price': 1250,
  'Half Price': 2400,
  'Whole Price': 4600,
};

test('eligible: tier_v2 active rancher with a priced cut', () => {
  assert.deepEqual(assertReserveEligible(activeRancher, 'half'), { ok: true });
});

test('legacy rancher → 409 fallback', () => {
  const r = { ...activeRancher, 'Pricing Model': 'legacy' };
  const res = assertReserveEligible(r, 'half');
  assert.equal(res.ok, false);
  if (!res.ok) { assert.equal(res.status, 409); assert.equal(res.fallback, true); }
});

test('connect not active → 409', () => {
  const r = { ...activeRancher, 'Stripe Connect Status': 'onboarding' };
  const res = assertReserveEligible(r, 'half');
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 409);
});

test('cut not priced / below MIN_TIER_PRICE → 409', () => {
  const r = { ...activeRancher, 'Half Price': 7.4 }; // per-lb mis-entry
  const res = assertReserveEligible(r, 'half');
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 409);
});

test('unpriced cut (missing field) → 409', () => {
  const r = { ...activeRancher, 'Whole Price': 0 };
  const res = assertReserveEligible(r, 'whole');
  assert.equal(res.ok, false);
});

test('buildReserveReferralFields pins Rancher + Buyer, no lead Approval Status', () => {
  const f = buildReserveReferralFields({
    rancher: activeRancher,
    consumerId: 'recBuyer',
    buyerName: '',
    buyerEmail: 'jane@example.com',
    cut: 'half',
  });
  assert.deepEqual(f.Rancher, ['recRanch']);
  assert.deepEqual(f.Buyer, ['recBuyer']);
  assert.equal(f.Status, 'Pending');
  assert.equal(f['Match Type'], 'Direct (Rancher Page) — Deposit');
  assert.equal(f['Order Type'], 'Half Cow');
  assert.equal(f['Approval Status'], undefined); // NOT a lead
  assert.match(String(f.Name), /jane@example\.com/);
});

test('depositPathFor builds the cut-prefilled deposit url', () => {
  assert.equal(depositPathFor('recRef', 'half'), '/checkout/recRef/deposit?cut=half');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test lib/reserveDeposit.test.ts`
Expected: FAIL — module `./reserveDeposit` not found.

- [ ] **Step 3: Write the implementation**

Create `lib/reserveDeposit.ts`:

```typescript
// Pure decision + shape logic for the self-serve deposit ("reserve") path.
// The thin route (app/api/checkout/reserve/route.ts) does the Airtable I/O
// and session minting; everything testable lives here.

import { isRancherOnConnect, isRancherOperationalForBuyers } from '@/lib/rancherEligibility';
import { MIN_TIER_PRICE } from '@/lib/pricing';

export type Cut = 'quarter' | 'half' | 'whole';

export const CUT_LABELS: Record<Cut, string> = {
  quarter: 'Quarter Cow',
  half: 'Half Cow',
  whole: 'Whole Cow',
};

const CUT_PRICE_FIELD: Record<Cut, string> = {
  quarter: 'Quarter Price',
  half: 'Half Price',
  whole: 'Whole Price',
};

export type ReserveEligibility =
  | { ok: true }
  | { ok: false; status: number; error: string; fallback?: boolean };

/**
 * Gate a reserve attempt so the buyer never bounces at the deposit page.
 * Mirrors the deposit route's own gates (app/api/checkout/deposit/route.ts:
 * 108-126, 183-193) but fails BEFORE we create anything.
 */
export function assertReserveEligible(rancher: any, cut: Cut): ReserveEligibility {
  if (!CUT_LABELS[cut]) {
    return { ok: false, status: 400, error: 'cut must be quarter|half|whole' };
  }
  if (!isRancherOnConnect(rancher)) {
    return {
      ok: false,
      status: 409,
      error: 'This rancher takes orders through our standard flow.',
      fallback: true, // client falls back to the lead form / quiz
    };
  }
  if (!isRancherOperationalForBuyers(rancher)) {
    return {
      ok: false,
      status: 409,
      error: 'This rancher is not taking orders right now.',
      fallback: true,
    };
  }
  const price = Number(rancher[CUT_PRICE_FIELD[cut]]) || 0;
  if (price < MIN_TIER_PRICE) {
    return {
      ok: false,
      status: 409,
      error: 'That share is not priced for online deposit yet.',
      fallback: true,
    };
  }
  return { ok: true };
}

/**
 * Airtable field set for a deposit-intent referral. Pins Rancher + Buyer so
 * the deposit route's ownership + rancher lookup succeed. Deliberately omits
 * 'Approval Status' so it is NOT treated as a callback lead.
 */
export function buildReserveReferralFields(args: {
  rancher: any;
  consumerId: string;
  buyerName: string;
  buyerEmail: string;
  cut: Cut;
}): Record<string, any> {
  const ranchName = String(args.rancher['Ranch Name'] || args.rancher['Operator Name'] || 'Rancher');
  const who = args.buyerName || args.buyerEmail;
  return {
    Name: `${who} → ${ranchName} · ${CUT_LABELS[args.cut]}`,
    Status: 'Pending',
    'Match Type': 'Direct (Rancher Page) — Deposit',
    'Buyer Name': args.buyerName || '',
    'Buyer Email': args.buyerEmail,
    'Order Type': CUT_LABELS[args.cut],
    'Intent Score': 90,
    'Intent Classification': 'High',
    Notes: '[Source] Self-serve deposit (rancher page, no quiz)',
    Rancher: [args.rancher.id],
    Buyer: [args.consumerId],
  };
}

export function depositPathFor(referralId: string, cut: Cut): string {
  return `/checkout/${referralId}/deposit?cut=${cut}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test lib/reserveDeposit.test.ts`
Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add lib/reserveDeposit.ts lib/reserveDeposit.test.ts
git commit -m "feat(reserve): pure eligibility + referral-shape helpers for deposit path"
```

---

### Task 3: `POST /api/checkout/reserve` route

**Files:**
- Create: `app/api/checkout/reserve/route.ts`

**Context the implementer needs (verified call sites to copy):**
- Consumer upsert by email: `app/api/orders/request/route.ts:152-176` (find by `LOWER({Email})`, else `createRecord(TABLES.CONSUMERS, {...})`).
- Referral create + capacity bump: `app/api/orders/request/route.ts:204-228`.
- Airtable helpers: `import { TABLES, createRecord, updateRecord, getAllRecords, getRancherBySlug, escapeAirtableValue } from '@/lib/airtable';`
- Capacity: `import { incrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';`
- Session: `import { setBuyerSessionCookie } from '@/lib/buyerAuth';` and `resolveBuyerSession` for the logged-in shortcut.
- CSRF: `import { checkOriginGuard } from '@/lib/csrfGuard';` (used by the deposit route at `:46`).

- [ ] **Step 1: Write the route**

Create `app/api/checkout/reserve/route.ts`:

```typescript
// Self-serve deposit "reserve" — the fast path behind a Connect-active rancher
// page's "Reserve your share — deposit now" CTA. Mints consumer + buyer session
// + referral pinned to the rancher, then returns a depositUrl the client
// redirects to. No quiz, no rancher callback email. Legacy/ineligible ranchers
// get a 409 with fallback=true so the client routes to the lead form/quiz.

import { NextResponse } from 'next/server';
import {
  TABLES,
  createRecord,
  updateRecord,
  getAllRecords,
  getRancherBySlug,
  escapeAirtableValue,
} from '@/lib/airtable';
import { incrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import { resolveBuyerSession, setBuyerSessionCookie } from '@/lib/buyerAuth';
import { checkOriginGuard } from '@/lib/csrfGuard';
import {
  assertReserveEligible,
  buildReserveReferralFields,
  depositPathFor,
  CUT_LABELS,
  type Cut,
} from '@/lib/reserveDeposit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function isValidEmail(s: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(s);
}

export async function POST(req: Request) {
  const originCheck = checkOriginGuard(req);
  if (!originCheck.ok && originCheck.response) return originCheck.response;

  let body: any = {};
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

  const slug = String(body.slug || '').trim();
  const cut = String(body.cut || '').toLowerCase() as Cut;
  const nameInput = String(body.name || '').trim();
  const emailInput = String(body.email || '').trim().toLowerCase();

  if (!slug) return NextResponse.json({ error: 'Rancher slug required' }, { status: 400 });
  if (!CUT_LABELS[cut]) return NextResponse.json({ error: 'cut must be quarter|half|whole' }, { status: 400 });

  // Logged-in buyer shortcut: reuse their session identity, skip email collect.
  const existingSession = await resolveBuyerSession(req);

  let buyerEmail = existingSession?.email || emailInput;
  let buyerName = existingSession?.name || nameInput;
  let buyerState = existingSession?.state || '';
  let consumerId = existingSession?.consumerId || '';

  if (!existingSession && !isValidEmail(buyerEmail)) {
    return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
  }

  // Look up + gate the rancher BEFORE creating anything.
  let rancher: any;
  try { rancher = await getRancherBySlug(slug); }
  catch { return NextResponse.json({ error: 'Rancher lookup failed' }, { status: 500 }); }
  if (!rancher) return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });

  const gate = assertReserveEligible(rancher, cut);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error, fallback: gate.fallback === true },
      { status: gate.status },
    );
  }

  // Find or create the Consumer (so abandoned-deposit recovery + CAPI work).
  if (!consumerId) {
    try {
      const safeEmail = escapeAirtableValue(buyerEmail);
      const existing: any[] = await getAllRecords(
        TABLES.CONSUMERS,
        `LOWER({Email}) = "${safeEmail.toLowerCase()}"`,
      );
      if (existing.length > 0) {
        consumerId = existing[0].id;
        buyerName = buyerName || existing[0]['Full Name'] || '';
        buyerState = buyerState || existing[0]['State'] || '';
      } else {
        const created: any = await createRecord(TABLES.CONSUMERS, {
          'Full Name': buyerName || '',
          'Email': buyerEmail,
          'Segment': 'Beef Buyer',
          'Source': `rancher-page-deposit:${slug}`,
          'Order Type': CUT_LABELS[cut],
          'Interest Beef': true,
          'Intent Score': 90,
          'Intent Classification': 'High',
        });
        consumerId = created.id;
      }
    } catch (e: any) {
      console.error('[checkout/reserve] consumer upsert failed:', e?.message);
      return NextResponse.json({ error: 'Could not start your reservation — try again.' }, { status: 500 });
    }
  }

  // Create the deposit-intent referral pinned to the rancher.
  let referral: any;
  try {
    referral = await createRecord(
      TABLES.REFERRALS,
      buildReserveReferralFields({ rancher, consumerId, buyerName, buyerEmail, cut }),
    );
  } catch (e: any) {
    console.error('[checkout/reserve] referral create failed:', e?.message);
    return NextResponse.json({ error: 'Could not start your reservation — try again.' }, { status: 500 });
  }

  // Hold the slot during checkout (mirror orders/request:220-228). Transient:
  // an abandoned Pending referral is reconciled by capacity-drift-check.
  try {
    const newCount = await incrementCapacity(rancher.id);
    await syncCapacityToAirtable(rancher.id, newCount);
    await updateRecord(TABLES.RANCHERS, rancher.id, { 'Last Assigned At': new Date().toISOString() });
  } catch (e: any) {
    console.warn('[checkout/reserve] capacity bump skipped:', e?.message);
  }

  // Mint the buyer session + return the deposit URL. Cookie rides on this JSON
  // response so the subsequent deposit page GET/POST are authenticated.
  const res = NextResponse.json({
    referralId: referral.id,
    depositUrl: depositPathFor(referral.id, cut),
  });
  return setBuyerSessionCookie(res, { consumerId, email: buyerEmail, name: buyerName, state: buyerState });
}
```

- [ ] **Step 2: Typecheck the route**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors). If `getRancherBySlug` or a TABLES key name differs, fix the import to match `lib/airtable.ts` exactly (it is used identically at `app/api/orders/request/route.ts:5-9,126`).

- [ ] **Step 3: Commit**

```bash
git add app/api/checkout/reserve/route.ts
git commit -m "feat(reserve): POST /api/checkout/reserve mints consumer+session+referral → depositUrl"
```

---

### Task 4: `DepositReserveForm` client component + rancher-page wiring

**Files:**
- Create: `app/ranchers/[slug]/DepositReserveForm.tsx`
- Modify: `app/ranchers/[slug]/page.tsx` (the three `onConnect` CTA blocks at `:704-731`, `:1086-1088`, `:1157-1160`)

**Context the implementer needs:**
- `page.tsx` is a server component. It already computes `const onConnect = isRancherOnConnect(r);` at `:282`, `name`/`operatorFirst`, and the per-cut price/lbs used by `RancherOrderForm` at `:736`. Reuse those exact values.
- The secondary "book a call" target: the page already renders the operator-call surface around `:765` ("Pick a time and I'll have your slot reserved"). Read `:755-790` and reuse the SAME booking URL/value there for the new secondary CTA (do not invent a new link). If that block uses a helper like `getOperatorBookingUrl()`, pass its already-awaited value into `DepositReserveForm` as a prop `bookingUrl`.
- `track` client analytics: `import { track } from '@/lib/track';` (same as `RancherOrderForm.tsx:4`).

- [ ] **Step 1: Write the client component**

Create `app/ranchers/[slug]/DepositReserveForm.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { track } from '@/lib/track';

type Cut = 'quarter' | 'half' | 'whole';

interface CutData { price: number; lbs?: string }

interface Props {
  slug: string;
  ranchName: string;
  operatorFirst: string;
  bookingUrl: string;            // operator "talk first" Cal link (from page.tsx)
  quarter?: CutData;
  half?: CutData;
  whole?: CutData;
}

const CUT_LABEL: Record<Cut, string> = { quarter: 'Quarter', half: 'Half', whole: 'Whole' };

export default function DepositReserveForm({
  slug, ranchName, operatorFirst, bookingUrl, quarter, half, whole,
}: Props) {
  const [cut, setCut] = useState<Cut | null>(null);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const cutData = (c: Cut) => (c === 'quarter' ? quarter : c === 'half' ? half : whole);

  function pick(c: Cut) {
    track('AddToCart', { content_name: ranchName, content_category: CUT_LABEL[c], ranchSlug: slug, value: cutData(c)?.price || 0, currency: 'USD' });
    setCut(c);
    setError('');
  }

  async function reserve(e: React.FormEvent) {
    e.preventDefault();
    if (!cut) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/checkout/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ slug, cut, email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Ineligible (legacy/paused/unpriced) → fall back to the standard flow.
        if (data?.fallback) { window.location.href = `/access?rancher=${slug}`; return; }
        setError(data?.error || 'Something went wrong — try again.');
        setLoading(false);
        return;
      }
      track('InitiateCheckout', { content_name: ranchName, ranchSlug: slug, value: cutData(cut)?.price || 0, currency: 'USD' });
      window.location.href = data.depositUrl; // → /checkout/[refId]/deposit?cut=…
    } catch {
      setError('Network error — try again.');
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        {(['whole', 'half', 'quarter'] as Cut[]).map((c) =>
          cutData(c) ? (
            <button
              key={c}
              type="button"
              onClick={() => pick(c)}
              className={`border p-3 text-sm ${cut === c ? 'border-saddle bg-saddle text-bone' : 'border-dust bg-white text-charcoal'}`}
            >
              <span className="block font-medium">{CUT_LABEL[c]}</span>
              <span className="block text-xs">${(cutData(c)!.price).toLocaleString()}</span>
            </button>
          ) : null,
        )}
      </div>

      <form onSubmit={reserve} className="space-y-3">
        <input
          type="email"
          required
          placeholder="Your email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-4 py-3 border border-dust bg-white text-sm"
        />
        {error && <p className="text-sm text-rust">{error}</p>}
        <button
          type="submit"
          disabled={loading || !cut}
          className="w-full py-4 bg-charcoal text-bone text-sm font-medium tracking-wide uppercase hover:bg-saddle transition-colors disabled:opacity-50"
        >
          {loading ? 'Starting…' : cut ? `Reserve your ${CUT_LABEL[cut]} — deposit now →` : 'Pick a share above'}
        </button>
        <p className="text-[11px] text-dust text-center">
          A small deposit holds your share. {operatorFirst} ships it straight to you.
        </p>
      </form>

      <a href={bookingUrl} className="block text-center text-xs text-saddle underline underline-offset-2 hover:text-charcoal">
        Prefer to talk first? Book a 15-min call →
      </a>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `page.tsx` — primary CTA block (`:704-731`)**

Read `app/ranchers/[slug]/page.tsx:680-760`. Add the import near the other component imports (next to `import RancherOrderForm from './RancherOrderForm';` at `:15`):

```tsx
import DepositReserveForm from './DepositReserveForm';
```

Replace the `onConnect ? ( … href={`/access?rancher=${slug}`} … ) : ( <RancherOrderForm … /> )` ternary (the `onConnect` branch at `:704-735`) so the `onConnect` branch renders the form instead of the quiz link:

```tsx
{onConnect ? (
  <DepositReserveForm
    slug={slug}
    ranchName={name}
    operatorFirst={operatorFirst || name}
    bookingUrl={operatorBookingUrl}
    quarter={quarter?.price ? { price: quarter.price, lbs: quarter.lbs } : undefined}
    half={half?.price ? { price: half.price, lbs: half.lbs } : undefined}
    whole={whole?.price ? { price: whole.price, lbs: whole.lbs } : undefined}
  />
) : (
  <RancherOrderForm
    slug={slug}
    rancherName={operatorFirst || name}
    ranchName={name}
    quarter={quarter}
    half={half}
    whole={whole}
  />
)}
```

Use the SAME `quarter`/`half`/`whole` objects already passed to `RancherOrderForm` at `:736-746` (read those exact prop values and reuse them). `operatorBookingUrl` must be the value the page already resolves for the operator-call block near `:765` — if it is computed inline there, lift it to a `const operatorBookingUrl = …` above the return (around `:282`) and reuse it in both places.

- [ ] **Step 3: Wire the secondary CTA blocks (`:1086-1088`, `:1157-1160`)**

These two are smaller `onConnect ? <Link href={`/access?rancher=${slug}`}>…</Link> : …` CTAs lower on the page. For each, change the `onConnect` branch's `href` from `/access?rancher=${slug}` to an anchor that scrolls to the primary reserve form (give the primary `DepositReserveForm` wrapper an `id="reserve"` in Step 2 and point these at `#reserve`):

```tsx
href={onConnect ? '#reserve' : '/access'}
```

Keep the non-`onConnect` (legacy) branch exactly as-is.

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS. Fix any prop-type mismatch by matching the exact `quarter/half/whole` shape `page.tsx` already builds for `RancherOrderForm`.

- [ ] **Step 5: Commit**

```bash
git add "app/ranchers/[slug]/DepositReserveForm.tsx" "app/ranchers/[slug]/page.tsx"
git commit -m "feat(rancher-page): onConnect CTA → self-serve deposit form (primary) + book-a-call (secondary)"
```

---

### Task 5: Verify the loop end-to-end (no synthetic prod buyer)

**Constraint:** Do NOT fire a synthetic buyer into the prod `/api/consumers` or `/api/checkout/reserve` against production data (Ben's "no e2e tests to clients" rule). Verify by unit tests + local dev + code trace only.

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS — includes `lib/buyerAuth.test.ts`, `lib/reserveDeposit.test.ts`, and the pre-existing `lib/capacityCount.test.ts`. No regressions.

- [ ] **Step 2: Local dev smoke (against a dev/staging Airtable only, never prod)**

Only if a local dev server with non-prod Airtable is available:
Run: `npm run dev` (port per repo config), then in a second shell:
```bash
curl -s -i -X POST http://localhost:3456/api/checkout/reserve \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:3456' \
  -d '{"slug":"<a tier_v2 active dev rancher slug>","cut":"half","email":"reserve-smoke@test.local"}'
```
Expected: `200` with `{ referralId, depositUrl: "/checkout/<id>/deposit?cut=half" }` AND a `Set-Cookie: bhc-member-auth=…` header. A legacy/unpriced dev rancher → `409` with `{ fallback: true }`.
If no non-prod Airtable is wired, SKIP this step and rely on Steps 1 + 3 — do not point it at prod.

- [ ] **Step 3: Code-trace the deposit handoff**

Confirm by reading: the cookie minted in Task 1 satisfies `resolveBuyerSession` (`lib/buyerAuth.ts:32-51`, same `type:'member-session'` + `consumerId`), and the referral built in Task 2 satisfies the deposit route's checks — `referral['Buyer'].includes(session.consumerId)` (`app/api/checkout/deposit/route.ts:70-73`) and `referral['Rancher'][0]` present (`:94-96`), Status `Pending` not terminal (`:80-92`). Write one sentence per check confirming it holds.

- [ ] **Step 4: Final commit / branch is ready for PR**

```bash
git log --oneline -6
git status --short   # only the new feature files + page.tsx; Ben's demo WIP untouched
```
Expected: the five feature commits present; `RancherOrderForm.tsx`, `lib/airtable.ts`, `lib/demoRanchers.ts`, `public/demo/` still show their pre-existing uncommitted state (NOT staged by us).

---

## Self-review

**Spec coverage:** reserve endpoint (Task 3) ✓; setBuyerSessionCookie (Task 1) ✓; pure gates + referral shape (Task 2) ✓; client component + page rewire primary/secondary (Task 4) ✓; capacity decision documented (Decisions + Task 3 Step 1) ✓; all five test cases — tier_v2 happy path returns depositUrl (Task 2 + Task 5 Step 2), legacy→409 (Task 2), non-operational→409 (Task 2), underpriced→409 (Task 2), bad email→400 (route, Task 3), existing-consumer reuse (Task 3 code path), minted-session passes deposit ownership (Task 5 Step 3) ✓.

**Placeholder scan:** no TBD/“add error handling”/uncoded steps; every code step shows complete code. The two soft spots are deliberate read-then-apply instructions (the exact `quarter/half/whole` prop objects and the `operatorBookingUrl` value already in `page.tsx`) because those values are local to a 1000-line existing file and must match what's there — the implementer is told the exact lines to read.

**Type consistency:** `Cut` type, `CUT_LABELS`, `depositPathFor`, `mintBuyerSessionToken`/`setBuyerSessionCookie`, `assertReserveEligible`/`buildReserveReferralFields` names are identical across Tasks 1–4. Referral fields (`Rancher`, `Buyer`, `Status:'Pending'`, `Match Type`, `Order Type`) match what `app/api/checkout/deposit/route.ts` reads.

**Out of scope (tracked separately):** the audit's capacityCount held-status mismatch (#8), the stripe-connect webhook secret (#1), email-sequences (#2). This plan must not expand into them.

---

## v2 — Best-case full money-path scope (added 2026-06-25 after research + audit)

A cited research pass (Baymard / Stripe matched-cohort data) + a money-path audit found the Renick misroute is **systemic**: every Connect-rancher buy CTA points at `/access?rancher=slug`, the quiz's reveal has **no deposit branch** (it ends at a Cal call), and the deposit Checkout leaves one-tap wallets/Link OFF. Best case = every buyer entry reaches a fast, wallet-enabled deposit with no dead-ends. New/changed tasks below; Tasks 1–4 above are unchanged except Task 4's CTA list (expanded here).

### Task 0: Wallets + Link on the deposit Checkout (CORRECTED — operational, NOT a code param)
- **Stripe-verified 2026-06-25:** Checkout Sessions have **no** `automatic_payment_methods` param (it is PaymentIntent-only; passing it 400s the session — do NOT add it). The deposit session already OMITS `payment_method_types`, so it uses **dynamic payment methods** — Apple Pay / Google Pay / Link render automatically once enabled on the connected account + the Apple Pay domain is registered. `customer_email` is already passed (Link recognizes returning buyers). Code is already correct; a clarifying comment was added to `lib/stripeConnect.ts` so no one re-adds the bad param.
- **Operational (Ben — the actual lever):** (1) register the Apple Pay domain at `dashboard.stripe.com/settings/payment_method_domains` for the **direct-charge** Connect funds flow; (2) confirm connected accounts have Apple Pay / Google Pay / Link enabled. Research impact: Apple Pay +22% conv / 2x surfaced early; Link +14% returning.
- **Optional code lever (defer):** create a platform `payment_method_configuration` (wallets + Link on) and pass `payment_method_configuration: <id>` on the deposit session so availability is platform-controlled, not per-rancher-Dashboard-dependent. Only if rancher Dashboards prove inconsistent.

### Task 4 (expanded): rewire ALL four Connect CTAs + research polish
- Rewire to the reserve fast-path (not `/access?rancher=`): `app/ranchers/[slug]/page.tsx:725` (primary), `:1088` (Buy now / custom products), `:1157` (bottom reserve), AND `app/ranchers/[slug]/pay/[tier]/route.ts:108` (the tracking redirect — point Connect ranchers at `#reserve`/the reserve flow, not the quiz).
- `DepositReserveForm`: **default cut = HALF** (pre-selected — default effect, brand namesake), single **action+value CTA** ("Reserve my half — pay $X deposit"), and the **BHC Promise line** ("Deposit fully refundable for 7 days") directly under the button (guarantees near the CTA lift conversion +6–32%; keep it the only trust embellishment). Charm-priced deposit ($X9) = A/B later, not now.

### Task 6: Honor `?cut=` on the deposit page (one screen, no re-pick)
**Files:** Modify `app/checkout/[refId]/deposit/page.tsx`.
- Today `selectedCut` defaults to `'half'` then the load effect overrides to half/first-cut (`:70,103-105`); `?cut=` is ignored (only `canceled` is read, `:65`). The reserve redirect's `?cut=half` therefore does nothing → buyer re-picks.
- Add `const cutParam = search.get('cut');` and in the load `.then`, before the default logic: `if (cutParam && j.cuts?.find((c: Cut) => c.slug === cutParam)) { setSelectedCut(cutParam); }` (else keep existing default). When a valid `cut` param is present, render the chosen-cut summary + deposit amount + Promise + one "Pay $X deposit" button instead of the re-pick grid.
- Verify: `npx tsc --noEmit && npm run build`. Commit.

### Task 7: Member reorder → 1-tap deposit (highest-LTV, easy)
**Files:** Modify `app/api/member/reorder/route.ts:203-208` + the `/member` reorder client.
- The reorder already mints a referral (`referralId`) pinned to the rancher and the buyer is logged in (member session). When `matchOk && referralId` AND the matched rancher is tier_v2 Connect-active (`isRancherOnConnect`), add to the JSON response: `depositUrl: \`/checkout/${referralId}/deposit?cut=${cutSlug}\`` where `cutSlug` derives from `orderType` ('Quarter Cow'→'quarter', etc.). The client redirects to `depositUrl` when present (else current behavior).
- Verify: `npx tsc --noEmit`. Commit.

### Task 8: Warmup "I'm ready to buy" YES → deposit for deposit-ready buyers (heaviest)
**Files:** Modify `app/api/warmup/engage/route.ts:288-308`.
- Today first-time YES redirects to `/qualify/<id>?token=` (the quiz). The member-session cookie is already minted at `:301`.
- Before the `/qualify` handoff, attempt an immediate eligibility match: is there a tier_v2 Connect-active rancher operational in the buyer's state (reuse the matching engine / `hasOperationalRancherForState` + a deposit-ready filter)? If yes → fire the direct-pick referral (campaign `rancher-` style) to mint `referralId`, set `handoffUrl = \`${SITE_URL}/checkout/${referralId}/deposit?cut=${cut}\``. If no deposit-ready rancher → KEEP the existing `/qualify` quiz/waitlist path unchanged (the safe fallback).
- Gate carefully: only deposit-ready in-state matches skip the quiz; everyone else flows as today. Verify with a unit test on the eligibility branch. Commit.

### Task 9: Dedicated tier_v2 deposit email (unsuppress the built one-tap link)
**Files:** Modify `lib/email.ts` (new function) + `app/api/matching/suggest/route.ts` (tier_v2 branch).
- `depositMagicLinkUrl` (one-tap → `/api/auth/member/verify?...&next=/checkout/<ref>/deposit`) is built at `app/api/matching/suggest/route.ts:1198-1201` but gated by `!suppressBuyerIntro`; tier_v2 sends `skipBuyerIntro:true` (`app/api/qualify/route.ts:262`), so matched tier_v2 buyers get no deposit link by email.
- READ `app/api/qualify/route.ts:255-270` + `app/api/matching/suggest/route.ts:1190-1220` first to confirm the suppress flag wiring. Then: for tier_v2 matches, instead of full suppression, send a dedicated `sendBuyerDepositLink()` email (extend `lib/email.ts`) — subject `reserve your share — your deposit link` — carrying `depositMagicLinkUrl`. Keep the operator-call path intact (this is additive: buyer gets a self-serve pay link AND can still book the call).
- Verify: `npx tsc --noEmit`. Commit.

### Execution order (highest leverage first)
0 (done) → 1 → 2 → 3 → 4 (incl. expanded CTAs + polish) → 6 → 7 → 8 → 9. Tasks 0/6/7 are small and high-impact; 1–4 are the core; 8/9 are the heaviest. Each task: TDD where a pure lib exists, `tsc`/`build` gate, commit. No synthetic buyer fired at prod (verify via unit tests + local dev + code trace).
