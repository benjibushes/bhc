import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateDealValue,
  estimateBhcFee,
  scoreCloseQueueRow,
  rankCloseQueue,
  budgetRangeMidpoint,
  daysSinceTouch,
  WEIGHTS,
  DEFAULT_DEAL_VALUE,
  DEAL_VALUE_CEILING,
  BHC_FEE_RATE,
  STALENESS_FULL_DAYS,
  type CloseQueueRow,
} from './closeQueue';

// A fixed "now" keeps every staleness assertion deterministic.
const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function row(over: Partial<CloseQueueRow> = {}): CloseQueueRow {
  return {
    id: 'rec1',
    status: 'Intro Sent',
    buyerName: 'Test Buyer',
    buyerState: 'TX',
    buyerEmail: 'b@example.com',
    buyerPhone: '+15125550000',
    rancherName: 'Test Ranch',
    hasRancher: true,
    rancherCanCapture: true,
    intentScore: 50,
    saleAmount: 0,
    budgetRange: '',
    createdAt: daysAgo(10),
    introSentAt: '',
    lastChasedAt: '',
    ...over,
  };
}

// ─── budgetRangeMidpoint ───────────────────────────────────────────────────

test('budgetRangeMidpoint: parses a two-sided range to its midpoint', () => {
  assert.equal(budgetRangeMidpoint('$1000-$2000'), 1500);
  assert.equal(budgetRangeMidpoint('$500-$1000'), 750);
  assert.equal(budgetRangeMidpoint('$1,500–$2,500'), 2000); // commas + en dash
});

test('budgetRangeMidpoint: treats a one-sided "<$500" as that bound', () => {
  assert.equal(budgetRangeMidpoint('<$500'), 500);
});

test('budgetRangeMidpoint: non-numeric buckets ("Unsure") yield null', () => {
  assert.equal(budgetRangeMidpoint('Unsure'), null);
  assert.equal(budgetRangeMidpoint('Just exploring'), null);
  assert.equal(budgetRangeMidpoint(''), null);
  assert.equal(budgetRangeMidpoint(undefined), null);
});

// ─── estimateDealValue ─────────────────────────────────────────────────────

test('estimateDealValue: a real Sale Amount always wins', () => {
  assert.equal(estimateDealValue(row({ saleAmount: 2400, budgetRange: '$500-$1000' })), 2400);
});

test('estimateDealValue: falls back to the budget midpoint when no Sale Amount', () => {
  assert.equal(estimateDealValue(row({ saleAmount: 0, budgetRange: '$1000-$2000' })), 1500);
});

test('estimateDealValue: falls back to the platform average when nothing is known', () => {
  assert.equal(estimateDealValue(row({ saleAmount: 0, budgetRange: 'Unsure' })), DEFAULT_DEAL_VALUE);
});

test('estimateDealValue: never returns a negative or NaN value', () => {
  assert.equal(estimateDealValue(row({ saleAmount: -50, budgetRange: '' })), DEFAULT_DEAL_VALUE);
  assert.equal(
    estimateDealValue(row({ saleAmount: Number.NaN as any, budgetRange: '' })),
    DEFAULT_DEAL_VALUE,
  );
});

// ─── estimateBhcFee ────────────────────────────────────────────────────────

test('estimateBhcFee: is a flat 10% of estimated deal value', () => {
  assert.equal(estimateBhcFee(2000), 200);
  assert.equal(estimateBhcFee(1619), round2(1619 * BHC_FEE_RATE));
});

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// ─── daysSinceTouch ────────────────────────────────────────────────────────

test('daysSinceTouch: uses the most recent touch stamp available', () => {
  const r = row({ createdAt: daysAgo(30), introSentAt: daysAgo(20), lastChasedAt: daysAgo(3) });
  assert.equal(daysSinceTouch(r, NOW), 3);
});

test('daysSinceTouch: falls back to created when nothing has been sent', () => {
  const r = row({ createdAt: daysAgo(9), introSentAt: '', lastChasedAt: '' });
  assert.equal(daysSinceTouch(r, NOW), 9);
});

test('daysSinceTouch: unparseable/absent dates read as maximally stale', () => {
  const r = row({ createdAt: '', introSentAt: '', lastChasedAt: '' });
  assert.equal(daysSinceTouch(r, NOW), STALENESS_FULL_DAYS);
});

// ─── scoreCloseQueueRow: each signal moves the score the right way ─────────

test('score: a bigger deal outranks a smaller one, all else equal', () => {
  const big = scoreCloseQueueRow(row({ saleAmount: 3000 }), NOW);
  const small = scoreCloseQueueRow(row({ saleAmount: 500 }), NOW);
  assert.ok(big.score > small.score);
});

test('score: deal value is capped at the ceiling — a whale cannot swamp the queue', () => {
  const atCeiling = scoreCloseQueueRow(row({ saleAmount: DEAL_VALUE_CEILING }), NOW);
  const wayOver = scoreCloseQueueRow(row({ saleAmount: DEAL_VALUE_CEILING * 10 }), NOW);
  assert.equal(atCeiling.score, wayOver.score);
});

test('score: a later stage outranks an earlier one', () => {
  const neg = scoreCloseQueueRow(row({ status: 'Negotiation' }), NOW);
  const intro = scoreCloseQueueRow(row({ status: 'Intro Sent' }), NOW);
  assert.ok(neg.score > intro.score);
});

test('score: Awaiting Payment is the hottest stage — the money is one click away', () => {
  const awaiting = scoreCloseQueueRow(row({ status: 'Awaiting Payment' }), NOW);
  const neg = scoreCloseQueueRow(row({ status: 'Negotiation' }), NOW);
  assert.ok(awaiting.score > neg.score);
});

test('score: a rancher who cannot capture a deposit ranks LOWER', () => {
  const canCapture = scoreCloseQueueRow(row({ rancherCanCapture: true }), NOW);
  const cannot = scoreCloseQueueRow(row({ rancherCanCapture: false }), NOW);
  assert.ok(cannot.score < canCapture.score);
  // The gap is exactly the capture weight — no hidden interaction.
  assert.equal(round2(canCapture.score - cannot.score), WEIGHTS.capture);
});

test('score: an unmatched referral cannot capture, so it loses the capture points', () => {
  const s = scoreCloseQueueRow(row({ hasRancher: false, rancherCanCapture: false }), NOW);
  assert.equal(s.signals.capture, 0);
});

test('score: staleness only ever increases urgency, and saturates at the cap', () => {
  // createdAt must be pushed back too: daysSinceTouch reads the MOST RECENT
  // stamp, so a fixture created 10 days ago would floor every case at 10.
  const aged = (d: number) => row({ createdAt: daysAgo(d), lastChasedAt: daysAgo(d) });
  const fresh = scoreCloseQueueRow(aged(0), NOW);
  const week = scoreCloseQueueRow(aged(7), NOW);
  const capped = scoreCloseQueueRow(aged(STALENESS_FULL_DAYS), NOW);
  const ancient = scoreCloseQueueRow(aged(400), NOW);
  assert.ok(fresh.score < week.score);
  assert.ok(week.score < capped.score);
  assert.equal(capped.score, ancient.score);
});

test('score: the most RECENT touch wins — a fresh chase revives an old row', () => {
  // Created 400 days ago but chased today ⇒ not stale at all.
  const s = scoreCloseQueueRow(row({ createdAt: daysAgo(400), lastChasedAt: daysAgo(0) }), NOW);
  assert.equal(s.signals.staleness, 0);
});

test('score: higher intent outranks lower intent', () => {
  const hot = scoreCloseQueueRow(row({ intentScore: 100 }), NOW);
  const cold = scoreCloseQueueRow(row({ intentScore: 10 }), NOW);
  assert.ok(hot.score > cold.score);
});

test('score: is bounded to 0..100 so the number stays readable', () => {
  const max = scoreCloseQueueRow(
    row({
      saleAmount: DEAL_VALUE_CEILING,
      status: 'Awaiting Payment',
      rancherCanCapture: true,
      intentScore: 100,
      createdAt: daysAgo(999),
      introSentAt: daysAgo(999),
      lastChasedAt: daysAgo(999),
    }),
    NOW,
  );
  assert.equal(max.score, 100);

  const min = scoreCloseQueueRow(
    row({
      saleAmount: 0,
      budgetRange: '<$500',
      status: 'Waitlisted',
      hasRancher: false,
      rancherCanCapture: false,
      intentScore: 0,
      createdAt: daysAgo(0),
      introSentAt: daysAgo(0),
      lastChasedAt: daysAgo(0),
    }),
    NOW,
  );
  assert.ok(min.score >= 0);
  assert.ok(min.score < 100);
});

test('score: weights sum to 100 so the score reads as a percentage of "perfect"', () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(sum, 100);
});

// ─── "why this one" ────────────────────────────────────────────────────────

test('why: names the single biggest contributor in plain English', () => {
  // Max deal value, everything else minimal → deal size must be the reason.
  const s = scoreCloseQueueRow(
    row({
      saleAmount: DEAL_VALUE_CEILING,
      status: 'Intro Sent',
      intentScore: 0,
      rancherCanCapture: false,
      lastChasedAt: daysAgo(0),
    }),
    NOW,
  );
  assert.equal(s.topReason, 'dealValue');
  assert.match(s.why, /\$/);
});

test('why: a long-untouched deal is called out as going cold', () => {
  const s = scoreCloseQueueRow(
    row({
      saleAmount: 1,
      budgetRange: '<$500',
      status: 'Intro Sent',
      intentScore: 0,
      rancherCanCapture: false,
      createdAt: daysAgo(60),
      lastChasedAt: daysAgo(60),
    }),
    NOW,
  );
  assert.equal(s.topReason, 'staleness');
  assert.match(s.why, /\d+ days/);
});

test('why: an Awaiting Payment deal is called out as balance-due', () => {
  const s = scoreCloseQueueRow(
    row({
      saleAmount: 1,
      budgetRange: '<$500',
      status: 'Awaiting Payment',
      intentScore: 0,
      rancherCanCapture: false,
      lastChasedAt: daysAgo(0),
    }),
    NOW,
  );
  assert.equal(s.topReason, 'stage');
});

test('why: always returns a non-empty sentence', () => {
  for (const status of ['Pending Approval', 'Intro Sent', 'Rancher Contacted', 'Negotiation']) {
    const s = scoreCloseQueueRow(row({ status }), NOW);
    assert.ok(s.why.length > 0, `empty why for ${status}`);
  }
});

// ─── rankCloseQueue ────────────────────────────────────────────────────────

test('rank: drops closed, lost, dormant and waitlisted rows', () => {
  const rows = [
    row({ id: 'won', status: 'Closed Won' }),
    row({ id: 'lost', status: 'Closed Lost' }),
    row({ id: 'dormant', status: 'Dormant' }),
    row({ id: 'waitlisted', status: 'Waitlisted' }),
    row({ id: 'open', status: 'Negotiation' }),
  ];
  const out = rankCloseQueue(rows, { now: NOW });
  assert.deepEqual(
    out.map((r) => r.id),
    ['open'],
  );
});

test('rank: orders by score descending and honours the limit', () => {
  const rows = [
    row({ id: 'cold', status: 'Intro Sent', saleAmount: 300, intentScore: 5, rancherCanCapture: false }),
    row({ id: 'hot', status: 'Awaiting Payment', saleAmount: 3000, intentScore: 100 }),
    row({ id: 'warm', status: 'Negotiation', saleAmount: 1500, intentScore: 60 }),
  ];
  const all = rankCloseQueue(rows, { now: NOW });
  assert.deepEqual(
    all.map((r) => r.id),
    ['hot', 'warm', 'cold'],
  );
  const top = rankCloseQueue(rows, { now: NOW, limit: 2 });
  assert.equal(top.length, 2);
  assert.deepEqual(
    top.map((r) => r.id),
    ['hot', 'warm'],
  );
});

test('rank: is a pure function — it does not mutate or reorder its input', () => {
  const rows = [row({ id: 'a', saleAmount: 100 }), row({ id: 'b', saleAmount: 3000 })];
  const before = rows.map((r) => r.id);
  rankCloseQueue(rows, { now: NOW });
  assert.deepEqual(
    rows.map((r) => r.id),
    before,
  );
});

test('rank: ties break deterministically by id so the list never shuffles', () => {
  const a = row({ id: 'aaa' });
  const b = row({ id: 'bbb' });
  const first = rankCloseQueue([a, b], { now: NOW }).map((r) => r.id);
  const second = rankCloseQueue([b, a], { now: NOW }).map((r) => r.id);
  assert.deepEqual(first, second);
});

test('rank: an empty queue is an empty array, not a throw', () => {
  assert.deepEqual(rankCloseQueue([], { now: NOW }), []);
});

test('rank: carries the money estimates through to each ranked row', () => {
  const [top] = rankCloseQueue([row({ saleAmount: 2000 })], { now: NOW });
  assert.equal(top.estValue, 2000);
  assert.equal(top.estFee, 200);
  assert.equal(top.daysSinceTouch, 10);
});
