import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slaDecisions,
  orderKind,
  NUDGE_DAYS,
  ESCALATE_DAYS,
  SLOW_NUDGE_DAYS,
  SLOW_ESCALATE_DAYS,
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
  assert.deepEqual(out, [{ id: 'a', action: 'nudge', ageDays: NUDGE_DAYS + 1, kind: 'ship' }]);
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
