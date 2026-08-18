// lib/depositRelease.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/depositRelease.test.ts
//
// The refusal tests are the point of this file. This rail flips rows in
// 'Awaiting Payment' — the one status that means money was asked for — so
// every money gate gets its own named test, and the fail-closed paths
// (missing probe, failed read, corrupt stamp) are pinned as hard as the
// happy path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  staticReleaseRefusal,
  depositReleaseRefusal,
  isDepositReleaseEligible,
  selectDepositReleaseCandidates,
  refusalBreakdown,
  releaseNoteStamp,
  probeFromPayments,
  PAYMENTS_PROBE_FAILED,
  MONEY_STAMP_FIELDS,
  HARMLESS_PAYMENT_STATUSES,
  DEPOSIT_RELEASE_SILENCE_DAYS,
  DEPOSIT_RELEASE_STATUS,
  DEPOSIT_RELEASE_LOSS_REASON,
} from './depositRelease';
import {
  DEPOSIT_NUDGE_LIFETIME_CAP,
  DEPOSIT_NUDGE_SUPPRESSED_SENTINEL,
  isDepositNudgeEligible,
} from './depositRequestNudge';
import { LOSS_REASON_CHOICES, isExcludingLossReason } from './lossReasons';
import { HELD_REFERRAL_STATUSES, isActiveDealReferral } from './capacityCount';

const NOW = new Date('2026-07-30T12:00:00Z').getTime();
const days = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();
const clean = { ok: true, hasLivePayment: false };

// The live cohort, exactly: requested 27d ago, both nudges spent 22d ago, the
// deposit link NEVER opened, 'Deposit Amount' stamped at request time.
const stuck = (over: any = {}) => ({
  id: 'recStuck',
  Status: 'Awaiting Payment',
  'Deposit Requested At': days(27),
  'Deposit Amount': 600,
  'Deposit Nudge Count': 2,
  'Deposit Nudge Last Sent At': days(22),
  Rancher: ['recR'],
  Buyer: ['recB'],
  'Buyer Name': 'Test Buyer',
  __payments: clean,
  ...over,
});

test('releases the live cohort: nudges exhausted, 22d silent, no payment', () => {
  assert.equal(depositReleaseRefusal(stuck(), NOW), null);
  assert.equal(isDepositReleaseEligible(stuck(), NOW), true);
});

test('THE POINT: the released status frees the buyer AND the capacity slot', () => {
  // 'Awaiting Payment' is capacity-holding AND blocks a new match...
  assert.equal(HELD_REFERRAL_STATUSES.has('Awaiting Payment'), true);
  assert.equal(isActiveDealReferral(stuck()), true);
  // ...and the terminal we flip to is neither.
  assert.equal(HELD_REFERRAL_STATUSES.has(DEPOSIT_RELEASE_STATUS), false);
  assert.equal(isActiveDealReferral({ ...stuck(), Status: DEPOSIT_RELEASE_STATUS }), false);
});

// ── MONEY GATES — one test per refusal, no exceptions ──────────────────────

test('REFUSES a paid deposit', () => {
  assert.equal(depositReleaseRefusal(stuck({ 'Deposit Paid At': days(20) }), NOW), 'deposit-paid');
});

test('REFUSES any settlement/fee stamp, including a literal zero fee', () => {
  for (const f of MONEY_STAMP_FIELDS) {
    assert.equal(depositReleaseRefusal(stuck({ [f]: days(1) }), NOW), 'money-stamped', f);
  }
  // 0 in 'BHC Fee Cents' is a WRITTEN settlement value, not a blank.
  assert.equal(depositReleaseRefusal(stuck({ 'BHC Fee Cents': 0 }), NOW), 'money-stamped');
  assert.equal(depositReleaseRefusal(stuck({ 'BHC Fee Cents': 1999 }), NOW), 'money-stamped');
  // ...but a blank/absent stamp is not a refusal.
  assert.equal(depositReleaseRefusal(stuck({ 'BHC Fee Cents': '' }), NOW), null);
});

test('REFUSES when a live Payments row exists — pending and replay count as money', () => {
  const probe = (rows: any[]) => probeFromPayments(rows);
  assert.equal(depositReleaseRefusal(stuck({ __payments: probe([{ Status: 'succeeded' }]) }), NOW), 'live-payment');
  // A checkout in flight is money about to land.
  assert.equal(depositReleaseRefusal(stuck({ __payments: probe([{ Status: 'pending' }]) }), NOW), 'live-payment');
  // Money arrived, webhook lost — the worst row to mark dead.
  assert.equal(
    depositReleaseRefusal(stuck({ __payments: probe([{ Status: 'requires_webhook_replay' }]) }), NOW),
    'live-payment',
  );
  assert.equal(depositReleaseRefusal(stuck({ __payments: probe([{ Status: 'refunded' }]) }), NOW), 'live-payment');
  // Only the explicitly harmless statuses clear.
  for (const s of HARMLESS_PAYMENT_STATUSES) {
    assert.equal(depositReleaseRefusal(stuck({ __payments: probe([{ Status: s }]) }), NOW), null, s);
  }
  // Mixed rows: one live row is enough to refuse.
  assert.equal(
    depositReleaseRefusal(stuck({ __payments: probe([{ Status: 'failed' }, { Status: 'succeeded' }]) }), NOW),
    'live-payment',
  );
  // An unknown future status blocks by default (denylist-of-safe).
  assert.equal(depositReleaseRefusal(stuck({ __payments: probe([{ Status: 'brand_new_state' }]) }), NOW), 'live-payment');
});

test('FAILS CLOSED when the payment state is unknown', () => {
  // Read threw.
  assert.equal(depositReleaseRefusal(stuck({ __payments: PAYMENTS_PROBE_FAILED }), NOW), 'payment-state-unknown');
  assert.equal(depositReleaseRefusal(stuck({ __payments: probeFromPayments(undefined) }), NOW), 'payment-state-unknown');
  assert.equal(depositReleaseRefusal(stuck({ __payments: probeFromPayments(null) }), NOW), 'payment-state-unknown');
  // Probe never attached at all (a caller that forgot the lookup).
  const noProbe: any = stuck();
  delete noProbe.__payments;
  assert.equal(depositReleaseRefusal(noProbe, NOW), 'payment-state-unknown');
  // A hand-rolled probe missing ok:true is not trusted either.
  assert.equal(depositReleaseRefusal(stuck({ __payments: { hasLivePayment: false } }), NOW), 'payment-state-unknown');
});

test('an empty Payments result is a CLEAN read, not an unknown one', () => {
  const p = probeFromPayments([]);
  assert.deepEqual(p, { ok: true, hasLivePayment: false });
  assert.equal(depositReleaseRefusal(stuck({ __payments: p }), NOW), null);
});

test("'Deposit Amount' is the ASK, never proof of payment", () => {
  // Every live row carries 600. Treating it as a money signal (the way
  // lib/staleHolds does, correctly, for its own pre-money tiers) would make
  // this whole rail a permanent no-op.
  assert.equal(depositReleaseRefusal(stuck({ 'Deposit Amount': 600 }), NOW), null);
  assert.equal(depositReleaseRefusal(stuck({ 'Deposit Amount': 99999 }), NOW), null);
});

// ── TIMING / CHASE gates ───────────────────────────────────────────────────

test('REFUSES while the chase rail still owes a nudge', () => {
  for (let n = 0; n < DEPOSIT_NUDGE_LIFETIME_CAP; n++) {
    assert.equal(depositReleaseRefusal(stuck({ 'Deposit Nudge Count': n }), NOW), 'nudges-remaining', String(n));
  }
  assert.equal(depositReleaseRefusal(stuck({ 'Deposit Nudge Count': undefined }), NOW), 'nudges-remaining');
});

test('NEVER overlaps the nudge rail: a row is nudgeable OR releasable, never both', () => {
  // The nudge predicate stops exactly where this one starts (the lifetime cap
  // is the shared hinge) — so a buyer can never get a nudge and a release in
  // the same hour.
  for (const n of [0, 1, 2, 3]) {
    const row = stuck({ 'Deposit Nudge Count': n });
    const nudgeable = isDepositNudgeEligible(row as any, NOW);
    const releasable = isDepositReleaseEligible(row, NOW);
    assert.equal(nudgeable && releasable, false, `count=${n}`);
  }
});

test('REFUSES inside the 14d post-nudge silence window; releases just past it', () => {
  assert.equal(
    depositReleaseRefusal(stuck({ 'Deposit Nudge Last Sent At': days(DEPOSIT_RELEASE_SILENCE_DAYS - 1) }), NOW),
    'inside-silence-window',
  );
  assert.equal(
    depositReleaseRefusal(stuck({ 'Deposit Nudge Last Sent At': days(DEPOSIT_RELEASE_SILENCE_DAYS) }), NOW),
    null,
  );
  // Window is configurable and the anchor is the LAST NUDGE, not the request:
  // a 27-day-old request whose nudge went out yesterday is NOT released.
  assert.equal(depositReleaseRefusal(stuck({ 'Deposit Nudge Last Sent At': days(1) }), NOW), 'inside-silence-window');
  assert.equal(depositReleaseRefusal(stuck(), NOW, { silenceDays: 30 }), 'inside-silence-window');
});

test('FAILS CLOSED on a missing or corrupt nudge stamp', () => {
  assert.equal(depositReleaseRefusal(stuck({ 'Deposit Nudge Last Sent At': '' }), NOW), 'no-nudge-stamp');
  assert.equal(depositReleaseRefusal(stuck({ 'Deposit Nudge Last Sent At': 'yesterday-ish' }), NOW), 'no-nudge-stamp');
});

// ── SHAPE / CARVE-OUT gates ────────────────────────────────────────────────

test('REFUSES anything that is not an unpaid Awaiting Payment request', () => {
  for (const s of ['Dormant', 'Closed Lost', 'Closed Won', 'Slot Locked', 'Intro Sent', 'Pending Approval', '']) {
    assert.equal(depositReleaseRefusal(stuck({ Status: s }), NOW), 'wrong-status', s);
  }
  assert.equal(depositReleaseRefusal(stuck({ 'Deposit Requested At': '' }), NOW), 'no-deposit-request');
  assert.equal(depositReleaseRefusal(stuck({ 'Deposit Requested At': 'garbage' }), NOW), 'no-deposit-request');
  // Airtable's {name} singleSelect read shape is handled.
  assert.equal(depositReleaseRefusal(stuck({ Status: { name: 'Awaiting Payment' } }), NOW), null);
});

test('REFUSES a rancher-added My Lead — the rancher owns their own pipeline', () => {
  assert.equal(depositReleaseRefusal(stuck({ 'Referral Source': 'rancher-added' }), NOW), 'rancher-added');
  assert.equal(depositReleaseRefusal(stuck({ 'Referral Source': { name: 'rancher-added' } }), NOW), 'rancher-added');
  assert.equal(depositReleaseRefusal(stuck({ 'Referral Source': 'campaign' }), NOW), null);
});

test('REFUSES a row the operator explicitly parked with ⏸️ Hold', () => {
  const future = new Date(NOW + 5 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(depositReleaseRefusal(stuck({ 'Hold Until': future }), NOW), 'on-hold');
  // Fail-OPEN on an expired or corrupt hold — never park a dead deal forever.
  assert.equal(depositReleaseRefusal(stuck({ 'Hold Until': days(5) }), NOW), null);
  assert.equal(depositReleaseRefusal(stuck({ 'Hold Until': 'nonsense' }), NOW), null);
});

// ── IDEMPOTENCY ────────────────────────────────────────────────────────────

test('IDEMPOTENT: a released row is refused on every subsequent run', () => {
  const released = stuck({ Status: DEPOSIT_RELEASE_STATUS });
  assert.equal(depositReleaseRefusal(released, NOW), 'wrong-status');
  assert.equal(isDepositReleaseEligible(released, NOW), false);
  // ...and it stays refused a year later.
  assert.equal(isDepositReleaseEligible(released, NOW + 365 * 86_400_000), false);
});

// ── SELECTION ──────────────────────────────────────────────────────────────

test('candidate selection skips the payment probe, sorts oldest-ask-first, caps', () => {
  const rows = [
    stuck({ id: 'newer', 'Deposit Requested At': days(20) }),
    stuck({ id: 'oldest', 'Deposit Requested At': days(90) }),
    stuck({ id: 'mid', 'Deposit Requested At': days(40) }),
    stuck({ id: 'not-yet', 'Deposit Nudge Count': 1 }),
    stuck({ id: 'paid', 'Deposit Paid At': days(3) }),
  ];
  // No probe needed at this stage — that is the point of the split (one
  // Airtable round-trip per SURVIVOR, not per row in the table).
  for (const r of rows) delete (r as any).__payments;
  const picked = selectDepositReleaseCandidates(rows as any, { nowMs: NOW, cap: 2 });
  assert.deepEqual(picked.map((r) => r.id), ['oldest', 'mid']);
  assert.equal(selectDepositReleaseCandidates(rows as any, { nowMs: NOW, cap: 0 }).length, 0);
  assert.equal(selectDepositReleaseCandidates([] as any, { nowMs: NOW }).length, 0);
});

test('staticReleaseRefusal never consults the probe (money check is the cron leg)', () => {
  const live = stuck({ __payments: { ok: true, hasLivePayment: true } });
  assert.equal(staticReleaseRefusal(live, NOW), null);
  assert.equal(depositReleaseRefusal(live, NOW), 'live-payment');
});

test('refusalBreakdown makes a "0 released" run diagnosable', () => {
  const rows = [
    stuck({ id: 'a', 'Deposit Paid At': days(2) }),
    stuck({ id: 'b', 'Deposit Nudge Count': 0 }),
    stuck({ id: 'c', 'Deposit Nudge Count': 1 }),
    stuck({ id: 'd', __payments: PAYMENTS_PROBE_FAILED }),
    stuck({ id: 'e' }), // releasable → absent from the breakdown
  ];
  assert.deepEqual(refusalBreakdown(rows as any, NOW), {
    'deposit-paid': 1,
    'nudges-remaining': 2,
    'payment-state-unknown': 1,
  });
});

// ── WRITE PAYLOAD ──────────────────────────────────────────────────────────

test('the Loss Reason is from the PINNED vocabulary, never invented', () => {
  assert.equal(LOSS_REASON_CHOICES.includes(DEPOSIT_RELEASE_LOSS_REASON), true);
  assert.equal(DEPOSIT_RELEASE_LOSS_REASON, "Couldn't reach buyer");
});

test('the release must NOT brick the buyer out of their state supply', () => {
  // matching/suggest permanently excludes a (buyer, rancher) pair only on an
  // EXCLUDING reason. "Couldn't reach buyer" is a buyer-side outcome: the
  // buyer re-engaging IS the new signal, and in a 1-rancher state excluding
  // here would leave them with zero candidates forever.
  assert.equal(isExcludingLossReason(DEPOSIT_RELEASE_LOSS_REASON), false);
});

test('the terminal is Dormant, NOT Closed Lost — loss analytics stay honest', () => {
  // weekly-scorecard, loss-recovery and matching/suggest's pairing exclusion
  // are ALL scoped to {Status}="Closed Lost". Flipping there would blame
  // ranchers for buyer silence and re-email a buyer who ignored three emails.
  assert.equal(DEPOSIT_RELEASE_STATUS, 'Dormant');
  assert.notEqual(DEPOSIT_RELEASE_STATUS, 'Closed Lost');
});

test('the Notes stamp reconstructs the decision without reading any code', () => {
  const note = releaseNoteStamp(stuck(), { today: '2026-07-30', nowMs: NOW });
  assert.match(note, /^\[auto-released 2026-07-30: deposit requested 27d ago, never paid/);
  assert.match(note, /2 nudges sent, silent 22d, link NEVER opened/);
  assert.match(note, /no payment on file; buyer released back to matching\]$/);
  // Singular/plural and the opened branch both render.
  const opened = releaseNoteStamp(stuck({ 'Deposit Nudge Count': 1, 'Deposit Link Opened At': days(5) }), {
    today: '2026-07-30',
    nowMs: NOW,
  });
  assert.match(opened, /1 nudge sent/);
  assert.match(opened, /link opened/);
  // Corrupt anchors degrade to '?', never to NaN or a thrown error.
  const broken = releaseNoteStamp({ 'Deposit Requested At': 'x' } as any, { today: '2026-07-30', nowMs: NOW });
  assert.match(broken, /requested \?d ago/);
  assert.equal(broken.includes('NaN'), false);
});

test('SENTINEL 99: a suppression-retired row releases with the truth, never "99 nudges sent"', () => {
  // #634 stamps 'Deposit Nudge Count' = 99 (DEPOSIT_NUDGE_SUPPRESSED_SENTINEL)
  // on a suppressed buyer (Unsubscribed/Bounced/Complained) to retire the row
  // from every chase selector. count>=cap means the release rail treats it as
  // "chase exhausted" — CORRECT, the row must still free its capacity slot —
  // but the audit note must never record the sentinel as emails actually sent.
  const suppressed = stuck({ 'Deposit Nudge Count': DEPOSIT_NUDGE_SUPPRESSED_SENTINEL });
  assert.equal(depositReleaseRefusal(suppressed, NOW), null, 'a suppressed row still releases');
  const note = releaseNoteStamp(suppressed, { today: '2026-07-30', nowMs: NOW });
  assert.match(note, /chase suppressed \(unsubscribe\/bounce\)/);
  assert.equal(note.includes('99 nudge'), false, 'the sentinel must never read as a send count');
  // The rest of the audit line survives intact.
  assert.match(note, /^\[auto-released 2026-07-30: deposit requested 27d ago, never paid/);
  assert.match(note, /silent 22d, link NEVER opened/);
  assert.match(note, /no payment on file; buyer released back to matching\]$/);
  // Anything at or above the sentinel is suppression debris, not a count.
  const above = releaseNoteStamp(stuck({ 'Deposit Nudge Count': 120 }), { today: '2026-07-30', nowMs: NOW });
  assert.match(above, /chase suppressed \(unsubscribe\/bounce\)/);
  // A real exhausted chase still reads as a count.
  const real = releaseNoteStamp(stuck(), { today: '2026-07-30', nowMs: NOW });
  assert.match(real, /2 nudges sent/);
});
