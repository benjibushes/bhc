// Retention drain capacity (capacity audit 2026-08-19).
//
// WHAT BROKE: the drain could not out-pace inflow, structurally.
// MAX_DELETES_PER_TABLE = 1000 rows per table per run, on a ONCE-DAILY cron.
// Above ~1,000 rows/day of inflow on any single table, that table can never be
// drained and the deficit compounds forever. Measured against the live base on
// 2026-08-19 the cron was only barely breaking even on Cron Runs (343/day in vs
// a 1,000/day ceiling), and it had NO capacity at all to work down a backlog:
// if a retention window is ever shortened, the resulting one-time backlog
// drains at 1,000/day — e.g. an ~18,000-row Email Sends backlog would take 18
// DAYS while the base sat against its 50,000-record cap.
//
// These tests pin the arithmetic of the replacement: a time-budgeted drain
// whose measured daily capacity exceeds measured inflow with real headroom.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RETENTION,
  RUN_BUDGET_MS,
  DELETE_BATCH_SIZE,
  DEFAULT_BATCH_PACING_MS,
  RUNS_PER_DAY,
  MAX_DELETES_PER_TABLE_PER_RUN,
  MIN_RETENTION_DAYS,
  EMAIL_SENDS_RETENTION_DAYS,
  MEASURED_DAILY_INFLOW_ROWS,
  AIRTABLE_REQ_PER_SEC_CEILING,
  rowsAffordable,
  dailyDrainCapacityRows,
  perTableBudgetMs,
  resolveBatchPacingMs,
  requestsPerSecond,
  parseRetentionOverrides,
  applyRetentionOverrides,
  isCensusOrBackupRun,
} from './logRetentionPlan';

// ── The headline claim: the drain out-paces inflow ───────────────────────

test('DRAIN > INFLOW: one day of runs deletes far more than one day of measured inflow', () => {
  const capacity = dailyDrainCapacityRows({
    runBudgetMs: RUN_BUDGET_MS,
    pacingMs: DEFAULT_BATCH_PACING_MS,
    batchSize: DELETE_BATCH_SIZE,
    runsPerDay: RUNS_PER_DAY,
  });
  assert.ok(
    capacity > MEASURED_DAILY_INFLOW_ROWS,
    `drain capacity ${capacity}/day must exceed measured inflow ${MEASURED_DAILY_INFLOW_ROWS}/day`,
  );
  // The brief's stress case: 3x send volume is trivially reachable
  // (abandoned-quiz-nudge alone caps at 50/run x 24 runs/day = 1,200/day).
  assert.ok(
    capacity > 3 * MEASURED_DAILY_INFLOW_ROWS,
    `drain must survive 3x volume: ${capacity} vs ${3 * MEASURED_DAILY_INFLOW_ROWS}`,
  );
  // And it must be able to work down a real backlog, not just break even.
  assert.ok(capacity >= 10_000, `capacity ${capacity}/day is too thin to drain a five-figure backlog`);
});

test('the OLD config could NOT out-pace a shortened-window backlog (this is the regression guard)', () => {
  const oldCapacity = dailyDrainCapacityRows({
    runBudgetMs: RUN_BUDGET_MS,
    pacingMs: 250,
    batchSize: DELETE_BATCH_SIZE,
    runsPerDay: 1,
    maxPerTablePerRun: 1000, // the old hard cap, per table, per run
  });
  // 7 tables x 1,000 = 7,000/day ceiling; a single hot table was capped at 1,000.
  assert.ok(oldCapacity <= 7_000, 'sanity: the old shape really was capped this low');
  const newCapacity = dailyDrainCapacityRows({
    runBudgetMs: RUN_BUDGET_MS,
    pacingMs: DEFAULT_BATCH_PACING_MS,
    batchSize: DELETE_BATCH_SIZE,
    runsPerDay: RUNS_PER_DAY,
  });
  assert.ok(newCapacity > 3 * oldCapacity, 'the new drain must be a step change, not a nudge');
});

test('a single hot table is no longer capped at 1,000/run — the per-table cap is a safety ceiling, not the constraint', () => {
  const perRun = rowsAffordable(RUN_BUDGET_MS, DEFAULT_BATCH_PACING_MS, DELETE_BATCH_SIZE);
  assert.ok(perRun > 1_000, `one run must be able to delete more than the old ${1_000}-row cap (got ${perRun})`);
  assert.ok(
    MAX_DELETES_PER_TABLE_PER_RUN > perRun,
    'the per-table ceiling must sit ABOVE what the time budget allows, so time is what binds',
  );
});

// ── Rate-limit safety: the drain must not eat the base ───────────────────

test('pacing keeps the cron under HALF the Airtable per-base request ceiling', () => {
  const rps = requestsPerSecond(DEFAULT_BATCH_PACING_MS);
  assert.ok(rps <= AIRTABLE_REQ_PER_SEC_CEILING / 2, `${rps} req/s leaves too little headroom for live traffic`);
  // The old 250ms pacing was 4 req/s of a 5 req/s ceiling — the cron that
  // exists to PROTECT the base was itself 80% of the budget.
  assert.ok(requestsPerSecond(250) > AIRTABLE_REQ_PER_SEC_CEILING / 2, 'sanity: the old pacing really was that greedy');
});

test('the run budget fits inside the route maxDuration with room for reads and the backup leg', () => {
  assert.ok(RUN_BUDGET_MS <= 240_000, 'must leave >=60s of a 300s maxDuration for reads, backup and response');
});

test('resolveBatchPacingMs is env-tunable (throttle an incident without a deploy) but never unsafe', () => {
  const prev = process.env.LOG_RETENTION_PACING_MS;
  try {
    delete process.env.LOG_RETENTION_PACING_MS;
    assert.equal(resolveBatchPacingMs(), DEFAULT_BATCH_PACING_MS);
    process.env.LOG_RETENTION_PACING_MS = '1000';
    assert.equal(resolveBatchPacingMs(), 1000, 'slowing down must be allowed');
    process.env.LOG_RETENTION_PACING_MS = '10';
    assert.ok(
      requestsPerSecond(resolveBatchPacingMs()) <= AIRTABLE_REQ_PER_SEC_CEILING / 2,
      'a reckless env value must be clamped, not obeyed — 10ms would be 100 req/s',
    );
    process.env.LOG_RETENTION_PACING_MS = 'banana';
    assert.equal(resolveBatchPacingMs(), DEFAULT_BATCH_PACING_MS);
  } finally {
    if (prev === undefined) delete process.env.LOG_RETENTION_PACING_MS;
    else process.env.LOG_RETENTION_PACING_MS = prev;
  }
});

// ── Fair sharing across tables ───────────────────────────────────────────

test('per-table budget splits the REMAINING time evenly, so one huge table cannot starve the rest', () => {
  assert.equal(perTableBudgetMs(240_000, 7), Math.floor(240_000 / 7));
  // A table that finishes early hands its leftover to the ones behind it.
  assert.ok(perTableBudgetMs(200_000, 3) > perTableBudgetMs(200_000, 7));
  assert.equal(perTableBudgetMs(1_000, 0), 0, 'no tables left ⇒ no budget');
  assert.equal(perTableBudgetMs(-5, 3), 0, 'exhausted budget never goes negative');
});

// ── Retention windows ────────────────────────────────────────────────────

test('every retention entry names a table and a positive window', () => {
  assert.ok(RETENTION.length >= 7);
  for (const r of RETENTION) {
    assert.ok(r.table && typeof r.table === 'string');
    assert.ok(r.days >= MIN_RETENTION_DAYS, `${r.table}: ${r.days}d is below the ${MIN_RETENTION_DAYS}d floor`);
    assert.ok(r.why && r.why.length > 20, `${r.table}: needs a documented justification`);
  }
});

test('windows with audit/compliance value are flagged so nobody shortens them casually', () => {
  const byTable = Object.fromEntries(RETENTION.map((r) => [r.table, r]));
  // Named explicitly: these are the ones a future session must escalate, not decide.
  for (const t of ['Stripe Events', 'AI Audit Log', 'Deal Events']) {
    assert.equal(byTable[t]?.operatorDecision, true, `${t} must be marked operator-decision`);
  }
});

test('Email Sends is safe to expire ONLY because no lifetime fact is derived from it any more', () => {
  // It used to double as an unbounded send-dedupe ledger: send-scheduled and
  // testimonial-collection queried it with NO date bound, so shortening the
  // window shortened that memory and could produce a duplicate send to a real
  // buyer. That is why it sat at 90d (72% of the base cap) with an
  // operator-decision flag on it.
  //
  // Both couplings are gone: the "already asked" fact moved to
  // Consumers[Testimonial Asked At], and the per-campaign "already attempted"
  // set is now bounded by the campaign's own start, with send-scheduled
  // refusing to send when that start predates EMAIL_SENDS_RETENTION_DAYS.
  // The window could therefore come down. If anyone re-introduces an unbounded
  // reader, this reasoning — and this test — must be revisited first.
  const es = RETENTION.find((r) => r.table === 'Email Sends');
  assert.ok(es);
  assert.ok(es!.days <= 45, 'the whole point was to get this window down');
  assert.match(
    es!.why,
    /dedupe|duplicate|Testimonial Asked At/i,
    'the reason must still name the hazard that used to block this',
  );
});

// ── Env override: make the decision cheap and reversible for the operator ──

test('parseRetentionOverrides reads a "Table=days" list', () => {
  assert.deepEqual(parseRetentionOverrides('Email Sends=45,Cron Runs=14'), {
    'Email Sends': 45,
    'Cron Runs': 14,
  });
  assert.deepEqual(parseRetentionOverrides(' Email Sends = 45 '), { 'Email Sends': 45 });
  assert.deepEqual(parseRetentionOverrides(''), {});
  assert.deepEqual(parseRetentionOverrides(undefined), {});
});

test('OVERRIDE SAFETY: a typo can never nuke the base — sub-floor and garbage values are refused', () => {
  assert.deepEqual(parseRetentionOverrides('Email Sends=0'), {}, '0 days would delete everything');
  assert.deepEqual(parseRetentionOverrides('Email Sends=-30'), {});
  assert.deepEqual(parseRetentionOverrides('Email Sends=abc'), {});
  assert.deepEqual(parseRetentionOverrides('Email Sends=3'), {}, `below the ${MIN_RETENTION_DAYS}d floor`);
  assert.deepEqual(parseRetentionOverrides('Email Sends=1000000'), { 'Email Sends': 1000000 }, 'lengthening is always safe');
});

test('an override for an UNKNOWN table is ignored — retention never invents a table to delete from', () => {
  const applied = applyRetentionOverrides(RETENTION, { Consumers: 30, Referrals: 7 });
  assert.equal(applied.find((r) => r.table === 'Consumers'), undefined);
  assert.equal(applied.find((r) => r.table === 'Referrals'), undefined);
  assert.equal(applied.length, RETENTION.length);
});

test('applyRetentionOverrides swaps only the days, preserving order and metadata', () => {
  // Use a table that still carries operator-decision metadata, so this pin
  // tests the override mechanics rather than one table's current flags.
  const applied = applyRetentionOverrides(RETENTION, { 'Email Sends': 45, 'Deal Events': 200 });
  const es = applied.find((r) => r.table === 'Email Sends')!;
  assert.equal(es.days, 45);
  const flagged = RETENTION.find((r) => r.operatorDecision);
  assert.ok(flagged, 'at least one table should still be operator-flagged');
  const appliedFlagged = applied.find((r) => r.table === flagged!.table)!;
  assert.equal(appliedFlagged.operatorDecision, true, 'metadata must survive an override');
  assert.deepEqual(applied.map((r) => r.table), RETENTION.map((r) => r.table));
  // Untouched tables keep their compiled-in window.
  const cron = applied.find((r) => r.table === 'Cron Runs')!;
  assert.equal(cron.days, RETENTION.find((r) => r.table === 'Cron Runs')!.days);
});

// ── Once-a-day legs on a 4x-a-day cron ───────────────────────────────────

test('the backup/census leg runs on exactly ONE of the day\'s runs', () => {
  // The cron now fires 4x/day. The nightly encrypted backup keeps only the
  // newest 14 blobs — running it 4x/day would silently cut backup history from
  // 14 days to 3.5.
  const hours = [3, 9, 15, 21];
  const firing = hours.filter((h) => isCensusOrBackupRun(new Date(Date.UTC(2026, 7, 19, h, 10))));
  assert.equal(firing.length, 1, `expected exactly one backup run per day, got hours ${firing.join(',')}`);
});

test('a manual/off-schedule invocation still gets a backup rather than silently skipping it', () => {
  // If the scheduled slot is missed, an operator hitting the endpoint by hand
  // inside the same UTC hour must still produce a backup.
  assert.equal(isCensusOrBackupRun(new Date(Date.UTC(2026, 7, 19, 9, 59))), true);
  assert.equal(isCensusOrBackupRun(new Date(Date.UTC(2026, 7, 19, 10, 0))), false);
});

// ── The Email Sends window and the campaign-resume horizon are ONE number ──
// send-scheduled refuses to send a campaign whose start predates the Email
// Sends retention, because its dedupe set would be silently incomplete and
// recipients already emailed would be emailed AGAIN. That check reads
// EMAIL_SENDS_RETENTION_DAYS; the drain reads the RETENTION table. If the two
// ever disagree, the cron either blocks sends it could safely make, or — far
// worse — sends against a dedupe set the drain has already eaten.

test('EMAIL_SENDS_RETENTION_DAYS equals the RETENTION entry it guards', () => {
  const rule = RETENTION.find((r) => r.table === 'Email Sends');
  assert.ok(rule, 'Email Sends must have a retention rule');
  assert.equal(
    EMAIL_SENDS_RETENTION_DAYS,
    rule!.days,
    'send-scheduled would guard the wrong window — a double-blast risk',
  );
});

test('the Email Sends window never drops below the hard retention floor', () => {
  assert.ok(
    EMAIL_SENDS_RETENTION_DAYS >= MIN_RETENTION_DAYS,
    `${EMAIL_SENDS_RETENTION_DAYS}d is below the ${MIN_RETENTION_DAYS}d floor`,
  );
});
