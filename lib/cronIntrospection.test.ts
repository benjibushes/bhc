// F4 (go-to-market debug 2026-07-01) — cron watchdog coverage guard.
//
// EXPECTED_CRONS_24H is the /cronstatus watchdog's world model: a cron not in
// the list can silently stop running forever and no one is told. This test
// pins the list to vercel.json — the actual schedule — so it can never
// silently rot again: EVERY scheduled cron path must be either
//   (a) in EXPECTED_CRONS_24H (watchdog flags a missed 24h window), or
//   (b) in EXCLUDED_CRONS_24H with a documented reason (weekly/monthly/
//       weekday-only cadence, or dark-by-default env gate that skips the
//       Cron Runs row entirely).
//
// Red-first: on 2026-07-01 this failed with 20+ crons (including the money
// safety nets final-invoice-dunning, deposit-accept-sla, stuck-referral-reaper,
// orphan-checkout-reaper, capacity-drift-check, demand-router, synthetic-e2e)
// missing from both sets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as introspection from './cronIntrospection';

const EXPECTED: readonly string[] = introspection.EXPECTED_CRONS_24H;
// Tolerate the export not existing yet (red-first) — coverage assert then
// reports every non-EXPECTED cron as missing.
const EXCLUDED: Record<string, string> =
  (introspection as { EXCLUDED_CRONS_24H?: Record<string, string> }).EXCLUDED_CRONS_24H ?? {};

// npm test runs from the repo root (tsx --test 'lib/**/*.test.ts').
const vercelJson = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'));
const crons: Array<{ path: string; schedule: string }> = vercelJson.crons || [];

// withCronRun('<name>', ...) names match the route directory for every cron
// (verified 2026-07-01) — so the Cron Runs name is derivable from the path.
const CRON_PREFIX = '/api/cron/';
const scheduledNames = crons.map((c) => {
  assert.ok(
    c.path.startsWith(CRON_PREFIX),
    `vercel.json cron path ${c.path} is not under ${CRON_PREFIX} — the watchdog derives Cron Runs names from the path`,
  );
  return c.path.slice(CRON_PREFIX.length);
});

test('vercel.json has a non-empty crons array (schema guard)', () => {
  assert.ok(scheduledNames.length > 0, 'vercel.json crons array is empty or missing');
});

test('every scheduled cron is watched (EXPECTED) or documented (EXCLUDED)', () => {
  const missing = scheduledNames.filter(
    (name) => !EXPECTED.includes(name) && !(name in EXCLUDED),
  );
  assert.deepEqual(
    missing,
    [],
    `crons scheduled in vercel.json but invisible to the /cronstatus watchdog — ` +
      `add each to EXPECTED_CRONS_24H (runs at least daily) or EXCLUDED_CRONS_24H ` +
      `(with a documented reason): ${missing.join(', ')}`,
  );
});

test('no cron is both EXPECTED and EXCLUDED', () => {
  const both = EXPECTED.filter((name) => name in EXCLUDED);
  assert.deepEqual(both, [], `crons in BOTH sets (pick one): ${both.join(', ')}`);
});

test('every EXPECTED cron is actually scheduled in vercel.json (no stale entries)', () => {
  const stale = EXPECTED.filter((name) => !scheduledNames.includes(name));
  assert.deepEqual(
    stale,
    [],
    `EXPECTED_CRONS_24H entries with no vercel.json schedule — the watchdog would ` +
      `alarm forever on a cron that can never run: ${stale.join(', ')}`,
  );
});

test('every EXCLUDED cron is actually scheduled and carries a documented reason', () => {
  for (const [name, reason] of Object.entries(EXCLUDED)) {
    assert.ok(
      scheduledNames.includes(name),
      `EXCLUDED_CRONS_24H entry '${name}' has no vercel.json schedule — stale, remove it`,
    );
    assert.ok(
      typeof reason === 'string' && reason.trim().length >= 10,
      `EXCLUDED_CRONS_24H entry '${name}' needs a real documented reason (got: ${JSON.stringify(reason)})`,
    );
  }
});

// ── missingExpectedCrons — the dead-man's-switch decision (2026-07-02) ──────
//
// buildCronStatusCard already computed the missing-in-24h set, but its sole
// consumer was the pull-only Telegram /cronstatus command. daily-health-digest
// only inspected Cron Runs rows that EXIST — a cron that writes NO row was
// invisible (in-repo precedent: commission-invoices was silently skipped by
// Vercel for 60+ days with zero rows). This pure helper is what the digest
// now pushes through sendOperatorSignal. Red-first: written before the
// helper existed.

type RunSummary = {
  name: string;
  startedAt: string;
  status: string;
  recordsTouched: number;
  notes: string;
};

const missingExpectedCrons = (
  introspection as {
    missingExpectedCrons?: (
      latestRuns: ReadonlyMap<string, RunSummary>,
      nowISO: string,
      windowMs?: number,
    ) => string[];
  }
).missingExpectedCrons;

const NOW_ISO = '2026-07-02T15:05:00.000Z';
const HOUR = 60 * 60 * 1000;

function runAt(name: string, agoMs: number): [string, RunSummary] {
  return [
    name,
    {
      name,
      startedAt: new Date(new Date(NOW_ISO).getTime() - agoMs).toISOString(),
      status: 'success',
      recordsTouched: 1,
      notes: '',
    },
  ];
}

/** Every EXPECTED cron ran 1h ago except the ones the caller omits. */
function allFreshExcept(...omit: string[]): Map<string, RunSummary> {
  return new Map(
    EXPECTED.filter((name) => !omit.includes(name)).map((name) => runAt(name, 1 * HOUR)),
  );
}

test('missingExpectedCrons is exported from lib/cronIntrospection', () => {
  assert.equal(
    typeof missingExpectedCrons,
    'function',
    'missingExpectedCrons(latestRuns, nowISO, windowMs?) must be exported so the daily-health-digest dead-man\'s switch and /cronstatus share ONE decision',
  );
});

test('a cron with NO Cron Runs row in the window is listed missing', () => {
  const latest = allFreshExcept('deposit-accept-sla', 'orphan-checkout-reaper');
  const missing = missingExpectedCrons!(latest, NOW_ISO);
  assert.deepEqual(missing.sort(), ['deposit-accept-sla', 'orphan-checkout-reaper']);
});

test('a cron whose latest run is OLDER than the window is listed missing (present-but-old)', () => {
  const latest = allFreshExcept('final-invoice-dunning');
  latest.set(...runAt('final-invoice-dunning', 25 * HOUR)); // present, but stale
  const missing = missingExpectedCrons!(latest, NOW_ISO);
  assert.deepEqual(missing, ['final-invoice-dunning']);
});

test('a cron that ran inside the window is NOT listed', () => {
  const latest = allFreshExcept('stuck-referral-reaper');
  latest.set(...runAt('stuck-referral-reaper', 23 * HOUR)); // inside 24h
  assert.deepEqual(missingExpectedCrons!(latest, NOW_ISO), []);
});

test('EXCLUDED crons are never listed, even with zero rows', () => {
  // Empty map = nothing ran at all. Every EXPECTED cron is missing; no
  // EXCLUDED cron (spam-audit weekly, replenishment dark, …) may appear.
  const missing = missingExpectedCrons!(new Map(), NOW_ISO);
  assert.deepEqual(missing.sort(), [...EXPECTED].sort());
  for (const name of Object.keys(EXCLUDED)) {
    assert.ok(
      !missing.includes(name),
      `EXCLUDED cron '${name}' must never be flagged missing — it would false-alarm by design`,
    );
  }
});

test('windowMs is respected (digest uses a 25h grace window against boundary jitter)', () => {
  const latest = allFreshExcept('synthetic-e2e');
  latest.set(...runAt('synthetic-e2e', 24.5 * HOUR));
  // 24h window: 24.5h-old run is stale → missing.
  assert.deepEqual(missingExpectedCrons!(latest, NOW_ISO, 24 * HOUR), ['synthetic-e2e']);
  // 25h window: same run is inside the grace window → healthy.
  assert.deepEqual(missingExpectedCrons!(latest, NOW_ISO, 25 * HOUR), []);
});

test('an unparseable startedAt counts as missing (never counts as healthy)', () => {
  const latest = allFreshExcept('capacity-drift-check');
  latest.set('capacity-drift-check', {
    name: 'capacity-drift-check',
    startedAt: 'not-a-date',
    status: 'success',
    recordsTouched: 0,
    notes: '',
  });
  assert.deepEqual(missingExpectedCrons!(latest, NOW_ISO), ['capacity-drift-check']);
});
