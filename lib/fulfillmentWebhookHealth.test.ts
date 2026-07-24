import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectStalePushedOrders, PUSHED_STALE_HOURS } from './fulfillmentWebhookHealth';

const NOW = '2026-07-24T12:00:00.000Z';
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 60 * 60 * 1000).toISOString();

const stale = {
  id: 'recSTALE',
  status: 'New',
  externalPushStatus: 'pushed',
  externalPushedAt: hoursAgo(PUSHED_STALE_HOURS + 1),
  slaNudgedAt: '',
};

test('pushed + stale + New + not-yet-alerted → selected', () => {
  const sel = selectStalePushedOrders([stale], NOW);
  assert.equal(sel.length, 1);
  assert.equal(sel[0].id, 'recSTALE');
  assert.equal(sel[0].ageHours, PUSHED_STALE_HOURS + 1);
});

test('fresh (younger than threshold) → excluded', () => {
  assert.equal(selectStalePushedOrders([{ ...stale, externalPushedAt: hoursAgo(PUSHED_STALE_HOURS - 1) }], NOW).length, 0);
});

test('exactly at threshold → selected (>=)', () => {
  assert.equal(selectStalePushedOrders([{ ...stale, externalPushedAt: hoursAgo(PUSHED_STALE_HOURS) }], NOW).length, 1);
});

test('shipped / cancelled / refunded → excluded (webhook did its job, or terminal)', () => {
  for (const status of ['Shipped', 'Cancelled', 'Refunded']) {
    assert.equal(selectStalePushedOrders([{ ...stale, status }], NOW).length, 0, `${status} must be excluded`);
  }
});

test('not pushed (blank / skipped / failed) → excluded (net cron owns those)', () => {
  for (const externalPushStatus of ['', 'skipped:pickup', 'failed:config']) {
    assert.equal(selectStalePushedOrders([{ ...stale, externalPushStatus }], NOW).length, 0, `${externalPushStatus} must be excluded`);
  }
});

test('already health-alerted (SLA Nudged At stamped) → excluded (fire once)', () => {
  assert.equal(selectStalePushedOrders([{ ...stale, slaNudgedAt: hoursAgo(1) }], NOW).length, 0);
});

test('unparseable / blank External Pushed At → excluded (never alert on a guess)', () => {
  assert.equal(selectStalePushedOrders([{ ...stale, externalPushedAt: '' }], NOW).length, 0);
  assert.equal(selectStalePushedOrders([{ ...stale, externalPushedAt: 'not-a-date' }], NOW).length, 0);
});

test('bad now / empty input → empty (no throw)', () => {
  assert.deepEqual(selectStalePushedOrders([stale], 'garbage'), []);
  assert.deepEqual(selectStalePushedOrders([], NOW), []);
  assert.deepEqual(selectStalePushedOrders([null as any, undefined as any], NOW), []);
});
