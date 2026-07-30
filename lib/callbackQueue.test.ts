import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasOpenCallbackRequest,
  dialTierFor,
  dialSignalAgeDays,
  scoreDialCandidate,
  rankDialQueue,
  DIAL_TIERS,
  DIAL_TIER_RANK,
  DEFAULT_DIAL_QUEUE_LIMIT,
  type DialCandidate,
} from './callbackQueue';

// Fixed clock so every age assertion is deterministic.
const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

// Synthetic buyers only — this repo is public (see docs/WRITE-MAP.md rule zero
// and the privacy note in CLAUDE.md). No real names, emails, phones, or ids.
function row(over: Partial<DialCandidate> = {}): DialCandidate {
  return { id: 'rec0000000000000', phone: '+15555550100', ...over };
}

// ── hasOpenCallbackRequest ─────────────────────────────────────────────────

test('no request stamp → not open', () => {
  assert.equal(hasOpenCallbackRequest({}), false);
  assert.equal(hasOpenCallbackRequest({ callbackRequestedAt: '' }), false);
  assert.equal(hasOpenCallbackRequest({ callbackRequestedAt: '   ' }), false);
  assert.equal(hasOpenCallbackRequest({ callbackRequestedAt: 'not a date' }), false);
});

test('requested with no handled stamp → open', () => {
  assert.equal(hasOpenCallbackRequest({ callbackRequestedAt: hoursAgo(2) }), true);
  assert.equal(
    hasOpenCallbackRequest({ callbackRequestedAt: hoursAgo(2), callbackHandledAt: '' }),
    true,
  );
});

test('handled AFTER the request → closed', () => {
  assert.equal(
    hasOpenCallbackRequest({
      callbackRequestedAt: daysAgo(3),
      callbackHandledAt: daysAgo(2),
    }),
    false,
  );
});

test('handled BEFORE the request → open again (the re-ask case)', () => {
  // Both stamps are single-value dateTime fields. A buyer who asks a second
  // time overwrites Requested At while Handled At still holds the FIRST call.
  // Reading that as "already handled" would drop the hottest row silently.
  assert.equal(
    hasOpenCallbackRequest({
      callbackRequestedAt: hoursAgo(1),
      callbackHandledAt: daysAgo(9),
    }),
    true,
  );
});

test('identical stamps count as handled, not open', () => {
  const t = daysAgo(1);
  assert.equal(hasOpenCallbackRequest({ callbackRequestedAt: t, callbackHandledAt: t }), false);
});

test('unparseable handled stamp fails toward SHOWING the request', () => {
  assert.equal(
    hasOpenCallbackRequest({ callbackRequestedAt: hoursAgo(4), callbackHandledAt: 'garbage' }),
    true,
  );
});

// ── dialTierFor ────────────────────────────────────────────────────────────

test('an open callback request is the callback tier', () => {
  assert.equal(dialTierFor(row({ callbackRequestedAt: hoursAgo(1) })), 'callback');
});

test('callback outranks a competing deposit-opened signal on the SAME row', () => {
  const both = row({
    callbackRequestedAt: hoursAgo(1),
    depositLinkOpenedAt: hoursAgo(3),
  });
  assert.equal(dialTierFor(both), 'callback');
});

test('deposit opened and unpaid is the deposit-opened tier', () => {
  assert.equal(dialTierFor(row({ depositLinkOpenedAt: hoursAgo(3) })), 'deposit-opened');
});

test('deposit opened AND paid is not a dial target', () => {
  const paid = row({ depositLinkOpenedAt: daysAgo(2), depositPaidAt: daysAgo(2) });
  assert.equal(dialTierFor(paid), 'other');
});

test('qualified with a cut and no live deal is the qualified-no-deal tier', () => {
  const r = row({ qualifiedAt: daysAgo(4), hasCutOnFile: true, hasLiveDeal: false });
  assert.equal(dialTierFor(r), 'qualified-no-deal');
});

test('qualified but NO cut on file falls to other', () => {
  const r = row({ qualifiedAt: daysAgo(4), hasCutOnFile: false });
  assert.equal(dialTierFor(r), 'other');
});

test('qualified with a cut but already in a live deal falls to other', () => {
  const r = row({ qualifiedAt: daysAgo(4), hasCutOnFile: true, hasLiveDeal: true });
  assert.equal(dialTierFor(r), 'other');
});

test('a handled callback drops out of the callback tier', () => {
  const r = row({ callbackRequestedAt: daysAgo(3), callbackHandledAt: daysAgo(1) });
  assert.equal(dialTierFor(r), 'other');
});

test('a handled callback still tiers on its OTHER live signals', () => {
  const r = row({
    callbackRequestedAt: daysAgo(3),
    callbackHandledAt: daysAgo(1),
    depositLinkOpenedAt: hoursAgo(6),
  });
  assert.equal(dialTierFor(r), 'deposit-opened');
});

test('an empty row is other', () => {
  assert.equal(dialTierFor(row()), 'other');
});

// ── the headline ordering ──────────────────────────────────────────────────

test('THE ORDER: callback > deposit-opened > qualified-no-deal > everything else', () => {
  const cold = row({ id: 'rec4' });
  const qualified = row({ id: 'rec3', qualifiedAt: daysAgo(5), hasCutOnFile: true });
  const opened = row({ id: 'rec2', depositLinkOpenedAt: daysAgo(1) });
  const asked = row({ id: 'rec1', callbackRequestedAt: daysAgo(1) });

  // Deliberately fed in exactly the WRONG order.
  const ranked = rankDialQueue([cold, qualified, opened, asked], { now: NOW });
  assert.deepEqual(
    ranked.map((r) => r.id),
    ['rec1', 'rec2', 'rec3', 'rec4'],
  );
  assert.deepEqual(
    ranked.map((r) => r.tier),
    ['callback', 'deposit-opened', 'qualified-no-deal', 'other'],
  );
});

test('a WEEK-OLD callback still outranks a checkout opened five minutes ago', () => {
  // The whole point of the rail: an inbound ask is never beaten by an
  // outbound guess, no matter how fresh the guess looks.
  const stale = row({ id: 'recA', callbackRequestedAt: daysAgo(7) });
  const blazing = row({ id: 'recB', depositLinkOpenedAt: hoursAgo(0.08) });
  const ranked = rankDialQueue([blazing, stale], { now: NOW });
  assert.deepEqual(ranked.map((r) => r.id), ['recA', 'recB']);
});

test('callback tier sorts OLDEST first — the longest wait is the biggest debt', () => {
  const rows = [
    row({ id: 'recNew', callbackRequestedAt: hoursAgo(1) }),
    row({ id: 'recOld', callbackRequestedAt: daysAgo(4) }),
    row({ id: 'recMid', callbackRequestedAt: daysAgo(1) }),
  ];
  const ranked = rankDialQueue(rows, { now: NOW });
  assert.deepEqual(ranked.map((r) => r.id), ['recOld', 'recMid', 'recNew']);
});

test('every OTHER tier sorts NEWEST first — heat decays', () => {
  const rows = [
    row({ id: 'recOld', depositLinkOpenedAt: daysAgo(20) }),
    row({ id: 'recNew', depositLinkOpenedAt: hoursAgo(1) }),
    row({ id: 'recMid', depositLinkOpenedAt: daysAgo(2) }),
  ];
  const ranked = rankDialQueue(rows, { now: NOW });
  assert.deepEqual(ranked.map((r) => r.id), ['recNew', 'recMid', 'recOld']);
});

test('within a tier, a dialable row beats one with no phone', () => {
  // Even when the phoneless row asked FIRST — this is a dial queue.
  const noPhone = row({ id: 'recNoPhone', phone: '', callbackRequestedAt: daysAgo(5) });
  const callable = row({ id: 'recPhone', callbackRequestedAt: daysAgo(1) });
  const ranked = rankDialQueue([noPhone, callable], { now: NOW });
  assert.deepEqual(ranked.map((r) => r.id), ['recPhone', 'recNoPhone']);
  // …but the phoneless row is still LISTED, never dropped.
  assert.equal(ranked.length, 2);
});

test('a whitespace-only phone counts as no phone', () => {
  const blank = row({ id: 'recBlank', phone: '   ', callbackRequestedAt: daysAgo(5) });
  const callable = row({ id: 'recReal', callbackRequestedAt: daysAgo(1) });
  assert.deepEqual(
    rankDialQueue([blank, callable], { now: NOW }).map((r) => r.id),
    ['recReal', 'recBlank'],
  );
});

test('undated rows sink within their tier but are never dropped', () => {
  const dated = row({ id: 'recDated', qualifiedAt: daysAgo(30), hasCutOnFile: true });
  const undated = row({ id: 'recUndated' });
  const ranked = rankDialQueue([undated, dated], { now: NOW });
  assert.deepEqual(ranked.map((r) => r.id), ['recDated', 'recUndated']);
});

test('ties break on record id, so the desk never reshuffles between polls', () => {
  const at = daysAgo(2);
  const rows = [
    row({ id: 'recZ', callbackRequestedAt: at }),
    row({ id: 'recA', callbackRequestedAt: at }),
    row({ id: 'recM', callbackRequestedAt: at }),
  ];
  const once = rankDialQueue(rows, { now: NOW }).map((r) => r.id);
  const twice = rankDialQueue([...rows].reverse(), { now: NOW }).map((r) => r.id);
  assert.deepEqual(once, ['recA', 'recM', 'recZ']);
  assert.deepEqual(once, twice);
});

test('rankDialQueue does not mutate its input', () => {
  const original = row({ id: 'recX', callbackRequestedAt: daysAgo(1) });
  const snapshot = JSON.parse(JSON.stringify(original));
  rankDialQueue([original], { now: NOW });
  assert.deepEqual(JSON.parse(JSON.stringify(original)), snapshot);
});

test('limit truncates from the TOP of the ranking, and defaults sanely', () => {
  const rows = Array.from({ length: 40 }, (_, i) =>
    row({ id: `rec${String(i).padStart(3, '0')}`, callbackRequestedAt: daysAgo(40 - i) }),
  );
  assert.equal(rankDialQueue(rows, { now: NOW }).length, DEFAULT_DIAL_QUEUE_LIMIT);
  const top = rankDialQueue(rows, { now: NOW, limit: 3 });
  assert.equal(top.length, 3);
  // Oldest three requests, in wait order.
  assert.deepEqual(top.map((r) => r.id), ['rec000', 'rec001', 'rec002']);
  assert.equal(rankDialQueue(rows, { now: NOW, limit: 0 }).length, 0);
  assert.equal(rankDialQueue(rows, { now: NOW, limit: -5 }).length, 0);
});

test('empty and missing input are safe', () => {
  assert.deepEqual(rankDialQueue([], { now: NOW }), []);
  assert.deepEqual(rankDialQueue(undefined as unknown as DialCandidate[], { now: NOW }), []);
});

// ── ages + shape ───────────────────────────────────────────────────────────

test('signal age is measured off the stamp that set the tier', () => {
  const r = row({ callbackRequestedAt: daysAgo(3), depositLinkOpenedAt: daysAgo(19) });
  assert.equal(dialSignalAgeDays(r, 'callback', NOW), 3);
  assert.equal(dialSignalAgeDays(r, 'deposit-opened', NOW), 19);
  assert.equal(dialSignalAgeDays(row(), 'other', NOW), null);
});

test('a future stamp clamps to zero rather than going negative', () => {
  const future = row({ callbackRequestedAt: new Date(NOW + 3_600_000).toISOString() });
  assert.equal(dialSignalAgeDays(future, 'callback', NOW), 0);
});

test('ranked rows carry tier, rank, reason, age and the original fields', () => {
  const r = row({
    id: 'recCtx',
    name: 'Sample Buyer',
    state: 'TX',
    callbackNote: 'can it ship to a second address',
    rancherName: 'Sample Ranch',
    callbackRequestedAt: daysAgo(2),
  });
  const [ranked] = rankDialQueue([r], { now: NOW });
  assert.equal(ranked.tier, 'callback');
  assert.equal(ranked.tierRank, 0);
  assert.equal(ranked.reason, 'asked for a call');
  assert.equal(ranked.signalAgeDays, 2);
  assert.equal(ranked.name, 'Sample Buyer');
  assert.equal(ranked.state, 'TX');
  assert.equal(ranked.rancherName, 'Sample Ranch');
  assert.equal(ranked.callbackNote, 'can it ship to a second address');
});

test('scoreDialCandidate agrees with rankDialQueue on every row', () => {
  const rows = [
    row({ id: 'rec1', callbackRequestedAt: daysAgo(1) }),
    row({ id: 'rec2', depositLinkOpenedAt: daysAgo(1) }),
    row({ id: 'rec3', qualifiedAt: daysAgo(1), hasCutOnFile: true }),
    row({ id: 'rec4' }),
  ];
  for (const ranked of rankDialQueue(rows, { now: NOW })) {
    const direct = scoreDialCandidate(rows.find((r) => r.id === ranked.id)!, NOW);
    assert.equal(direct.tier, ranked.tier);
    assert.equal(direct.tierRank, ranked.tierRank);
    assert.equal(direct.signalAgeDays, ranked.signalAgeDays);
  }
});

test('tier constants stay in lockstep — the array order IS the rank', () => {
  DIAL_TIERS.forEach((tier, i) => assert.equal(DIAL_TIER_RANK[tier], i));
  assert.equal(DIAL_TIERS[0], 'callback', 'inbound must never stop being first');
});
