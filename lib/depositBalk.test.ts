import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  balkSkipReason,
  selectBalkedReferrals,
  balkSkipBreakdown,
  minutesSinceOpen,
  BALK_MIN_AGE_MS,
  BALK_MAX_AGE_MS,
} from './depositBalk';

const NOW = Date.parse('2026-08-07T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const balked = (over: Record<string, unknown> = {}) => ({
  'Deposit Link Opened At': iso(2 * 60 * 60 * 1000), // 2h ago
  'Deposit Paid At': '',
  'Balk Alert Sent At': '',
  'Status': 'Awaiting Payment',
  ...over,
});

test('a 2h-old unpaid open with no prior alert is a balk', () => {
  assert.equal(balkSkipReason(balked(), NOW), null);
});

test('opens under 1h are too fresh — buyer may still be reading', () => {
  assert.equal(
    balkSkipReason(balked({ 'Deposit Link Opened At': iso(BALK_MIN_AGE_MS - 60_000) }), NOW),
    'too-fresh',
  );
});

test('opens past 48h belong to the nudge rails, not a hot ping', () => {
  assert.equal(
    balkSkipReason(balked({ 'Deposit Link Opened At': iso(BALK_MAX_AGE_MS + 60_000) }), NOW),
    'too-old',
  );
});

test('paid referrals are never balks', () => {
  assert.equal(
    balkSkipReason(balked({ 'Deposit Paid At': iso(60 * 60 * 1000) }), NOW),
    'already-paid',
  );
});

test('one ping per referral, ever', () => {
  assert.equal(
    balkSkipReason(balked({ 'Balk Alert Sent At': iso(30 * 60 * 1000) }), NOW),
    'already-alerted',
  );
});

test('terminal statuses are skipped, including select-object shapes', () => {
  assert.equal(balkSkipReason(balked({ Status: 'Closed Lost' }), NOW), 'terminal-status');
  assert.equal(
    balkSkipReason(balked({ Status: { id: 'selX', name: 'Closed Won' } }), NOW),
    'terminal-status',
  );
});

test('missing or unparseable open stamps never alert', () => {
  assert.equal(balkSkipReason(balked({ 'Deposit Link Opened At': '' }), NOW), 'no-open-stamp');
  assert.equal(
    balkSkipReason(balked({ 'Deposit Link Opened At': 'not-a-date' }), NOW),
    'unparseable-open',
  );
});

test('selection sorts oldest open first (closest to cold gets the first ping)', () => {
  const rows = [
    { id: 'newer', fields: balked({ 'Deposit Link Opened At': iso(90 * 60 * 1000) }) },
    { id: 'paid', fields: balked({ 'Deposit Paid At': iso(1000) }) },
    { id: 'older', fields: balked({ 'Deposit Link Opened At': iso(5 * 60 * 60 * 1000) }) },
  ];
  assert.deepEqual(selectBalkedReferrals(rows, NOW).map((r) => r.id), ['older', 'newer']);
});

test('breakdown counts every reason plus selected', () => {
  const rows = [
    { id: 'a', fields: balked() },
    { id: 'b', fields: balked({ 'Deposit Paid At': iso(1000) }) },
    { id: 'c', fields: balked({ 'Deposit Link Opened At': '' }) },
  ];
  assert.deepEqual(balkSkipBreakdown(rows, NOW), {
    selected: 1,
    'already-paid': 1,
    'no-open-stamp': 1,
  });
});

test('minutesSinceOpen rounds to whole minutes', () => {
  assert.equal(minutesSinceOpen(balked(), NOW), 120);
  assert.equal(minutesSinceOpen({ 'Deposit Link Opened At': '' }, NOW), 0);
});
