import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quickActionHttpStatus,
  QUICK_ACTION_INVALID_TOKEN_STATUS,
  QUICK_ACTION_BAD_ACTION_STATUS,
  type QuickActionResult,
} from './quickActionHttp';

// ──────────────────────────────────────────────────────────────────────────
// Wave 2 rancher-UX regression locks: the quick-action rail must never again
// answer HTTP 200 for a failure. Before this mapping existed, an expired
// token, an ownership mismatch, and a failed Airtable write all returned 200
// — invisible to dead-man checks and log-based alerting.
// ──────────────────────────────────────────────────────────────────────────

test('success maps to 200', () => {
  assert.equal(quickActionHttpStatus({ ok: true, message: 'done' }), 200);
});

test('every failure kind maps to a non-2xx status', () => {
  const cases: Array<[QuickActionResult['failureKind'], number]> = [
    ['not-found', 404],
    ['not-owner', 403],
    ['locked', 409],
    ['bad-input', 400],
    ['not-ready', 409],
    ['write-failed', 502],
  ];
  for (const [failureKind, expected] of cases) {
    const status = quickActionHttpStatus({ ok: false, message: 'x', failureKind });
    assert.equal(status, expected, `${failureKind} must map to ${expected}`);
    assert.ok(status >= 400, `${failureKind} must be an error status`);
  }
});

test('an unclassified failure still returns an error status, never 200', () => {
  assert.equal(quickActionHttpStatus({ ok: false, message: 'x' }), 500);
});

test('invalid-token and bad-action constants are error statuses', () => {
  assert.equal(QUICK_ACTION_INVALID_TOKEN_STATUS, 401);
  assert.equal(QUICK_ACTION_BAD_ACTION_STATUS, 400);
});
