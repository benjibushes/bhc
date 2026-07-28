import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregatePausedCrons } from './pausedCrons';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-28T15:00:00.000Z').getTime();

test('Cron Pauses row (Paused=true) → entry with computed day count + reason + by', () => {
  const out = aggregatePausedCrons({
    pauseRows: [
      {
        Name: 'synthetic-e2e',
        Paused: true,
        'Paused At': new Date(NOW - 49 * DAY).toISOString(),
        Reason: 'flaky checkout probe',
        'Paused By': 'ben',
      },
    ],
    recentRuns: [],
    nowMs: NOW,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'synthetic-e2e');
  assert.equal(out[0].pausedDays, 49);
  assert.equal(out[0].reason, 'flaky checkout probe');
  assert.equal(out[0].by, 'ben');
});

test('Paused=false rows are ignored (resumed crons)', () => {
  const out = aggregatePausedCrons({
    pauseRows: [{ Name: 'nurture-drip', Paused: false, 'Paused At': new Date(NOW - DAY).toISOString() }],
    recentRuns: [],
    nowMs: NOW,
  });
  assert.equal(out.length, 0);
});

test('unparseable Paused At → pausedDays null, entry still surfaces', () => {
  const out = aggregatePausedCrons({
    pauseRows: [{ Name: 'daily-audit', Paused: true, 'Paused At': 'garbage' }],
    recentRuns: [],
    nowMs: NOW,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].pausedDays, null);
});

test('fallback: cron whose recent runs are ALL paused surfaces even without a pause row', () => {
  const out = aggregatePausedCrons({
    pauseRows: [],
    recentRuns: [
      { Name: 'close-detector', Status: 'paused' },
      { Name: 'close-detector', Status: 'paused' },
    ],
    nowMs: NOW,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'close-detector');
  assert.equal(out[0].pausedDays, null);
});

test('cron with mixed statuses in recent runs is NOT flagged from runs', () => {
  const out = aggregatePausedCrons({
    pauseRows: [],
    recentRuns: [
      { Name: 'close-detector', Status: 'paused' },
      { Name: 'close-detector', Status: 'success' },
    ],
    nowMs: NOW,
  });
  assert.equal(out.length, 0);
});

test('union dedupes by name — pause-table entry wins (it has the metadata)', () => {
  const out = aggregatePausedCrons({
    pauseRows: [
      { Name: 'synthetic-e2e', Paused: true, 'Paused At': new Date(NOW - 2 * DAY).toISOString(), Reason: 'r' },
    ],
    recentRuns: [{ Name: 'synthetic-e2e', Status: 'paused' }],
    nowMs: NOW,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].pausedDays, 2);
});

test('output is sorted by name for a stable digest line', () => {
  const out = aggregatePausedCrons({
    pauseRows: [
      { Name: 'zebra-cron', Paused: true, 'Paused At': new Date(NOW - DAY).toISOString() },
      { Name: 'alpha-cron', Paused: true, 'Paused At': new Date(NOW - DAY).toISOString() },
    ],
    recentRuns: [],
    nowMs: NOW,
  });
  assert.deepEqual(out.map((e) => e.name), ['alpha-cron', 'zebra-cron']);
});

test('null/undefined inputs never throw (degraded reads)', () => {
  const out = aggregatePausedCrons({ pauseRows: null as any, recentRuns: undefined as any, nowMs: NOW });
  assert.deepEqual(out, []);
});
