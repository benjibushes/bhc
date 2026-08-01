import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slaDecisions,
  orderKind,
  slaWindowFor,
  NUDGE_DAYS,
  ESCALATE_DAYS,
  SLOW_NUDGE_DAYS,
  SLOW_ESCALATE_DAYS,
  PROMISE_NUDGE_GRACE_DAYS,
  PROMISE_ESCALATE_GRACE_DAYS,
} from './productFulfillmentSla';

const NOW = '2026-07-14T12:00:00.000Z';
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 86400000).toISOString();

test('nudges a New order past NUDGE_DAYS, once', () => {
  const orders = [
    { id: 'a', status: 'New', orderedAt: daysAgo(NUDGE_DAYS + 1) },
    { id: 'b', status: 'New', orderedAt: daysAgo(NUDGE_DAYS + 1), slaNudgedAt: daysAgo(1) },
    { id: 'c', status: 'New', orderedAt: daysAgo(1) },
  ];
  const out = slaDecisions(orders, NOW);
  assert.deepEqual(out, [
    { id: 'a', action: 'nudge', ageDays: NUDGE_DAYS + 1, kind: 'ship', notifyBuyer: false },
  ]);
});

test('escalates past ESCALATE_DAYS — even if already nudged, never double-mails same run', () => {
  const orders = [
    { id: 'x', status: 'New', orderedAt: daysAgo(ESCALATE_DAYS + 2), slaNudgedAt: daysAgo(4) },
    { id: 'y', status: 'New', orderedAt: daysAgo(ESCALATE_DAYS) },
  ];
  const out = slaDecisions(orders, NOW);
  assert.deepEqual(out.map((d) => [d.id, d.action]), [['x', 'escalate'], ['y', 'escalate']]);
});

test('ignores shipped/refunded, missing dates, malformed input', () => {
  const out = slaDecisions(
    [
      { id: 's', status: 'Shipped', orderedAt: daysAgo(10) },
      { id: 'r', status: 'Refunded', orderedAt: daysAgo(10) },
      { id: 'm', status: 'New' },
      null as any,
    ],
    NOW,
  );
  assert.deepEqual(out, []);
  assert.deepEqual(slaDecisions([], 'not-a-date'), []);
});

// ── Wave C (2026-07-14): deposit/pickup orders legitimately dwell in 'New'
// ('do not ship yet — confirm size + balance' / buyer hasn't driven out yet),
// so they ride the slow windows and kind-specific copy — never a ship nudge
// at day 3 nor a 'chargeback forming' scream at day 6 for a healthy order. ──

test('orderKind parses the Order Ref markers; deposit wins on compound refs', () => {
  assert.equal(orderKind('BHC-1234'), 'ship');
  assert.equal(orderKind(''), 'ship');
  assert.equal(orderKind(undefined), 'ship');
  assert.equal(orderKind('DEPOSIT — BHC-1234'), 'deposit');
  assert.equal(orderKind('PICKUP — BHC-1234'), 'pickup');
  // Compound stamp: deposit action (confirm size + balance) precedes pickup.
  assert.equal(orderKind('DEPOSIT — PICKUP — BHC-1234'), 'deposit');
});

test('deposit/pickup orders are NOT nudged inside the ship window', () => {
  const orders = [
    // Both ages would fire for a ship order (past nudge / past escalate) but
    // sit below SLOW_NUDGE_DAYS — healthy deposit/pickup dwell, no action.
    { id: 'd', status: 'New', orderedAt: daysAgo(NUDGE_DAYS + 1), orderRef: 'DEPOSIT — 1' },
    { id: 'p', status: 'New', orderedAt: daysAgo(ESCALATE_DAYS), orderRef: 'PICKUP — 2' },
  ];
  assert.deepEqual(slaDecisions(orders, NOW), []);
});

test('deposit/pickup nudge at SLOW_NUDGE_DAYS with their own kind', () => {
  const orders = [
    { id: 'd', status: 'New', orderedAt: daysAgo(SLOW_NUDGE_DAYS + 1), orderRef: 'DEPOSIT — 1' },
    { id: 'p', status: 'New', orderedAt: daysAgo(SLOW_NUDGE_DAYS), orderRef: 'PICKUP — 2' },
  ];
  const out = slaDecisions(orders, NOW);
  assert.deepEqual(out.map((d) => [d.id, d.action, d.kind]), [
    ['d', 'nudge', 'deposit'],
    ['p', 'nudge', 'pickup'],
  ]);
});

test('deposit/pickup escalate only at SLOW_ESCALATE_DAYS', () => {
  const orders = [
    { id: 'd', status: 'New', orderedAt: daysAgo(SLOW_ESCALATE_DAYS), orderRef: 'DEPOSIT — 1' },
    { id: 'p', status: 'New', orderedAt: daysAgo(SLOW_ESCALATE_DAYS - 1), orderRef: 'PICKUP — 2', slaNudgedAt: daysAgo(5) },
  ];
  const out = slaDecisions(orders, NOW);
  // d crosses the slow escalate line; p is nudged already + below the line → nothing.
  assert.deepEqual(out.map((d) => [d.id, d.action, d.kind]), [['d', 'escalate', 'deposit']]);
});

test('ship orders keep the tight windows even when deposit/pickup rows ride along', () => {
  const orders = [
    { id: 'ship', status: 'New', orderedAt: daysAgo(NUDGE_DAYS + 1), orderRef: 'BHC-77' },
    { id: 'dep', status: 'New', orderedAt: daysAgo(NUDGE_DAYS + 1), orderRef: 'DEPOSIT — 88' },
  ];
  const out = slaDecisions(orders, NOW);
  assert.deepEqual(out.map((d) => [d.id, d.action, d.kind]), [['ship', 'nudge', 'ship']]);
});

// ── Shop-chain audit (2026-08-01): 'Ships In Days' finally means something ──
// It is quoted to the buyer at checkout; until now the SLA compared it to
// nothing and used a flat 3/6 for every ship order.

test('slaWindowFor rides the promise for ship orders and falls back when absent', () => {
  assert.deepEqual(slaWindowFor('ship', 1), {
    nudgeDays: 1 + PROMISE_NUDGE_GRACE_DAYS,
    escalateDays: 1 + PROMISE_ESCALATE_GRACE_DAYS,
    fromPromise: true,
  });
  assert.deepEqual(slaWindowFor('ship', 14), {
    nudgeDays: 14 + PROMISE_NUDGE_GRACE_DAYS,
    escalateDays: 14 + PROMISE_ESCALATE_GRACE_DAYS,
    fromPromise: true,
  });
  // No promise / garbage promise ⇒ the flat rail, byte-identical to before.
  for (const p of [null, undefined, 0, -3, NaN, 'soon' as any]) {
    assert.deepEqual(slaWindowFor('ship', p as any), {
      nudgeDays: NUDGE_DAYS,
      escalateDays: ESCALATE_DAYS,
      fromPromise: false,
    });
  }
  // Deposit/pickup never ride a ship promise.
  assert.deepEqual(slaWindowFor('deposit', 1), {
    nudgeDays: SLOW_NUDGE_DAYS,
    escalateDays: SLOW_ESCALATE_DAYS,
    fromPromise: false,
  });
  assert.deepEqual(slaWindowFor('pickup', 1).nudgeDays, SLOW_NUDGE_DAYS);
});

test('a 1-day promise is chased on day 2 instead of waiting until day 3', () => {
  const orders = [{ id: 'fast', status: 'New', orderedAt: daysAgo(2), promisedShipDays: 1 }];
  const out = slaDecisions(orders, NOW);
  assert.deepEqual(out.map((d) => [d.id, d.action]), [['fast', 'nudge']]);
  // …and the flat rail would have said nothing at all on day 2.
  assert.deepEqual(slaDecisions([{ id: 'fast', status: 'New', orderedAt: daysAgo(2) }], NOW), []);
});

test('a 14-day promise is NOT nudged on day 3 (no more crying wolf at on-time ranchers)', () => {
  const slow = { id: 'slow', status: 'New', orderedAt: daysAgo(NUDGE_DAYS + 1), promisedShipDays: 14 };
  assert.deepEqual(slaDecisions([slow], NOW), []);
  // It does fire once genuinely past its own promise.
  const late = { id: 'slow', status: 'New', orderedAt: daysAgo(16), promisedShipDays: 14 };
  assert.deepEqual(slaDecisions([late], NOW).map((d) => d.action), ['nudge']);
  const veryLate = { id: 'slow', status: 'New', orderedAt: daysAgo(19), promisedShipDays: 14 };
  assert.deepEqual(slaDecisions([veryLate], NOW).map((d) => d.action), ['escalate']);
});

// ── Telling the BUYER their order is late ──────────────────────────────────

test('notifyBuyer rides escalate only, and is one-shot per order', () => {
  const base = { status: 'New', orderedAt: daysAgo(ESCALATE_DAYS + 1) };
  const fresh = slaDecisions([{ id: 'a', ...base }], NOW);
  assert.deepEqual(fresh.map((d) => [d.action, d.notifyBuyer]), [['escalate', true]]);

  // Already told ⇒ never again.
  const told = slaDecisions([{ id: 'a', ...base, buyerNotifiedAt: daysAgo(1) }], NOW);
  assert.deepEqual(told.map((d) => [d.action, d.notifyBuyer]), [['escalate', false]]);

  // A nudge never mails the buyer.
  const nudge = slaDecisions([{ id: 'b', status: 'New', orderedAt: daysAgo(NUDGE_DAYS + 1) }], NOW);
  assert.deepEqual(nudge.map((d) => [d.action, d.notifyBuyer]), [['nudge', false]]);
});

test('a whitespace-only buyer stamp does not count as "already told"', () => {
  const out = slaDecisions(
    [{ id: 'a', status: 'New', orderedAt: daysAgo(ESCALATE_DAYS + 1), buyerNotifiedAt: '   ' }],
    NOW,
  );
  assert.equal(out[0].notifyBuyer, true);
});

test('deposit/pickup buyers also get told, but only on their slow escalate line', () => {
  const orders = [
    { id: 'd', status: 'New', orderedAt: daysAgo(SLOW_ESCALATE_DAYS), orderRef: 'DEPOSIT — 1' },
    { id: 'p', status: 'New', orderedAt: daysAgo(SLOW_ESCALATE_DAYS), orderRef: 'PICKUP — 2' },
  ];
  const out = slaDecisions(orders, NOW);
  assert.deepEqual(out.map((d) => [d.kind, d.action, d.notifyBuyer]), [
    ['deposit', 'escalate', true],
    ['pickup', 'escalate', true],
  ]);
});
