// lib/dialCandidates.test.ts
//
// P1-1 follow-on (2026-08-19) — the DIAL QUEUE's deposit source must carry the
// deposit cohort ONLY.
//
// Referral `Status` = 'Awaiting Payment' is overloaded (lib/referralStage): it
// means "the DEPOSIT has not landed" before the rancher accepts and "the
// BALANCE has not landed" after, because send-final-invoice writes it over an
// accepted row. PR #655 split the desk's two money QUEUES on the accept STAMP
// (DEPOSIT_PENDING_FORMULA / ACCEPTED_IN_FLIGHT_FORMULA) and left the dial
// queue out of scope. This file closes that hole, and pins why the accepted
// cohort is EXCLUDED here rather than relabelled:
//
//   • The dial queue's deposit tier means one thing — "money was on the screen
//     and they walked". An accepted deal is the opposite: they PAID, a rancher
//     took the slot, and what is open is the balance.
//   • Left in, those rows do not even reach the deposit tier. `Deposit Paid At`
//     is set, so lib/callbackQueue.dialTierFor drops them to `other` — the
//     cockpit renders "No fresh signal" at priority 15 for the single largest
//     uncollected number in the business.
//   • Worse, that `other` row registers the referral id in
//     lib/cockpitDialList's dedupe map, which SUPPRESSES the close-queue row
//     for the same deal — the one that says "Balance is due — collect it." at
//     up to priority 75 with an "Awaiting Payment · day N" SLA badge.
//   • And the same unsplit list feeds the NBA deposit lane, which reads a paid
//     deposit as "awaiting rancher accept" and tells the operator to
//     "confirm slot or refund" a deal the rancher accepted days ago.
//
// So the balance cohort is not dropped from the operator's day — it is handed
// to the lane that already has the right script for it (lib/closeQueue) and
// the NBA fulfil lane (nbaSlots, which reads isAcceptedInFlight).
//
// Run: JWT_SECRET=test-secret-ci npx tsx --test lib/dialCandidates.test.ts
// (or the full suite: npm test)
//
// All fixtures synthetic — this repo is public.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDialCandidates } from './dialCandidates';
import { dialTierFor } from './callbackQueue';

/** A referral the operator's Airtable read hands over as 'Awaiting Payment'. */
const referral = (over: Record<string, any> = {}) => ({
  id: 'recREF001',
  Status: 'Awaiting Payment',
  Buyer: ['recBUY001'],
  'Buyer Name': 'Test Buyer One',
  'Buyer State': 'TX',
  'Buyer Phone': '5551230000',
  'Buyer Email': 'buyer-one@example.test',
  'Deposit Link Opened At': '2026-08-18T15:00:00Z',
  'Rancher Name': 'Test Ranch',
  'Order Type': 'Half Cow',
  'Total Sale Amount': 1800,
  ...over,
});

// ── The split ───────────────────────────────────────────────────────────────

test('a deposit-pending referral is still a dial candidate, with its deal context', () => {
  const out = buildDialCandidates([], [referral()], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'recBUY001');
  assert.equal(out[0].referralId, 'recREF001');
  assert.equal(out[0].hasLiveDeal, true);
  assert.equal(dialTierFor(out[0]), 'deposit-opened');
});

test('an accepted-in-flight referral is NOT a deposit-chase candidate', () => {
  // The live shape: deposit paid, rancher accepted, final invoice then rewrote
  // Status back to 'Awaiting Payment'. What is open here is the BALANCE.
  const accepted = referral({
    'Deposit Paid At': '2026-08-11T21:40:00Z',
    'Rancher Accepted At': '2026-08-11T21:51:18Z',
  });
  assert.deepEqual(buildDialCandidates([], [accepted], []), []);
});

test('an accepted referral with no deposit stamp is excluded too — the accept is the truth', () => {
  // Off-platform/manual deposits leave `Deposit Paid At` blank. Without the
  // accept-stamp test this row reaches the deposit tier and the cockpit tells
  // the operator "Opened checkout, never paid" about a locked slot.
  const accepted = referral({ 'Rancher Accepted At': '2026-08-11T21:51:18Z' });
  assert.deepEqual(buildDialCandidates([], [accepted], []), []);
});

test('a mixed batch keeps exactly the unaccepted rows', () => {
  const out = buildDialCandidates(
    [],
    [
      referral({ id: 'recREF001', Buyer: ['recBUY001'] }),
      referral({
        id: 'recREF002',
        Buyer: ['recBUY002'],
        'Rancher Accepted At': '2026-08-11T21:51:18Z',
      }),
      referral({ id: 'recREF003', Buyer: ['recBUY003'] }),
    ],
    [],
  );
  assert.deepEqual(
    out.map((c) => c.referralId).sort(),
    ['recREF001', 'recREF003'],
  );
});

test('a Buyer-link-less accepted row is excluded on its own id, not listed under the referral', () => {
  // dialCandidates falls back to the referral id so a link-less row is never
  // silently dropped. That fallback must not smuggle the balance cohort back in.
  const accepted = referral({ Buyer: [], 'Rancher Accepted At': '2026-08-11T21:51:18Z' });
  assert.deepEqual(buildDialCandidates([], [accepted], []), []);
});

// ── What the exclusion does NOT take away ──────────────────────────────────

test('the buyer behind an accepted deal keeps their own callback row, ungrafted', () => {
  // The ask and the balance are two different conversations with two different
  // outcome stamps. Before this split the accepted referral merged its deal
  // context onto the callback row, which registered the referral id in the
  // cockpit's dedupe map and silently suppressed the close-queue row for the
  // deal — so the operator saw the ask and never saw the money.
  const callbackRow = {
    id: 'recBUY001',
    'Full Name': 'Test Buyer One',
    State: 'TX',
    Phone: '5551230000',
    Email: 'buyer-one@example.test',
    'Callback Requested At': '2026-08-19T14:00:00Z',
    'Order Type': 'Half Cow',
  };
  const accepted = referral({ 'Rancher Accepted At': '2026-08-11T21:51:18Z' });

  const out = buildDialCandidates([callbackRow], [accepted], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'recBUY001');
  assert.equal(dialTierFor(out[0]), 'callback');
  assert.equal(out[0].referralId, undefined, 'no referral id ⇒ the deal keeps its own close-queue row');
  assert.equal(out[0].hasLiveDeal, undefined);
});

// ── The surfaces ────────────────────────────────────────────────────────────

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('the cockpit builds its deposit cohort from the accept stamp, not from Status alone', () => {
  // The desk API already reads DEPOSIT_PENDING_FORMULA (PR #655); the cockpit
  // derives the same cohort in JS off its snapshot. A bare Status filter here
  // is the drift that put the balance cohort back in the deposit lane — and it
  // also feeds the NBA deposit rule, which would tell the operator to refund an
  // accepted deal.
  const src = read('../app/api/admin/today/route.ts');
  assert.match(
    src,
    /const depositPending = referrals\.filter\([\s\S]{0,240}?isAcceptedInFlight/,
    'app/api/admin/today/route.ts must exclude accepted-in-flight rows from depositPending',
  );
});

test('the desk API keeps querying the two money cohorts as mutually exclusive sets', () => {
  const src = read('../app/api/admin/desk/route.ts');
  assert.match(src, /DEPOSIT_PENDING_FORMULA/);
  assert.match(src, /ACCEPTED_IN_FLIGHT_FORMULA/);
});
