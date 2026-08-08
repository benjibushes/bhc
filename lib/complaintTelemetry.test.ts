import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractComplaintDates,
  countComplaintStampsSince,
  COMPLAINT_ALERT_THRESHOLD,
  COMPLAINT_WINDOW_MS,
} from './complaintTelemetry';

// ─────────────────────────────────────────────────────────────────────
// P2.5 complaint telemetry — the rolling 7-day spam-complaint count is
// derived from the dated Notes stamps the Resend webhook already writes:
//   Consumers: "[Auto-unsub 2026-08-08] spam complaint"
//   Ranchers:  "[Auto-flag 2026-08-08] Email spam complaint"
// No new table, no new field — the stamps ARE the ledger.
// ─────────────────────────────────────────────────────────────────────

test('extractComplaintDates: consumer-style Auto-unsub spam complaint line', () => {
  const notes = 'signed up via /access\n[Auto-unsub 2026-08-05] spam complaint';
  assert.deepEqual(extractComplaintDates(notes), ['2026-08-05']);
});

test('extractComplaintDates: rancher-style Auto-flag Email spam complaint line', () => {
  const notes = '[Auto-flag 2026-08-06] Email spam complaint';
  assert.deepEqual(extractComplaintDates(notes), ['2026-08-06']);
});

test('extractComplaintDates: bounce stamps are NOT complaints', () => {
  const notes = '[Auto-unsub 2026-08-05] bounced\n[Auto-flag 2026-08-06] Email bounced';
  assert.deepEqual(extractComplaintDates(notes), []);
});

test('extractComplaintDates: multiple complaint lines all extracted', () => {
  const notes =
    '[Auto-unsub 2026-07-01] spam complaint\nsome operator note\n[Auto-unsub 2026-08-05] spam complaint';
  assert.deepEqual(extractComplaintDates(notes), ['2026-07-01', '2026-08-05']);
});

test('extractComplaintDates: empty/undefined/non-string notes are safe', () => {
  assert.deepEqual(extractComplaintDates(''), []);
  assert.deepEqual(extractComplaintDates(undefined), []);
  assert.deepEqual(extractComplaintDates(null), []);
  assert.deepEqual(extractComplaintDates(42), []);
});

test('countComplaintStampsSince: counts only stamps inside the window', () => {
  const since = Date.parse('2026-08-01T00:00:00Z');
  const records = [
    { Notes: '[Auto-unsub 2026-08-05] spam complaint' }, // in window
    { Notes: '[Auto-unsub 2026-07-20] spam complaint' }, // stale
    { Notes: '[Auto-flag 2026-08-01] Email spam complaint' }, // boundary — counts
  ];
  assert.equal(countComplaintStampsSince(records, since), 2);
});

test('countComplaintStampsSince: duplicate same-day lines on one record count once (webhook redelivery)', () => {
  const since = Date.parse('2026-08-01T00:00:00Z');
  const records = [
    {
      Notes:
        '[Auto-unsub 2026-08-05] spam complaint\n[Auto-unsub 2026-08-05] spam complaint',
    },
  ];
  assert.equal(countComplaintStampsSince(records, since), 1);
});

test('countComplaintStampsSince: distinct days on one record each count', () => {
  const since = Date.parse('2026-08-01T00:00:00Z');
  const records = [
    {
      Notes:
        '[Auto-unsub 2026-08-02] spam complaint\n[Auto-unsub 2026-08-05] spam complaint',
    },
  ];
  assert.equal(countComplaintStampsSince(records, since), 2);
});

test('countComplaintStampsSince: records without complaint stamps contribute zero', () => {
  const since = Date.parse('2026-08-01T00:00:00Z');
  const records = [{ Notes: 'manual note' }, { Notes: '' }, {}];
  assert.equal(countComplaintStampsSince(records, since), 0);
});

test('alert threshold sits BEFORE the ~5/wk kill line', () => {
  assert.equal(COMPLAINT_ALERT_THRESHOLD, 3);
  assert.ok(COMPLAINT_ALERT_THRESHOLD < 5, 'must alert before the kill line, not at it');
  assert.equal(COMPLAINT_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
});
