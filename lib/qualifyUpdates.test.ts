// lib/qualifyUpdates.test.ts
// Runner: npm test (tsx --test 'lib/**/*.test.ts')

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQualifyConsumerUpdates,
  isExplicitlyNotReady,
  isValidAckConfirmedAt,
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

test('isValidAckConfirmedAt accepts only parseable ISO strings', () => {
  assert.equal(isValidAckConfirmedAt('2026-07-15T11:59:58.000Z'), true);
  assert.equal(isValidAckConfirmedAt('garbage'), false);
  assert.equal(isValidAckConfirmedAt(''), false);
  assert.equal(isValidAckConfirmedAt(null), false);
  assert.equal(isValidAckConfirmedAt(true), false);
});
