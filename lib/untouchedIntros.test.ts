import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRealRancherTouch,
  needsFirstCall,
  selectUntouchedIntros,
  introAgeLabel,
} from './untouchedIntros';

const INTRO = '2026-07-10T15:00:00.000Z';

// ── isRealRancherTouch ──────────────────────────────────────────────────────
test('no activity at all is not a touch', () => {
  assert.equal(isRealRancherTouch(INTRO, undefined), false);
  assert.equal(isRealRancherTouch(INTRO, ''), false);
});

test('same-UTC-day activity is the auto-stamp artifact — not a touch', () => {
  assert.equal(isRealRancherTouch(INTRO, '2026-07-10T15:00:01.000Z'), false);
  assert.equal(isRealRancherTouch(INTRO, '2026-07-10T23:59:59.000Z'), false);
});

test('activity on a later day is a real touch', () => {
  assert.equal(isRealRancherTouch(INTRO, '2026-07-11T09:00:00.000Z'), true);
  assert.equal(isRealRancherTouch(INTRO, '2026-07-14T20:00:00.000Z'), true);
});

test('garbage timestamps are not a touch', () => {
  assert.equal(isRealRancherTouch(INTRO, 'not-a-date'), false);
  assert.equal(isRealRancherTouch(undefined, '2026-07-11T09:00:00.000Z'), false);
});

// ── needsFirstCall ──────────────────────────────────────────────────────────
test('intro sent + no activity → needs first call', () => {
  assert.equal(needsFirstCall({ status: 'Intro Sent', introSentAt: INTRO }), true);
});

test('intro sent + same-day auto-stamp → still needs first call', () => {
  assert.equal(
    needsFirstCall({
      status: 'Intro Sent',
      introSentAt: INTRO,
      lastRancherActivityAt: '2026-07-10T15:00:05.000Z',
    }),
    true,
  );
});

test('real next-day touch → out of the queue', () => {
  assert.equal(
    needsFirstCall({
      status: 'Rancher Contacted',
      introSentAt: INTRO,
      lastRancherActivityAt: '2026-07-11T08:00:00.000Z',
    }),
    false,
  );
});

test('no Intro Sent At → never in the queue', () => {
  assert.equal(needsFirstCall({ status: 'Intro Sent' }), false);
  assert.equal(needsFirstCall({ status: 'Intro Sent', introSentAt: 'garbage' }), false);
});

test('terminal + deposit-rail statuses are excluded even when untouched', () => {
  for (const status of ['Closed Won', 'Closed Lost', 'Refunded', 'Awaiting Payment', 'Slot Locked']) {
    assert.equal(needsFirstCall({ status, introSentAt: INTRO }), false, status);
  }
});

test('Dormant is excluded — stale-hold expiry re-routed the buyer already', () => {
  // staleHolds flips 21d-stale Intro Sent/Rancher Contacted rows to Dormant
  // and resets the buyer READY; queuing them for a first call would invite
  // double-contact (Silverline had 60 such rows at discovery).
  assert.equal(needsFirstCall({ status: 'Dormant', introSentAt: INTRO }), false);
});

test('rancher-action statuses prove the touch even with a same-day stamp', () => {
  // Only rancher actions produce these (quick-action POST in_talks, dashboard
  // status change). Rancher calls at 11am and clicks "In talks" same day —
  // exactly what the 24h CTA asks — must not be nagged as needing a call.
  for (const status of ['Rancher Contacted', 'Negotiation']) {
    assert.equal(
      needsFirstCall({
        status,
        introSentAt: INTRO,
        lastRancherActivityAt: '2026-07-10T17:00:00.000Z',
      }),
      false,
      status,
    );
  }
  // The historical scanner artifact stays caught: same-day stamp with status
  // still 'Intro Sent' is NOT proof of a touch.
  assert.equal(
    needsFirstCall({
      status: 'Intro Sent',
      introSentAt: INTRO,
      lastRancherActivityAt: '2026-07-10T17:00:00.000Z',
    }),
    true,
  );
});

// ── selectUntouchedIntros ───────────────────────────────────────────────────
test('filters to untouched and sorts oldest intro first', () => {
  const refs = [
    { id: 'newer', status: 'Intro Sent', introSentAt: '2026-07-14T10:00:00.000Z' },
    { id: 'touched', status: 'Rancher Contacted', introSentAt: '2026-07-08T10:00:00.000Z', lastRancherActivityAt: '2026-07-09T10:00:00.000Z' },
    { id: 'oldest', status: 'Intro Sent', introSentAt: '2026-07-06T10:00:00.000Z' },
    { id: 'sameday', status: 'Intro Sent', introSentAt: '2026-07-12T10:00:00.000Z', lastRancherActivityAt: '2026-07-12T10:00:01.000Z' },
    { id: 'closed', status: 'Closed Lost', introSentAt: '2026-07-05T10:00:00.000Z' },
  ];
  assert.deepEqual(
    selectUntouchedIntros(refs).map((r) => r.id),
    ['oldest', 'sameday', 'newer'],
  );
});

// ── introAgeLabel ───────────────────────────────────────────────────────────
test('age badge shows hours under 48h, then days', () => {
  const now = new Date('2026-07-12T15:00:00.000Z').getTime();
  assert.equal(introAgeLabel('2026-07-12T09:00:00.000Z', now), '6h');
  assert.equal(introAgeLabel('2026-07-10T16:00:00.000Z', now), '47h');
  assert.equal(introAgeLabel('2026-07-10T15:00:00.000Z', now), '2d');
  assert.equal(introAgeLabel('2026-07-05T15:00:00.000Z', now), '7d');
});

test('age badge is empty for garbage input, zero-floored for future stamps', () => {
  const now = new Date('2026-07-12T15:00:00.000Z').getTime();
  assert.equal(introAgeLabel('garbage', now), '');
  assert.equal(introAgeLabel('2026-07-12T16:00:00.000Z', now), '0h');
});
