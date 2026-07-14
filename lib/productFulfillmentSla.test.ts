import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slaDecisions, NUDGE_DAYS, ESCALATE_DAYS } from './productFulfillmentSla';

const NOW = '2026-07-14T12:00:00.000Z';
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 86400000).toISOString();

test('nudges a New order past NUDGE_DAYS, once', () => {
  const orders = [
    { id: 'a', status: 'New', orderedAt: daysAgo(NUDGE_DAYS + 1) },
    { id: 'b', status: 'New', orderedAt: daysAgo(NUDGE_DAYS + 1), slaNudgedAt: daysAgo(1) },
    { id: 'c', status: 'New', orderedAt: daysAgo(1) },
  ];
  const out = slaDecisions(orders, NOW);
  assert.deepEqual(out, [{ id: 'a', action: 'nudge', ageDays: NUDGE_DAYS + 1 }]);
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
