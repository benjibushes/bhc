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
