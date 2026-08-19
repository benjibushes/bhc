// lib/cronRunRollup.test.ts — one Cron Runs row per cron per UTC day.
//
// Cron Runs was 11,231 rows / 73 crons / 31 days = 22% of the base's 50,000
// cap, purely because every execution appended a row. Nothing reads a single
// execution; every consumer collapses to most-recent-per-name first. These
// pins encode what the rollup must preserve while doing that collapse at
// WRITE time instead of read time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rollupDayKey,
  mergeCronRunRollup,
  heartbeatPatch,
  type CronRunObservation,
  type CronRunRollupRow,
} from './cronRunRollup';

const obs = (over: Partial<CronRunObservation> = {}): CronRunObservation => ({
  name: 'deploy-drift',
  startedAtISO: '2026-08-19T10:00:00.000Z',
  endedAtISO: '2026-08-19T10:00:02.000Z',
  durationMs: 2000,
  status: 'success',
  recordsTouched: 3,
  notes: 'checked 12 routes',
  ...over,
});

// ── the day key ────────────────────────────────────────────────────────────

test('the day key is UTC, because the dead-man window and Vercel crons are UTC', () => {
  assert.equal(rollupDayKey('2026-08-19T00:05:00.000Z'), '2026-08-19');
  assert.equal(rollupDayKey('2026-08-19T23:55:00.000Z'), '2026-08-19');
  // A local-time key would put these on different days for anyone west of
  // Greenwich, splitting one cron-day across two rows.
  assert.equal(rollupDayKey('2026-08-19T04:30:00.000Z'), '2026-08-19');
});

test('an unparseable stamp yields no key, so the caller can fall back to append', () => {
  assert.equal(rollupDayKey('not-a-date'), '');
  assert.equal(rollupDayKey(''), '');
});

// ── first run of the day ───────────────────────────────────────────────────

test('the first run of the day opens the row with a count of one', () => {
  const row = mergeCronRunRollup(null, obs());
  assert.equal(row['Name'], 'deploy-drift');
  assert.equal(row['Run Day'], '2026-08-19');
  assert.equal(row['Run Count'], 1);
  assert.equal(row['Records Touched'], 3);
  assert.equal(row['Errors'], 0);
  assert.equal(row['Status'], 'success');
});

test('a failing first run opens the row with an error counted', () => {
  for (const status of ['error', 'partial']) {
    const row = mergeCronRunRollup(null, obs({ status }));
    assert.equal(row['Errors'], 1, `${status} must count as a failure`);
    assert.equal(row['Status'], status);
  }
});

// ── accumulating across the day ────────────────────────────────────────────

test('a second run accumulates work and count, and advances freshness', () => {
  const first = mergeCronRunRollup(null, obs()) as CronRunRollupRow;
  const row = mergeCronRunRollup(
    first,
    obs({ startedAtISO: '2026-08-19T11:00:00.000Z', endedAtISO: '2026-08-19T11:00:01.000Z', durationMs: 1000, recordsTouched: 4 }),
  );
  assert.equal(row['Run Count'], 2);
  assert.equal(row['Records Touched'], 7, 'work done today is the SUM, not the last run');
  assert.equal(row['Started At'], '2026-08-19T11:00:00.000Z', 'dead-man reads freshness here');
  assert.equal(row['Duration ms'], 1000, 'duration is the latest run, not a total');
});

test('a day that failed then recovered still shows the failure count', () => {
  let row: CronRunRollupRow = mergeCronRunRollup(null, obs({ status: 'error' })) as CronRunRollupRow;
  row = mergeCronRunRollup(row, obs({ startedAtISO: '2026-08-19T11:00:00.000Z', status: 'error' })) as CronRunRollupRow;
  row = mergeCronRunRollup(row, obs({ startedAtISO: '2026-08-19T12:00:00.000Z', status: 'success' })) as CronRunRollupRow;
  assert.equal(row['Status'], 'success', 'latest status, matching every existing reader');
  assert.equal(row['Errors'], 2, 'but the day is not silently green');
  assert.equal(row['Run Count'], 3);
});

// ── THE STATE CHANNEL: Notes must survive a later no-op ────────────────────
// campaign-autopilot and learning-report read Notes off PRIOR runs, scanning
// newest-first for the first parseable row. If a later empty-notes run
// overwrote the row, the token would vanish and those readers would silently
// fall back to a stale row or 'none'.

test('a later run with EMPTY notes cannot erase the run that carried the token', () => {
  const first = mergeCronRunRollup(
    null,
    obs({ name: 'campaign-autopilot', notes: 'pool=412 sent=8' }),
  ) as CronRunRollupRow;
  const row = mergeCronRunRollup(
    first,
    obs({ name: 'campaign-autopilot', startedAtISO: '2026-08-19T18:00:00.000Z', notes: '' }),
  );
  assert.equal(row['Notes'], 'pool=412 sent=8', 'the state channel must survive');
  assert.equal(row['Run Count'], 2, 'the no-op still counts as a run');
});

test('a later run WITH notes does advance them', () => {
  const first = mergeCronRunRollup(null, obs({ notes: 'old' })) as CronRunRollupRow;
  const row = mergeCronRunRollup(first, obs({ startedAtISO: '2026-08-19T18:00:00.000Z', notes: 'new' }));
  assert.equal(row['Notes'], 'new');
});

test('skip-reason breakdown follows the same rule as notes', () => {
  const first = mergeCronRunRollup(
    null,
    obs({ skipReasonBreakdown: { cooldown: 5 } }),
  ) as CronRunRollupRow;
  const row = mergeCronRunRollup(first, obs({ startedAtISO: '2026-08-19T18:00:00.000Z' }));
  assert.equal(row['Skip Reason Breakdown'], JSON.stringify({ cooldown: 5 }), 'not erased by a run without one');
  const row2 = mergeCronRunRollup(
    row as CronRunRollupRow,
    obs({ startedAtISO: '2026-08-19T19:00:00.000Z', skipReasonBreakdown: { paused: 2 } }),
  );
  assert.equal(row2['Skip Reason Breakdown'], JSON.stringify({ paused: 2 }), 'but a fresh one wins');
});

// ── out-of-order arrival ───────────────────────────────────────────────────

test('a late-landing OLDER run counts, but never drags freshness backwards', () => {
  const newest = mergeCronRunRollup(
    null,
    obs({ startedAtISO: '2026-08-19T12:00:00.000Z', notes: 'newest', recordsTouched: 5 }),
  ) as CronRunRollupRow;
  const row = mergeCronRunRollup(
    newest,
    obs({ startedAtISO: '2026-08-19T09:00:00.000Z', notes: 'stale', recordsTouched: 2, status: 'error' }),
  );
  assert.equal(row['Started At'], '2026-08-19T12:00:00.000Z', 'the dead-man must not see a stale stamp');
  assert.equal(row['Status'], 'success', 'nor a stale status');
  assert.equal(row['Notes'], 'newest', 'nor stale notes');
  assert.equal(row['Records Touched'], 7, 'but its work still counts');
  assert.equal(row['Run Count'], 2);
  assert.equal(row['Errors'], 1, 'and its failure still counts');
});

// ── heartbeat mode ─────────────────────────────────────────────────────────
// The 4 heartbeat crons write 'started' BEFORE the handler so a Vercel
// maxDuration kill leaves a row stuck at 'started' for the digest to flag.
// On a rolled-up row that pre-write must not reset the day's totals.

test('the heartbeat pre-write marks in-progress WITHOUT touching the day totals', () => {
  const patch = heartbeatPatch('2026-08-19T14:00:00.000Z');
  assert.equal(patch['Status'], 'started');
  assert.equal(patch['Started At'], '2026-08-19T14:00:00.000Z');
  assert.equal(patch['Run Day'], '2026-08-19');
  // The whole point: it is a PATCH. Touching these would erase earlier runs.
  assert.equal('Records Touched' in patch, false);
  assert.equal('Run Count' in patch, false);
  assert.equal('Errors' in patch, false);
  assert.equal('Notes' in patch, false);
});

// ── the dead-man's switch, end to end ──────────────────────────────────────

test('a cron that ran at 00:05 and again at 23:55 reads as FRESH, not 24h stale', () => {
  // This is the failure a first-run-wins merge would cause: one row per day
  // whose Started At never moved off the first execution.
  const first = mergeCronRunRollup(
    null,
    obs({ startedAtISO: '2026-08-19T00:05:00.000Z' }),
  ) as CronRunRollupRow;
  const row = mergeCronRunRollup(first, obs({ startedAtISO: '2026-08-19T23:55:00.000Z' }));
  const ageMs =
    new Date('2026-08-20T00:00:00.000Z').getTime() -
    new Date(String(row['Started At'])).getTime();
  assert.ok(ageMs < 24 * 60 * 60 * 1000, 'must not read as a missed cron');
  assert.equal(ageMs, 5 * 60 * 1000);
});

// ── the saving this exists for ─────────────────────────────────────────────

test('row count is bounded by cron count, not by how often crons fire', () => {
  // deploy-drift fires ~47x/day. Under the old append it wrote 47 rows.
  let row: CronRunRollupRow | null = null;
  for (let i = 0; i < 47; i++) {
    row = mergeCronRunRollup(
      row,
      obs({ startedAtISO: `2026-08-19T${String(i % 24).padStart(2, '0')}:00:00.000Z`, recordsTouched: 1 }),
    ) as CronRunRollupRow;
  }
  assert.equal(row!['Run Count'], 47, 'every execution is still accounted for');
  assert.equal(row!['Records Touched'], 47);
  // ...in ONE row. Raising the cron's frequency now costs zero extra rows.
});
