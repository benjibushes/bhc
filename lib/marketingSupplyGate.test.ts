// lib/marketingSupplyGate.test.ts
//
// P2′ (MARKETING-REVAMP-2026-08 §5, Track 1) — supply gates for the two
// actually-ungated marketing senders. These tests PIN the policy:
//   - nurture-drip: 'national' lane never gets share-pressure nurture;
//     'customer' lane belongs to the replenishment rail; 'share-ready'
//     passes through BYTE-IDENTICAL to the pre-gate behavior.
//   - matching/suggest GUARD-2b: still_looking_reconfirm is never sent to a
//     buyer whose state has NO operational rancher (capacity-OUT definition);
//     served + unknown states behave exactly as before.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  nurtureLaneGate,
  reconfirmAllowedForState,
} from './marketingSupplyGate';

const served = new Set(['MT', 'TX']);

// ── nurture-drip lane gate ──────────────────────────────────────────────────

test('national-lane consumer is skipped by nurture-drip (stored segment)', () => {
  for (const seg of [
    'STATE_WAITLIST',
    'NO_BUDGET_FOUNDER_PITCH',
    'COMMUNITY_NURTURE',
    'UNQUALIFIED_NURTURE',
  ]) {
    const d = nurtureLaneGate({ routingSegment: seg, state: 'MT', servedStates: served });
    assert.deepEqual(d, { send: false, reason: 'national' }, seg);
  }
});

test('customer-lane consumer (TERMINAL) is skipped — replenishment rail owns them', () => {
  const d = nurtureLaneGate({ routingSegment: 'TERMINAL', state: 'MT', servedStates: served });
  assert.deepEqual(d, { send: false, reason: 'customer' });
});

test('share-ready consumer passes through identically, regardless of state', () => {
  for (const seg of ['MATCH_NOW', 'WARM_LEAD', 'NUDGE_TO_ENGAGE', 'INCOMPLETE_PROFILE']) {
    // Served state
    assert.deepEqual(
      nurtureLaneGate({ routingSegment: seg, state: 'TX', servedStates: served }),
      { send: true },
      seg,
    );
    // Stored segment wins over a stale state read — nightly reclassify owns
    // segment truth; the drip must not second-guess it.
    assert.deepEqual(
      nurtureLaneGate({ routingSegment: seg, state: 'WY', servedStates: served }),
      { send: true },
      `${seg} (state not in served set)`,
    );
  }
});

test('blank-segment consumer with unserved state is skipped (state fallback)', () => {
  const d = nurtureLaneGate({ routingSegment: '', state: 'WY', servedStates: served });
  assert.deepEqual(d, { send: false, reason: 'national' });
  // Full state names normalize before the check.
  const d2 = nurtureLaneGate({ routingSegment: undefined, state: 'Wyoming', servedStates: served });
  assert.deepEqual(d2, { send: false, reason: 'national' });
});

test('blank-segment consumer with served or unknown state passes (pre-gate behavior)', () => {
  assert.deepEqual(
    nurtureLaneGate({ routingSegment: '', state: 'MT', servedStates: served }),
    { send: true },
  );
  // No state at all → cannot prove unserved → fail open (byte-identical to
  // the pre-P2′ drip, which never looked at supply).
  assert.deepEqual(
    nurtureLaneGate({ routingSegment: '', state: '', servedStates: served }),
    { send: true },
  );
  assert.deepEqual(
    nurtureLaneGate({ routingSegment: '', state: 'not-a-state', servedStates: served }),
    { send: true },
  );
});

test('Airtable enum-object segment values ({name}) are read like strings', () => {
  assert.deepEqual(
    nurtureLaneGate({ routingSegment: { name: 'STATE_WAITLIST' }, state: 'TX', servedStates: served }),
    { send: false, reason: 'national' },
  );
  assert.deepEqual(
    nurtureLaneGate({ routingSegment: { name: 'MATCH_NOW' }, state: 'TX', servedStates: served }),
    { send: true },
  );
});

test('unknown non-empty segment fails safe to national (laneForSegment parity)', () => {
  const d = nurtureLaneGate({ routingSegment: 'SOMETHING_NEW', state: 'MT', servedStates: served });
  assert.deepEqual(d, { send: false, reason: 'national' });
});

// ── matching/suggest GUARD-2b still-looking gate ────────────────────────────

test('still-looking reconfirm is blocked for an unserved state', () => {
  assert.equal(reconfirmAllowedForState('WY', served), false);
  assert.equal(reconfirmAllowedForState('Wyoming', served), false);
});

test('still-looking reconfirm is untouched for served states', () => {
  assert.equal(reconfirmAllowedForState('MT', served), true);
  assert.equal(reconfirmAllowedForState('texas', served), true);
});

test('still-looking reconfirm fails open on unknown/blank state (pre-gate behavior)', () => {
  assert.equal(reconfirmAllowedForState('', served), true);
  assert.equal(reconfirmAllowedForState(undefined, served), true);
  assert.equal(reconfirmAllowedForState('??', served), true);
});
