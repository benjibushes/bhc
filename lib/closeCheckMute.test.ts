// The mis-tap this pins: the Telegram close-check "mute" button used to write
// Close Check Sent At='2099-12-31', and close-detector skips any referral whose
// stamp is inside its cooldown — so ONE accidental tap disarmed close-detection
// on a live deal forever. A mute must be a bounded snooze.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSE_CHECK_MUTE_DAYS, closeCheckMuteUntilISO } from './closeCheckMute';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-25T12:00:00.000Z').getTime();

// The close-detector's own cooldown gate, reproduced exactly
// (app/api/cron/close-detector: daysSinceCheck < CHECK_COOLDOWN_DAYS → skip).
const CHECK_COOLDOWN_DAYS = 14;
const detectorSkips = (stampISO: string, atMs: number): boolean =>
  (atMs - new Date(stampISO).getTime()) / DAY_MS < CHECK_COOLDOWN_DAYS;

test('mute writes a real timestamp, never the far-future sentinel', () => {
  const stamp = closeCheckMuteUntilISO(NOW);
  assert.ok(!stamp.startsWith('2099'), 'must not reuse the give-up sentinel');
  assert.equal(new Date(stamp).getTime(), NOW + CLOSE_CHECK_MUTE_DAYS * DAY_MS);
});

test('the window is bounded and sane — a fat-finger costs weeks, not the deal', () => {
  assert.equal(CLOSE_CHECK_MUTE_DAYS, 30);
  assert.ok(CLOSE_CHECK_MUTE_DAYS > CHECK_COOLDOWN_DAYS, 'must outlast the normal cooldown');
  assert.ok(CLOSE_CHECK_MUTE_DAYS < 365, 'must not be a de-facto forever');
});

test('the detector DOES skip a freshly muted referral', () => {
  const stamp = closeCheckMuteUntilISO(NOW);
  assert.equal(detectorSkips(stamp, NOW), true);
  assert.equal(detectorSkips(stamp, NOW + 10 * DAY_MS), true);
  assert.equal(detectorSkips(stamp, NOW + 29 * DAY_MS), true);
});

test('THE FIX: the mute EXPIRES — the deal comes back on its own', () => {
  const stamp = closeCheckMuteUntilISO(NOW);
  // Once the stamp matures, the detector's own 14-day cooldown still measures
  // from it, so the next card lands ~44 days out. Bounded is the point.
  const reappearsAt = NOW + (CLOSE_CHECK_MUTE_DAYS + CHECK_COOLDOWN_DAYS) * DAY_MS;
  assert.equal(detectorSkips(stamp, reappearsAt - DAY_MS), true);
  assert.equal(detectorSkips(stamp, reappearsAt + DAY_MS), false);
});

test('the OLD behaviour would still be muted a century later (regression guard)', () => {
  const oldSentinel = '2099-12-31T00:00:00Z';
  const inTenYears = NOW + 3650 * DAY_MS;
  assert.equal(detectorSkips(oldSentinel, inTenYears), true, 'old sentinel: silent forever');
  assert.equal(detectorSkips(closeCheckMuteUntilISO(NOW), inTenYears), false, 'new mute: expires');
});

test('is pure — same input, same output, and never reads the clock', () => {
  assert.equal(closeCheckMuteUntilISO(NOW), closeCheckMuteUntilISO(NOW));
  assert.notEqual(closeCheckMuteUntilISO(NOW), closeCheckMuteUntilISO(NOW + DAY_MS));
});
