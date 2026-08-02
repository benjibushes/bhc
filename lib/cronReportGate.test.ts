// Wave 1C alert hygiene — the gating decisions are pure; pin them here so a
// refactor can't silently re-open the zero-work Telegram firehose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSendCronReport,
  calBookingCardDedupe,
  deployDriftDedupe,
  CAL_CARD_WINDOW_MS,
  DEPLOY_DRIFT_WINDOW_MS,
} from './cronReportGate';

test('shouldSendCronReport: zero work + zero failures = silent', () => {
  assert.equal(shouldSendCronReport({ workDone: 0, failures: 0 }), false);
});

test('shouldSendCronReport: any work = report', () => {
  assert.equal(shouldSendCronReport({ workDone: 1, failures: 0 }), true);
  assert.equal(shouldSendCronReport({ workDone: 25, failures: 0 }), true);
});

test('shouldSendCronReport: failures always report, even with zero work', () => {
  assert.equal(shouldSendCronReport({ workDone: 0, failures: 1 }), true);
  assert.equal(shouldSendCronReport({ workDone: 3, failures: 2 }), true);
});

test('shouldSendCronReport: NaN/negative degrade to silent, never crash', () => {
  assert.equal(shouldSendCronReport({ workDone: NaN, failures: NaN }), false);
  assert.equal(shouldSendCronReport({ workDone: -1, failures: 0 }), false);
});

test('calBookingCardDedupe: same attendee collapses across event types and case', () => {
  const a = calBookingCardDedupe('Rancher@Example.com');
  const b = calBookingCardDedupe('  rancher@example.com ');
  assert.equal(a.dedupeKey, b.dedupeKey);
  assert.equal(a.dedupeKey, 'cal-booking:rancher@example.com');
  assert.equal(a.dedupeWindowMs, CAL_CARD_WINDOW_MS);
});

test('calBookingCardDedupe: different attendees never collide', () => {
  assert.notEqual(
    calBookingCardDedupe('a@x.com').dedupeKey,
    calBookingCardDedupe('b@x.com').dedupeKey,
  );
});

test('calBookingCardDedupe: empty email still yields a stable key', () => {
  assert.equal(calBookingCardDedupe('').dedupeKey, 'cal-booking:unknown');
});

test('deployDriftDedupe: same stale SHA dedupes on the ~6h window', () => {
  const d = deployDriftDedupe('abc1234def');
  assert.equal(d.dedupeKey, 'deploy-drift:abc1234');
  assert.equal(d.dedupeWindowMs, DEPLOY_DRIFT_WINDOW_MS);
  assert.equal(DEPLOY_DRIFT_WINDOW_MS, 6 * 60 * 60 * 1000);
});

test('deployDriftDedupe: a different stale SHA alerts fresh (new key)', () => {
  assert.notEqual(deployDriftDedupe('abc1234').dedupeKey, deployDriftDedupe('fff9999').dedupeKey);
});

test('deployDriftDedupe: missing SHA degrades to a stable key', () => {
  assert.equal(deployDriftDedupe('').dedupeKey, 'deploy-drift:unknown');
});
