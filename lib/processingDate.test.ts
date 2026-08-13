import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProcessingDatePast } from './processingDate';

// Fixed "now" for determinism: 2026-08-13T15:30:00Z.
const NOW = new Date(Date.UTC(2026, 7, 13, 15, 30, 0));

test('date strictly before today (UTC) is past', () => {
  assert.equal(isProcessingDatePast('2026-08-01', NOW), true);
  assert.equal(isProcessingDatePast('2026-08-12', NOW), true);
  assert.equal(isProcessingDatePast('2025-12-31', NOW), true);
});

test('today is NOT past — processing day itself still renders', () => {
  assert.equal(isProcessingDatePast('2026-08-13', NOW), false);
});

test('future dates are not past', () => {
  assert.equal(isProcessingDatePast('2026-08-14', NOW), false);
  assert.equal(isProcessingDatePast('2026-09-01', NOW), false);
  assert.equal(isProcessingDatePast('2027-01-01', NOW), false);
});

test('blank / null / undefined fail open (not past)', () => {
  assert.equal(isProcessingDatePast('', NOW), false);
  assert.equal(isProcessingDatePast(null, NOW), false);
  assert.equal(isProcessingDatePast(undefined, NOW), false);
});

test('unparseable garbage fails open (not past)', () => {
  assert.equal(isProcessingDatePast('ask the rancher', NOW), false);
  assert.equal(isProcessingDatePast('TBD', NOW), false);
});

test('legacy datetime values compare by UTC calendar day', () => {
  // Past datetime
  assert.equal(isProcessingDatePast('2026-08-01T09:00:00.000Z', NOW), true);
  // Same-day datetime — not past regardless of time of day
  assert.equal(isProcessingDatePast('2026-08-13T23:59:00.000Z', NOW), false);
  // Future datetime
  assert.equal(isProcessingDatePast('2026-08-20T00:00:00.000Z', NOW), false);
});

test('date-only prefix wins even when a datetime suffix follows', () => {
  // slice(0,10) path: the calendar day the rancher picked is what counts.
  assert.equal(isProcessingDatePast('2026-08-01T00:00:00', NOW), true);
  assert.equal(isProcessingDatePast('2026-08-14T00:00:00', NOW), false);
});
