import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeErrorMessage,
  serverErrorDedupeKey,
  buildServerErrorSignal,
} from './serverErrorSignal';

// ── normalizeErrorMessage ────────────────────────────────────────────────────

test('normalize: lowercases, collapses whitespace, trims', () => {
  assert.equal(
    normalizeErrorMessage('  Airtable   READ\n Failed  '),
    'airtable read failed',
  );
});

test('normalize: variable digits collapse to # so retries hash identically', () => {
  const a = normalizeErrorMessage('timeout after 10023ms on attempt 3');
  const b = normalizeErrorMessage('timeout after 9871ms on attempt 7');
  assert.equal(a, b);
});

test('normalize: truncates very long messages', () => {
  const msg = 'x'.repeat(5000);
  assert.ok(normalizeErrorMessage(msg).length <= 200);
});

test('normalize: non-string input never throws', () => {
  assert.equal(typeof normalizeErrorMessage(undefined), 'string');
  assert.equal(typeof normalizeErrorMessage(null), 'string');
  assert.equal(typeof normalizeErrorMessage({ weird: true }), 'string');
});

// ── serverErrorDedupeKey ─────────────────────────────────────────────────────

test('dedupe key: stable for the same route+message', () => {
  assert.equal(
    serverErrorDedupeKey('/api/orders/request', 'Airtable read failed'),
    serverErrorDedupeKey('/api/orders/request', 'Airtable read failed'),
  );
});

test('dedupe key: same error class with different ids/numbers → SAME key (one alarm, not hundreds)', () => {
  assert.equal(
    serverErrorDedupeKey('/api/checkout/[refId]/deposit', 'record rec1 timeout after 10023ms'),
    serverErrorDedupeKey('/api/checkout/[refId]/deposit', 'record rec9 timeout after 31ms'),
  );
});

test('dedupe key: different messages → different keys', () => {
  assert.notEqual(
    serverErrorDedupeKey('/api/orders/request', 'Airtable read failed'),
    serverErrorDedupeKey('/api/orders/request', 'Stripe charge declined'),
  );
});

test('dedupe key: same message on different routes → different keys', () => {
  assert.notEqual(
    serverErrorDedupeKey('/api/orders/request', 'boom'),
    serverErrorDedupeKey('/api/webhooks/stripe', 'boom'),
  );
});

test('dedupe key: namespaced under server-error', () => {
  assert.ok(serverErrorDedupeKey('/x', 'y').startsWith('server-error:'));
});

// ── buildServerErrorSignal ───────────────────────────────────────────────────

test('build: loud system-error with 1h dedupe window', () => {
  const sig = buildServerErrorSignal({
    routePath: '/api/orders/request',
    routerKind: 'App Router',
    routeType: 'route',
    method: 'POST',
    message: 'Airtable read failed',
  });
  assert.equal(sig.urgency, 'loud');
  assert.equal(sig.kind, 'system-error');
  assert.equal(sig.dedupeWindowMs, 60 * 60 * 1000);
  assert.ok(sig.summary.includes('/api/orders/request'));
  assert.ok(sig.detail.includes('Airtable read failed'));
  assert.equal(sig.dedupeKey, serverErrorDedupeKey('/api/orders/request', 'Airtable read failed'));
});

test('build: missing routePath still produces a usable signal', () => {
  const sig = buildServerErrorSignal({ message: 'boom' });
  assert.ok(sig.summary.length > 0);
  assert.ok(sig.dedupeKey.startsWith('server-error:'));
});
