import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  needsFirstTouchNudge,
  needsFirstTouchEscalation,
  selectFirstTouchNudges,
  selectFirstTouchEscalations,
  privacyName,
  FIRST_TOUCH_NUDGE_AFTER_MS,
  FIRST_TOUCH_ESCALATE_AFTER_MS,
  ESCALATION_COOLDOWN_MS,
  type FirstTouchRef,
} from './firstTouchSla';

const NOW = new Date('2026-07-15T16:05:00.000Z').getTime();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const H = 60 * 60 * 1000;

const base = (over: Partial<FirstTouchRef> = {}): FirstTouchRef => ({
  id: 'recAAAAAAAAAAAA01',
  status: 'Intro Sent',
  introSentAt: iso(50 * H),
  ...over,
});

// ── needsFirstTouchNudge ────────────────────────────────────────────────────
test('nudges an untouched Intro Sent referral past 48h', () => {
  assert.equal(needsFirstTouchNudge(base(), NOW), true);
});

test('under 48h → no nudge yet', () => {
  assert.equal(needsFirstTouchNudge(base({ introSentAt: iso(47 * H) }), NOW), false);
  assert.equal(needsFirstTouchNudge(base({ introSentAt: iso(1 * H) }), NOW), false);
});

test('already nudged → never again (one SMS, ever)', () => {
  assert.equal(
    needsFirstTouchNudge(base({ firstTouchNudgedAt: iso(1 * H) }), NOW),
    false,
  );
});

test('status moved off Intro Sent → no nudge', () => {
  for (const status of ['Rancher Contacted', 'Negotiation', 'Closed Won', 'Closed Lost', 'Dormant', 'Awaiting Payment']) {
    assert.equal(needsFirstTouchNudge(base({ status }), NOW), false, status);
  }
});

test('real touch (later-day activity) → no nudge even if status lagged', () => {
  assert.equal(
    needsFirstTouchNudge(
      base({ introSentAt: iso(72 * H), lastRancherActivityAt: iso(20 * H) }),
      NOW,
    ),
    false,
  );
});

test('same-UTC-day activity stamp is the scanner artifact — still nudges', () => {
  const intro = '2026-07-12T15:00:00.000Z';
  assert.equal(
    needsFirstTouchNudge(
      base({ introSentAt: intro, lastRancherActivityAt: '2026-07-12T16:00:00.000Z' }),
      NOW,
    ),
    true,
  );
});

test('missing/garbage intro date → no nudge', () => {
  assert.equal(needsFirstTouchNudge(base({ introSentAt: undefined }), NOW), false);
  assert.equal(needsFirstTouchNudge(base({ introSentAt: 'garbage' }), NOW), false);
});

// ── needsFirstTouchEscalation ───────────────────────────────────────────────
test('escalates untouched referrals past 96h — nudged or not', () => {
  assert.equal(needsFirstTouchEscalation(base({ introSentAt: iso(97 * H) }), NOW), true);
  assert.equal(
    needsFirstTouchEscalation(
      base({ introSentAt: iso(97 * H), firstTouchNudgedAt: iso(48 * H) }),
      NOW,
    ),
    true,
  );
});

test('under 96h → no escalation', () => {
  assert.equal(needsFirstTouchEscalation(base({ introSentAt: iso(95 * H) }), NOW), false);
});

test('recent stalled-alert stamp (chasup shared throttle) suppresses the card', () => {
  assert.equal(
    needsFirstTouchEscalation(
      base({ introSentAt: iso(100 * H), stalledAlertSentAt: iso(24 * H) }),
      NOW,
    ),
    false,
  );
  // Stamp older than the 3d cooldown → card fires again.
  assert.equal(
    needsFirstTouchEscalation(
      base({ introSentAt: iso(200 * H), stalledAlertSentAt: iso(ESCALATION_COOLDOWN_MS + H) }),
      NOW,
    ),
    true,
  );
});

test('touched referral never escalates', () => {
  assert.equal(
    needsFirstTouchEscalation(
      base({ introSentAt: iso(120 * H), lastRancherActivityAt: iso(10 * H) }),
      NOW,
    ),
    false,
  );
  assert.equal(
    needsFirstTouchEscalation(base({ introSentAt: iso(120 * H), status: 'Closed Lost' }), NOW),
    false,
  );
});

// ── selectors: ordering + caps ──────────────────────────────────────────────
test('selectors return longest-waiting first and honor the cap', () => {
  const refs = [
    base({ id: 'recAAAAAAAAAAAA02', introSentAt: iso(50 * H) }),
    base({ id: 'recAAAAAAAAAAAA03', introSentAt: iso(300 * H) }),
    base({ id: 'recAAAAAAAAAAAA04', introSentAt: iso(100 * H) }),
    base({ id: 'recAAAAAAAAAAAA05', introSentAt: iso(10 * H) }), // too fresh
  ];
  const nudges = selectFirstTouchNudges(refs, NOW, 2);
  assert.deepEqual(nudges.map((r) => r.id), ['recAAAAAAAAAAAA03', 'recAAAAAAAAAAAA04']);

  const esc = selectFirstTouchEscalations(refs, NOW, 10);
  assert.deepEqual(esc.map((r) => r.id), ['recAAAAAAAAAAAA03', 'recAAAAAAAAAAAA04']);
});

test('sanity: window constants encode 48h / 96h', () => {
  assert.equal(FIRST_TOUCH_NUDGE_AFTER_MS, 48 * H);
  assert.equal(FIRST_TOUCH_ESCALATE_AFTER_MS, 96 * H);
});

// ── privacyName ─────────────────────────────────────────────────────────────
test('privacyName renders first name + last initial only', () => {
  assert.equal(privacyName('Amie Gunderson'), 'Amie G.');
  assert.equal(privacyName('Char Lee Ann Walters'), 'Char W.');
  assert.equal(privacyName('Cher'), 'Cher');
  assert.equal(privacyName(''), 'a buyer');
  assert.equal(privacyName(undefined), 'a buyer');
});
