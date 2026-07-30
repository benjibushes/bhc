// lib/staleHolds.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/staleHolds.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStaleHold,
  selectStaleHolds,
  freedByRancher,
  attributedRancherId,
  expiryNoteStamp,
  silentDays,
  formatDays,
  DEFAULT_STALE_DAYS,
  EXPIRABLE_STATUSES,
  CAPACITY_HOLD_EXPIRABLE_STATUSES,
  BUYER_BLOCK_EXPIRABLE_STATUSES,
  staleDaysForStatus,
} from './staleHolds';
import { HELD_REFERRAL_STATUSES, isActiveDealReferral } from './capacityCount';

const NOW = new Date('2026-07-08T12:00:00Z').getTime();
const days = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

const stale = (over: any = {}) => ({
  id: 'rec1',
  Status: 'Intro Sent',
  'Intro Sent At': days(30),
  _createdTime: days(35),
  ...over,
});

test('expires a 30-day-silent Intro Sent hold', () => {
  assert.equal(isStaleHold(stale(), NOW), true);
});

test('Rancher Contacted expires too; MONEY-COMMITTED statuses NEVER do', () => {
  assert.equal(isStaleHold(stale({ Status: 'Rancher Contacted' }), NOW), true);
  // 'Negotiation' moved OUT of this list 2026-07-25 — it holds capacity, so it
  // must have SOME expiry path. 'Pending Approval' moved out 2026-07-30 — it
  // holds no capacity but freezes the BUYER, so it needs one too. Awaiting
  // Payment / Slot Locked stay untouchable HERE: money was asked for, and the
  // only rail allowed to end those is lib/depositRelease, which proves there
  // is no payment on the row first.
  for (const s of ['Awaiting Payment', 'Slot Locked', 'Closed Won', 'Closed Lost', 'Dormant']) {
    assert.equal(isStaleHold(stale({ Status: s, 'Intro Sent At': days(400) }), NOW), false, s);
  }
});

// ── 'Negotiation' expiry (pause-asymmetry sweep 2026-07-25) ────────────────
// The leak: Negotiation holds a capacity slot (HELD_REFERRAL_STATUSES) but no
// expiry path could release it. 24 live referrals were parked there.

test('INVARIANT: every capacity-holding status is either expirable or money-committed', () => {
  const MONEY_COMMITTED = new Set(['Awaiting Payment', 'Slot Locked']);
  for (const s of HELD_REFERRAL_STATUSES) {
    assert.equal(
      EXPIRABLE_STATUSES.has(s) || MONEY_COMMITTED.has(s),
      true,
      `${s} holds capacity but has no expiry path and is not money-committed`,
    );
  }
});

// Fixture where the newest signal of ANY kind is exactly `age` days old, so
// the window boundary is the only thing under test (the shared `stale()`
// helper bakes in a 35-day _createdTime that would otherwise dominate).
const silentFor = (age: number, over: any = {}) => ({
  id: 'rec1',
  Status: 'Negotiation',
  'Intro Sent At': days(age),
  _createdTime: days(age + 5),
  ...over,
});

test('Negotiation expires — but only past its OWN longer window', () => {
  const base = DEFAULT_STALE_DAYS; // 21
  // Past the intro window but inside the negotiation window → still held.
  assert.equal(isStaleHold(silentFor(30), NOW), false);
  assert.equal(isStaleHold(silentFor(base * 2), NOW), false);
  // Just past 2× → released.
  assert.equal(isStaleHold(silentFor(base * 2 + 1), NOW), true);
  // Same age, an unanswered intro, releases far earlier.
  assert.equal(isStaleHold(silentFor(30, { Status: 'Intro Sent' }), NOW), true);
});

test('Negotiation window scales with the STALE_HOLD_DAYS override, not a hardcode', () => {
  assert.equal(staleDaysForStatus('Negotiation', 21), 42);
  assert.equal(staleDaysForStatus('Negotiation', 10), 20);
  assert.equal(staleDaysForStatus('Intro Sent', 21), 21);
  assert.equal(staleDaysForStatus('Rancher Contacted', 21), 21);
  // Unknown status falls back to the base window (×1), never to Infinity/NaN.
  assert.equal(staleDaysForStatus('Whatever', 21), 21);
  // With a 10-day base the negotiation window is 20d.
  assert.equal(isStaleHold(silentFor(25), NOW, 10), true);
  assert.equal(isStaleHold(silentFor(15), NOW, 10), false);
});

test('a deposit signal blocks Negotiation expiry at ANY age', () => {
  assert.equal(isStaleHold(silentFor(400), NOW), true); // control
  assert.equal(isStaleHold(silentFor(400, { 'Deposit Requested At': days(390) }), NOW), false);
  assert.equal(isStaleHold(silentFor(400, { 'Deposit Paid At': days(390) }), NOW), false);
  assert.equal(isStaleHold(silentFor(400, { 'Deposit Amount': 600 }), NOW), false);
});

test('recent activity keeps a Negotiation alive even past 2x the base window', () => {
  assert.equal(isStaleHold(silentFor(400, { 'Last Buyer Activity At': days(3) }), NOW), false);
  assert.equal(isStaleHold(silentFor(400, { 'Last Rancher Activity At': days(40) }), NOW), false);
  assert.equal(isStaleHold(silentFor(400, { 'Last Rancher Activity At': days(43) }), NOW), true);
});

test('ANY deposit signal blocks expiry', () => {
  assert.equal(isStaleHold(stale({ 'Deposit Requested At': days(25) }), NOW), false);
  assert.equal(isStaleHold(stale({ 'Deposit Paid At': days(25) }), NOW), false);
  assert.equal(isStaleHold(stale({ 'Deposit Amount': 600 }), NOW), false);
});

test('recent activity from EITHER side resets the clock', () => {
  assert.equal(isStaleHold(stale({ 'Last Buyer Activity At': days(5) }), NOW), false);
  assert.equal(isStaleHold(stale({ 'Last Rancher Activity At': days(2) }), NOW), false);
  assert.equal(isStaleHold(stale({ 'Last Rancher Activity At': days(22) }), NOW), true);
});

test('exactly at the boundary does not expire; just past it does', () => {
  assert.equal(isStaleHold(stale({ 'Intro Sent At': days(DEFAULT_STALE_DAYS) }), NOW), false);
  assert.equal(isStaleHold(stale({ 'Intro Sent At': days(DEFAULT_STALE_DAYS + 1) }), NOW), true);
});

test('no timestamps at all → never guess, never expire', () => {
  assert.equal(isStaleHold({ id: 'x', Status: 'Intro Sent' } as any, NOW), false);
});

test('selectStaleHolds: oldest first, capped, unlinked rows excluded', () => {
  const rows = [
    stale({ id: 'newer', 'Intro Sent At': days(25), Rancher: ['recA'] }),
    stale({ id: 'oldest', 'Intro Sent At': days(90), Rancher: ['recA'] }),
    stale({ id: 'fresh', 'Intro Sent At': days(3), Rancher: ['recA'] }),
    stale({ id: 'mid', 'Intro Sent At': days(40), Rancher: ['recA'] }),
    stale({ id: 'unlinked', 'Intro Sent At': days(200) }), // no Rancher → frees nothing → excluded
  ];
  const picked = selectStaleHolds(rows as any, NOW, { cap: 2 });
  assert.deepEqual(picked.map((r) => r.id), ['oldest', 'mid']);
});

test('selectStaleHolds: capacity-blocked ranchers jump the queue', () => {
  const rows = [
    stale({ id: 'old-noop', 'Intro Sent At': days(90), Rancher: ['recIdle'] }),
    stale({ id: 'newer-blocked', 'Intro Sent At': days(25), Rancher: ['recFull'] }),
    stale({ id: 'mid-noop', 'Intro Sent At': days(40), Rancher: ['recIdle'] }),
  ];
  const picked = selectStaleHolds(rows as any, NOW, { cap: 2, priorityRancherIds: new Set(['recFull']) });
  assert.deepEqual(picked.map((r) => r.id), ['newer-blocked', 'old-noop']);
});

// ── My Leads (2026-07-29): rancher-entered leads NEVER auto-expire ─────────
// A rancher's own customer ('Referral Source' = 'rancher-added') can sit
// quiet for months — market-season timing is the rancher's business. Flipping
// them Dormant after 21 silent days would delete the rancher's pipeline.

test('a rancher-added lead never expires, at any age, in any expirable status', () => {
  for (const status of EXPIRABLE_STATUSES) {
    const row = stale({
      Status: status,
      'Intro Sent At': days(400),
      'Referral Source': 'rancher-added',
      Rancher: ['recR'],
    });
    assert.equal(isStaleHold(row as any, NOW), false, status);
  }
});

test('rancher-added exclusion tolerates the Airtable {name} read shape', () => {
  const row = stale({ 'Referral Source': { name: 'rancher-added' }, Rancher: ['recR'] });
  assert.equal(isStaleHold(row as any, NOW), false);
});

test('selectStaleHolds drops rancher-added rows while keeping routed ones', () => {
  const rows = [
    stale({ id: 'routed', Rancher: ['recA'] }),
    stale({ id: 'crm', Rancher: ['recA'], 'Referral Source': 'rancher-added' }),
  ];
  const picked = selectStaleHolds(rows as any, NOW, { cap: 10 });
  assert.deepEqual(picked.map((r) => r.id), ['routed']);
});

test('freedByRancher groups by first Rancher link', () => {
  const rows = [
    stale({ Rancher: ['recA'] }),
    stale({ Rancher: ['recA'] }),
    stale({ Rancher: ['recB'] }),
    stale({}),
  ];
  assert.deepEqual(freedByRancher(rows as any), { recA: 2, recB: 1, '(unlinked)': 1 });
});

// ── 'Pending Approval' expiry (no-dead-end-deals sweep 2026-07-30) ──────────
// THE LEAK: Pending Approval holds NO capacity slot (pre-INCR by design) but
// isActiveDealReferral counts it as a live deal when a rancher is attached —
// so a rancher who never taps approve/decline locked the BUYER out of the
// entire marketplace, permanently. Six buyers were frozen 58-92 days.

const pending = (over: any = {}) => ({
  id: 'recPA',
  Status: 'Pending Approval',
  Rancher: ['recR'],
  _createdTime: days(60),
  ...over,
});

test('THE POINT: expiring a Pending Approval row frees isActiveDealReferral', () => {
  // Before: the row blocks the buyer from every routing rail.
  const before = pending();
  assert.equal(isActiveDealReferral(before), true);
  assert.equal(isStaleHold(before as any, NOW), true);
  // After the cron's flip, the buyer is re-matchable. If this ever fails, the
  // whole tier is theatre: the row changes status and the buyer stays frozen.
  assert.equal(isActiveDealReferral({ ...before, Status: 'Dormant' }), false);
});

test('Pending Approval expires on its OWN shorter window (1/3 of base)', () => {
  const base = DEFAULT_STALE_DAYS; // 21 → 7
  assert.equal(staleDaysForStatus('Pending Approval', 21), 7);
  assert.equal(staleDaysForStatus('Pending Approval', 30), 10);
  // Inside 7d → still live. Just past → released.
  assert.equal(isStaleHold(pending({ _createdTime: days(6) }) as any, NOW), false);
  assert.equal(isStaleHold(pending({ _createdTime: days(7) }) as any, NOW), false); // boundary is strict
  assert.equal(isStaleHold(pending({ _createdTime: days(8) }) as any, NOW), true);
  // An unanswered intro at the same age is still inside ITS window — the
  // shorter Pending Approval rope is a deliberate difference, not a bug.
  assert.equal(isStaleHold(pending({ Status: 'Intro Sent', _createdTime: days(8), 'Intro Sent At': days(8) }) as any, NOW), false);
});

test('Pending Approval window scales with STALE_HOLD_DAYS, not a hardcoded 7', () => {
  assert.equal(isStaleHold(pending({ _createdTime: days(8) }) as any, NOW, 30), false); // window 10d
  assert.equal(isStaleHold(pending({ _createdTime: days(11) }) as any, NOW, 30), true);
});

test('recent activity from either side keeps a Pending Approval alive', () => {
  assert.equal(isStaleHold(pending({ 'Last Rancher Activity At': days(2) }) as any, NOW), false);
  assert.equal(isStaleHold(pending({ 'Last Buyer Activity At': days(3) }) as any, NOW), false);
  assert.equal(isStaleHold(pending({ 'Last Rancher Activity At': days(30) }) as any, NOW), true);
});

test('every carve-out that protects the old tiers protects Pending Approval too', () => {
  // My Leads — the rancher's own customer, never auto-closed.
  assert.equal(isStaleHold(pending({ 'Referral Source': 'rancher-added' }) as any, NOW), false);
  // Any deposit signal — money is the operator's call at any age.
  assert.equal(isStaleHold(pending({ 'Deposit Requested At': days(50) }) as any, NOW), false);
  assert.equal(isStaleHold(pending({ 'Deposit Paid At': days(50) }) as any, NOW), false);
  assert.equal(isStaleHold(pending({ 'Deposit Amount': 600 }) as any, NOW), false);
  // No timestamp at all — never guess.
  assert.equal(isStaleHold({ id: 'x', Status: 'Pending Approval', Rancher: ['recR'] } as any, NOW), false);
});

test('the two tier sets partition EXPIRABLE_STATUSES with no overlap', () => {
  for (const s of CAPACITY_HOLD_EXPIRABLE_STATUSES) {
    assert.equal(EXPIRABLE_STATUSES.has(s), true, s);
    assert.equal(BUYER_BLOCK_EXPIRABLE_STATUSES.has(s), false, s);
    // Tier 1 is capacity-holding by definition — that is what makes it tier 1.
    assert.equal(HELD_REFERRAL_STATUSES.has(s), true, s);
  }
  for (const s of BUYER_BLOCK_EXPIRABLE_STATUSES) {
    assert.equal(EXPIRABLE_STATUSES.has(s), true, s);
    // Tier 2 must NOT be capacity-holding: if Pending Approval ever enters
    // HELD_REFERRAL_STATUSES the capacity math changes and this tier's
    // "frees no slot" reporting becomes a lie.
    assert.equal(HELD_REFERRAL_STATUSES.has(s), false, s);
  }
  assert.equal(EXPIRABLE_STATUSES.size, CAPACITY_HOLD_EXPIRABLE_STATUSES.size + BUYER_BLOCK_EXPIRABLE_STATUSES.size);
});

// ── operator ⏸️ Hold parks a row in EVERY tier (2026-07-30) ────────────────
// The hold button (Telegram) writes a future `Hold Until`; chasers already
// skip parked rows. Expiry did not — so a hold could be auto-expired out from
// under the operator, and Pending Approval is the exact status that button
// targets.

test('a future Hold Until blocks expiry; an expired or corrupt one does not', () => {
  const future = new Date(NOW + 3 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(isStaleHold(pending({ 'Hold Until': future }) as any, NOW), false);
  assert.equal(isStaleHold(stale({ 'Hold Until': future }) as any, NOW), false);
  // Fail-OPEN on anything that isn't a live future hold — a corrupt value must
  // never hide a dead deal forever.
  assert.equal(isStaleHold(pending({ 'Hold Until': days(3) }) as any, NOW), true);
  assert.equal(isStaleHold(pending({ 'Hold Until': 'not-a-date' }) as any, NOW), true);
  assert.equal(isStaleHold(pending({ 'Hold Until': '' }) as any, NOW), true);
});

test('selectStaleHolds keeps a Pending Approval attached only by Suggested Rancher', () => {
  // Pending Approval is pre-INCR and can carry ONLY a suggestion — but
  // isActiveDealReferral blocks the buyer on that alone, so the row must be
  // selectable or the buyer stays frozen.
  const suggestedOnly = pending({ id: 'suggested', Rancher: [], 'Suggested Rancher': ['recS'] });
  assert.equal(isActiveDealReferral(suggestedOnly), true);
  assert.equal(attributedRancherId(suggestedOnly as any), 'recS');
  // A TRUE orphan (neither link) is already inactive — flipping it is noise.
  const orphan = pending({ id: 'orphan', Rancher: [], 'Suggested Rancher': [] });
  assert.equal(isActiveDealReferral(orphan), false);
  assert.equal(attributedRancherId(orphan as any), '');
  const picked = selectStaleHolds([suggestedOnly, orphan] as any, NOW, { cap: 10 });
  assert.deepEqual(picked.map((r) => r.id), ['suggested']);
  // The Suggested fallback is Pending-Approval-only: a held row always has
  // `Rancher` once introduced, so nothing else may attribute through it.
  assert.equal(attributedRancherId({ Status: 'Intro Sent', 'Suggested Rancher': ['recS'] } as any), '');
});

// ── audit-stamp + report helpers ────────────────────────────────────────────

test('the Notes stamp carries BOTH the real silence and the window that applied', () => {
  const opts = { today: '2026-07-08', staleDays: DEFAULT_STALE_DAYS, nowMs: NOW };
  assert.equal(
    expiryNoteStamp(stale() as any, opts),
    '[auto-expired 2026-07-08: Intro Sent — silent 30d (window 21d) — slot released]',
  );
  assert.match(expiryNoteStamp(stale({ Status: 'Negotiation' }) as any, opts), /window 42d/);
  // The real age is what a human needs: a 92d-old row must not read as "7d".
  const paNote = expiryNoteStamp(pending({ _createdTime: days(92) }) as any, opts);
  assert.match(paNote, /Pending Approval — silent 92d \(window 7d\)/);
  assert.match(paNote, /buyer released back to matching/);
  // Pending Approval frees no slot — the note must not claim it did.
  assert.equal(paNote.includes('slot released'), false);
  // No timestamps → '?', never NaN.
  assert.match(expiryNoteStamp({ Status: 'Intro Sent' } as any, opts), /silent \?d/);
});

test('formatDays never prints a float tail at an operator', () => {
  assert.equal(formatDays(7), '7');
  assert.equal(formatDays(staleDaysForStatus('Pending Approval', 10)), '3.3');
  assert.equal(formatDays(NaN), '?');
});

test('silentDays reports the age behind a selection', () => {
  assert.equal(silentDays(pending({ _createdTime: days(92) }) as any, NOW), 92);
  assert.equal(silentDays({ id: 'x', Status: 'Pending Approval' } as any, NOW), null);
});
