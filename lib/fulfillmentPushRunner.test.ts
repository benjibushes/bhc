import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyThrownPushError } from './fulfillmentPushRunner';
import { IntegrationCryptoError } from './integrationCrypto';

// ── B1: a THROWN config error is PERMANENT (stamp + alert); anything else stays
// transient so a genuine Shopify/network blip is still retried by the net cron.

test('config-class thrown error → permanent-config, stamps failed:config', () => {
  assert.deepEqual(classifyThrownPushError(new IntegrationCryptoError('INTEGRATION_TOKEN_KEY unset')), {
    kind: 'permanent-config',
    stampStatus: 'failed:config',
  });
  // duck-typed marker (survives module/bundle boundaries)
  assert.equal(classifyThrownPushError({ configError: true }).kind, 'permanent-config');
});

test('a transient throw (Airtable/network) → transient, left unstamped for retry', () => {
  assert.deepEqual(classifyThrownPushError(new Error('AirtableError: connection reset')), { kind: 'transient' });
  assert.deepEqual(classifyThrownPushError(new TypeError('fetch failed')), { kind: 'transient' });
  assert.deepEqual(classifyThrownPushError(null), { kind: 'transient' });
});

// ── Route-shape pins: the runner's catch must persist the money-path truth
// (rule 2) AND ring the operator — a silent revert to log-only shows up here.
// Handlers with I/O can't be unit-run under `tsx --test`, so we pin the source
// shape (same technique as lib/referralLock.test.ts).
const runnerSrc = readFileSync(fileURLToPath(new URL('./fulfillmentPushRunner.ts', import.meta.url)), 'utf8');

test('runner persists failed:config on a config error (not just a log)', () => {
  assert.match(runnerSrc, /classifyThrownPushError\(e\)\.kind === 'permanent-config'/, 'catch must branch on the classifier');
  assert.match(runnerSrc, /'External Push Status':\s*'failed:config'/, "must STAMP failed:config, not leave blank");
});

test('runner rings the operator LOUD with an actionable, globally-deduped alert', () => {
  assert.match(runnerSrc, /sendOperatorSignal/, 'must reuse the shared operator alert helper');
  assert.match(runnerSrc, /urgency:\s*'loud'/, 'config failure is a money-path outage → loud');
  assert.match(runnerSrc, /INTEGRATION_TOKEN_KEY/, 'alert must name the actionable cause');
  assert.match(runnerSrc, /dedupeKey:\s*'shopify-push-config-fail'/, 'global dedupe → one alarm per run, not per order');
});
