import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyThrownPushError, decidePushDisposition, decidePostPushAction } from './fulfillmentPushRunner';
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

// ── H1(c): "has-been-attempted / found-existing → skip". A row already carrying
// an external order id, a 'pushed' stamp, or a reconcile 'cancelled' stamp must
// never be re-pushed (double physical ship). 'pushing'/'failed:*' stay pushable
// so a manual repush of a stranded/fixed order still recovers.
test('decidePushDisposition: already-pushed / cancelled → skip; recoverable states → push', () => {
  assert.deepEqual(decidePushDisposition({ 'External Order Id': 'gid://shopify/Order/9' }), { action: 'skip', reason: 'already-pushed' });
  assert.deepEqual(decidePushDisposition({ 'External Push Status': 'pushed' }), { action: 'skip', reason: 'already-pushed' });
  assert.deepEqual(decidePushDisposition({ 'External Push Status': 'cancelled' }), { action: 'skip', reason: 'cancelled' });
  assert.deepEqual(decidePushDisposition({ 'External Push Status': '' }), { action: 'push' });
  assert.deepEqual(decidePushDisposition({ 'External Push Status': 'pushing' }), { action: 'push' }, 'stranded in-flight stays recoverable');
  assert.deepEqual(decidePushDisposition({ 'External Push Status': 'failed:SKU not found' }), { action: 'push' }, 'fixed permanent failure re-pushes');
});

// ── H2: post-push TOCTOU guard. A refund/cancel that flipped Status DURING the
// push network window must cancel the just-created live order, not stamp pushed.
test('decidePostPushAction: Refunded/Cancelled → cancel; otherwise keep', () => {
  assert.deepEqual(decidePostPushAction('Refunded'), { action: 'cancel', reason: 'Refunded' });
  assert.deepEqual(decidePostPushAction('Cancelled'), { action: 'cancel', reason: 'Cancelled' });
  assert.deepEqual(decidePostPushAction('New'), { action: 'keep' });
  assert.deepEqual(decidePostPushAction(undefined), { action: 'keep' });
});

// ── H1(c) source-shape pins: durable pre-stamp BEFORE the network call, and the
// success stamp WRAPPED so a lost stamp never leaves the row blank (which the
// net cron would re-push → double ship).
test('runner durably pre-stamps a push attempt before the network call', () => {
  assert.match(runnerSrc, /'External Push Status':\s*'pushing'/, "must pre-stamp 'pushing' before pushOrder");
  // the pre-stamp write precedes the pushOrder call in source order
  const preIdx = runnerSrc.indexOf("'External Push Status': 'pushing'");
  const pushIdx = runnerSrc.indexOf('.pushOrder(');
  assert.ok(preIdx > -1 && pushIdx > -1 && preIdx < pushIdx, 'pre-stamp must come before pushOrder');
});

test('runner wraps the success stamp so a failed stamp cannot silently re-push', () => {
  // the bare success updateRecord (no .catch) is the H1 bug — it must now be in
  // a try/catch that alerts + persists a non-blank fallback the net cron skips.
  assert.match(runnerSrc, /pushed-unstamped/, 'stamp-write failure persists a non-blank marker so the net cron never re-pushes');
  assert.match(runnerSrc, /decidePushDisposition/, 'runner consults the has-been-attempted decision');
});

// ── H2 source-shape pins: re-read Status after a successful push, cancel the
// live order on a refund-during-window, alert loud on a cancel failure.
test('runner re-reads Status after push and cancels a refunded-in-window order', () => {
  assert.match(runnerSrc, /decidePostPushAction/, 'must branch on the post-push guard decision');
  assert.match(runnerSrc, /\.cancelOrder\(/, 'a refunded-in-window order gets its live external order cancelled');
});

// ── L4 source-shape pin: a paid order that cannot push for a missing SKU or
// ship address must ring the operator (rancher/product needs fixing), not fail
// silent.
test('runner alerts the operator on a no-sku / no-address block (L4)', () => {
  assert.match(runnerSrc, /no-sku|no-address/, 'the alert must gate on the terminal fulfillment-blocking reasons');
  assert.match(runnerSrc, /urgency:\s*'normal'/, 'a fixable data gap is a normal-urgency nudge');
});

// ── M2 source-shape pin: the retry instruction points at the manual-repush
// field, not the >3-day-blind "clear External Push Status" no-op.
test('push-failure alerts instruct the manual-repush path (M2)', () => {
  assert.match(runnerSrc, /Push Retry Requested At/, 'operator is told to use the window-independent manual repush');
  assert.doesNotMatch(runnerSrc, /clear 'External Push Status'[^\n]*to retry/, 'the stale, silently-no-op retry instruction is gone');
});
