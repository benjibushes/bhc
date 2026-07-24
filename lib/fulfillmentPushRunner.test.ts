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

// ── H2 + refund-verify (HOLE 1): post-push guard FAILS CLOSED. A refund/cancel
// that flipped Status — or belt-stamped External Push Status='cancelled' — DURING
// the push window must cancel the just-created live order, not stamp pushed. An
// UNREADABLE re-read must route to 'verify-failed' (alert + never 'pushed'), never
// silently fall through to 'keep'.
test('decidePostPushAction: readOk=false → verify-failed (fail CLOSED, never keep)', () => {
  // The HOLE 1 hazard: a transient re-read failure must NOT map to keep (which
  // stamps 'pushed' over a possibly-refunded order). Status is irrelevant when
  // the read itself is unconfirmed.
  assert.deepEqual(decidePostPushAction(undefined, undefined, false), { action: 'verify-failed' });
  assert.deepEqual(decidePostPushAction('New', '', false), { action: 'verify-failed' });
  assert.deepEqual(decidePostPushAction('Refunded', 'cancelled', false), { action: 'verify-failed' });
});

test('decidePostPushAction: terminal Status (readOk) → cancel the live order', () => {
  assert.deepEqual(decidePostPushAction('Refunded', '', true), { action: 'cancel', reason: 'Refunded' });
  assert.deepEqual(decidePostPushAction('Cancelled', 'pushing', true), { action: 'cancel', reason: 'Cancelled' });
});

test('decidePostPushAction: belt-stamped External Push Status cancelled → cancel', () => {
  // The blank-External-Order-Id race: a charge.refunded reconcile belt-stamped
  // 'cancelled' WITHOUT calling Shopify cancel (the order did not exist yet).
  // The push just created the live order — cancel it, never overwrite 'pushed'.
  assert.deepEqual(decidePostPushAction('New', 'cancelled', true), { action: 'cancel', reason: 'belt-cancelled' });
});

test('decidePostPushAction: clean New/undefined but readOk → keep (pre-stamp pushing is NOT the belt signal)', () => {
  assert.deepEqual(decidePostPushAction('New', '', true), { action: 'keep' });
  // the runner pre-stamps 'pushing' before the push — a clean success re-reads it
  // and must still map to keep; only an explicit 'cancelled' triggers belt-cancel.
  assert.deepEqual(decidePostPushAction('New', 'pushing', true), { action: 'keep' });
  assert.deepEqual(decidePostPushAction(undefined, undefined, true), { action: 'keep' });
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

// ── HOLE 1 source-shape pins: the post-push re-read must FAIL CLOSED. It passes
// readOk (never silently maps a failed read to keep), branches to verify-failed,
// leaves the row 'pushing' WITH the external id (traceable, no double-ship, never
// 'pushed'), and rings the operator LOUD.
test('runner post-push re-read fails CLOSED and passes readOk to the guard', () => {
  // the third arg to decidePostPushAction is the readOk flag — the fail-closed
  // signal that stops a transient null read from stamping 'pushed'.
  assert.match(
    runnerSrc,
    /decidePostPushAction\(\s*fresh\?\.\['Status'\],\s*fresh\?\.\['External Push Status'\],\s*readOk\s*\)/,
    'guard must receive (Status, External Push Status, readOk) — not Status alone',
  );
  assert.match(runnerSrc, /readOk\s*=\s*false/, 'the re-read must start unconfirmed and only flip true on a real row');
});

test('runner verify-failed branch never stamps pushed and alerts loud', () => {
  assert.match(runnerSrc, /post\.action === 'verify-failed'/, 'a failed re-read routes to verify-failed, not keep');
  assert.match(runnerSrc, /post-push refund-verify FAILED/, 'verify-failed must ring the operator');
  assert.match(runnerSrc, /shopify-postpush-verify-fail-/, 'per-order dedupe key so the net cron does not re-alarm every run');
  // the verify-failed write keeps the row traceable/cron-resolvable: external id
  // stamped + 'pushing' (never a silent 'pushed').
  const vfIdx = runnerSrc.indexOf("post.action === 'verify-failed'");
  const nextReturn = runnerSrc.indexOf('return;', vfIdx);
  const branch = runnerSrc.slice(vfIdx, nextReturn);
  assert.match(branch, /'External Order Id': externalOrderId/, 'verify-failed stamps the external id so a re-push is blocked');
  assert.match(branch, /'External Push Status': 'pushing'/, 'verify-failed leaves the row pushing (cron/operator-resolvable)');
  assert.doesNotMatch(branch, /'External Push Status': 'pushed'/, 'verify-failed must NEVER stamp pushed');
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
