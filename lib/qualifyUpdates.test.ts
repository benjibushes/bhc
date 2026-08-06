// lib/qualifyUpdates.test.ts
// Runner: npm test (tsx --test 'lib/**/*.test.ts')

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQualifyConsumerUpdates,
  isExplicitlyNotReady,
  isValidAckConfirmedAt,
  normalizeLegacyTiming,
  timingFromNotes,
} from './qualifyUpdates';

const NOW = '2026-07-15T12:00:00.000Z';

function base(over: Partial<Parameters<typeof buildQualifyConsumerUpdates>[0]> = {}) {
  return buildQualifyConsumerUpdates({
    tier: 'Half',
    timing: 'Within 30 days',
    answersJson: '{"tier":"Half"}',
    score: 90,
    completedAt: NOW,
    ...over,
  });
}

test('route-eligible path stamps BOTH Qualified At and Funnel Completed At', () => {
  const u = base();
  assert.equal(u['Qualified At'], NOW);
  assert.equal(u['Funnel Completed At'], NOW);
  assert.equal(u['Qualification Score'], 90);
  assert.equal(u['Order Type'], 'Half');
  assert.equal(u['Timing'], 'Within 30 days');
});

test('hold branch (Not Sure tier) stamps Funnel Completed At ONLY — never Qualified At', () => {
  const u = base({ tier: 'Not Sure' });
  assert.equal(u['Funnel Completed At'], NOW);
  assert.equal('Qualified At' in u, false);
  // "Not Sure" never narrows the stored signup tier.
  assert.equal('Order Type' in u, false);
});

test('hold branch (Just exploring timing) stamps Funnel Completed At ONLY', () => {
  const u = base({ timing: 'Just exploring' });
  assert.equal(u['Funnel Completed At'], NOW);
  assert.equal('Qualified At' in u, false);
  assert.equal('Timing' in u, false);
});

// THE auto-stamp regression: the old funnel hard-coded ack:true for every
// completer. A submit WITHOUT the real tap must never produce Response Ack At.
test('no commitment tap → NO Response Ack At (auto-stamp regression)', () => {
  assert.equal('Response Ack At' in base(), false);
  assert.equal('Response Ack At' in base({ ackConfirmedAt: undefined }), false);
  assert.equal('Response Ack At' in base({ ackConfirmedAt: '' }), false);
  assert.equal('Response Ack At' in base({ ackConfirmedAt: 'not-a-date' }), false);
  assert.equal('Response Ack At' in base({ ackConfirmedAt: true }), false);
  assert.equal('Response Ack At' in base({ ackConfirmedAt: 12345 }), false);
});

test('real commitment tap → Response Ack At stamped (server time)', () => {
  const u = base({ ackConfirmedAt: '2026-07-15T11:59:58.000Z' });
  assert.equal(u['Response Ack At'], NOW);
});

test('held buyer who still tapped the commitment gets the ack stamp (truthful) but stays unqualified', () => {
  const u = base({ tier: 'Not Sure', ackConfirmedAt: '2026-07-15T11:59:58.000Z' });
  assert.equal(u['Response Ack At'], NOW);
  assert.equal('Qualified At' in u, false);
});

test('isExplicitlyNotReady covers exactly the two self-ID holds', () => {
  assert.equal(isExplicitlyNotReady('Not Sure', 'Within 30 days'), true);
  assert.equal(isExplicitlyNotReady('Half', 'Just exploring'), true);
  assert.equal(isExplicitlyNotReady('Half', 'Within 30 days'), false);
  assert.equal(isExplicitlyNotReady('Whole', 'Within 60 days'), false);
});

// ── Legacy vocab hydration (2026-07-22, reactivation audit) ────────────────

test('normalizeLegacyTiming maps legacy /access vocab to quiz vocab', () => {
  assert.equal(normalizeLegacyTiming('1-3 months'), 'Within 60 days');
  assert.equal(normalizeLegacyTiming('3-6 months'), 'Within 90 days');
  // Quiz vocab + unknowns pass through untouched.
  assert.equal(normalizeLegacyTiming('ASAP'), 'ASAP');
  assert.equal(normalizeLegacyTiming('Within 30 days'), 'Within 30 days');
  assert.equal(normalizeLegacyTiming('  1-3 months  '), 'Within 60 days');
  assert.equal(normalizeLegacyTiming(''), '');
  assert.equal(normalizeLegacyTiming('garbage'), 'garbage');
});

test('timingFromNotes parses the legacy [Timing: …] Notes tag', () => {
  assert.equal(timingFromNotes('[Timing: 1-3 months]'), '1-3 months');
  assert.equal(timingFromNotes('[Timing: ASAP]\nsome other notes'), 'ASAP');
  assert.equal(timingFromNotes('no tag here'), '');
  assert.equal(timingFromNotes(''), '');
});

test('hold from hydration DEFAULTS only → NO Funnel Completed At (stays nudge-chaseable)', () => {
  const u = base({
    tier: 'Not Sure',
    timing: 'Just exploring',
    tierDefaulted: true,
    timingDefaulted: true,
  });
  assert.equal('Funnel Completed At' in u, false);
  assert.equal('Qualified At' in u, false);
  // Answers + score still persisted for drop-off analytics.
  assert.equal(u['Qualification Score'], 90);
});

test('EXPLICIT not-ready answer still stamps Funnel Completed At even when the other value defaulted', () => {
  // Buyer really chose "Not Sure"; timing fell back to the default.
  const u = base({ tier: 'Not Sure', timing: 'Just exploring', timingDefaulted: true });
  assert.equal(u['Funnel Completed At'], NOW);
  assert.equal('Qualified At' in u, false);
});

test('defaulted flags on a route-eligible submit change nothing', () => {
  const u = base({ tierDefaulted: true, timingDefaulted: true });
  assert.equal(u['Qualified At'], NOW);
  assert.equal(u['Funnel Completed At'], NOW);
});

test('isValidAckConfirmedAt accepts only parseable ISO strings', () => {
  assert.equal(isValidAckConfirmedAt('2026-07-15T11:59:58.000Z'), true);
  assert.equal(isValidAckConfirmedAt('garbage'), false);
  assert.equal(isValidAckConfirmedAt(''), false);
  assert.equal(isValidAckConfirmedAt(null), false);
  assert.equal(isValidAckConfirmedAt(true), false);
});

// ── Raised preference → Interest Beef (REP lead-quality, 2026-08-06) ────────

test('grass_finished writes the grass-fed Interest Beef text', () => {
  const u = base({ raised: 'grass_finished' });
  assert.equal(u['Interest Beef'], 'Grass-fed & grass-finished');
});

test('grain_ok and no_preference write text WITHOUT the word grass (nationwideFit matches /grass/i)', () => {
  for (const raised of ['grain_ok', 'no_preference']) {
    const u = base({ raised });
    assert.ok(u['Interest Beef']);
    assert.ok(!/grass/i.test(u['Interest Beef']), `${raised} mapping must not contain "grass"`);
  }
});

test('skipped/absent/invalid raised never writes Interest Beef (skip must not clear stored values)', () => {
  for (const raised of ['', undefined, 'garbage']) {
    const u = base({ raised });
    assert.equal('Interest Beef' in u, false, `raised=${String(raised)} must not write`);
  }
});
