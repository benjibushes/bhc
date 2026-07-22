import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOSS_REASON_CHOICES,
  isLossReasonChoice,
  isExcludingLossReason,
  lossReasonFromCloseReason,
  lossReasonFromPassReason,
  lossReasonFromQuickAction,
} from './lossReasons';

// The prod singleSelect choices, byte-for-byte (typecast:false writes throw
// on any drift — this test is the tripwire before Airtable is).
test('choice strings are pinned exactly', () => {
  assert.deepEqual(
    [...LOSS_REASON_CHOICES],
    [
      'Price too high',
      'Timing — buying later',
      "Couldn't reach buyer",
      'Bought elsewhere',
      'Out of service area',
      'Wrong intent (not a buyer)',
      'Other',
    ],
  );
});

test('isLossReasonChoice accepts every pinned choice and nothing else', () => {
  for (const c of LOSS_REASON_CHOICES) assert.equal(isLossReasonChoice(c), true);
  assert.equal(isLossReasonChoice('Price'), false);
  assert.equal(isLossReasonChoice(''), false);
  assert.equal(isLossReasonChoice(undefined), false);
});

// ── Dashboard Mark Lost modal (closeReason codes) ───────────────────────────
test('closeReason: new modal codes map to their choices', () => {
  assert.equal(lossReasonFromCloseReason('no_response'), "Couldn't reach buyer");
  assert.equal(lossReasonFromCloseReason('price'), 'Price too high');
  assert.equal(lossReasonFromCloseReason('timing'), 'Timing — buying later');
  assert.equal(lossReasonFromCloseReason('bought_elsewhere'), 'Bought elsewhere');
  assert.equal(lossReasonFromCloseReason('wrong_intent'), 'Wrong intent (not a buyer)');
  assert.equal(lossReasonFromCloseReason('other'), 'Other');
});

test('closeReason: legacy not_a_fit still maps (pre-deploy dashboard tab)', () => {
  assert.equal(lossReasonFromCloseReason('not_a_fit'), 'Other');
});

test('closeReason: unknown / absent writes nothing', () => {
  assert.equal(lossReasonFromCloseReason('banana'), null);
  assert.equal(lossReasonFromCloseReason(''), null);
  assert.equal(lossReasonFromCloseReason(undefined), null);
});

// ── Dashboard pass rail (passReason codes) ──────────────────────────────────
test('passReason: buyer-outcome codes map to their choices', () => {
  assert.equal(lossReasonFromPassReason('no_response'), "Couldn't reach buyer");
  assert.equal(lossReasonFromPassReason('out_of_area'), 'Out of service area');
});

test('passReason: rancher-situation codes land in Other (Notes keep the label)', () => {
  assert.equal(lossReasonFromPassReason('at_capacity'), 'Other');
  assert.equal(lossReasonFromPassReason('not_a_fit'), 'Other');
});

test('passReason: unknown / absent writes nothing', () => {
  assert.equal(lossReasonFromPassReason('nope'), null);
  assert.equal(lossReasonFromPassReason(undefined), null);
});

// ── Email quick-action lost form ────────────────────────────────────────────
test('quick-action: new form submits exact choice strings (identity)', () => {
  for (const c of LOSS_REASON_CHOICES) {
    assert.equal(lossReasonFromQuickAction(c), c);
  }
});

test('quick-action: legacy option values from pre-deploy forms still map', () => {
  assert.equal(lossReasonFromQuickAction('No response'), "Couldn't reach buyer");
  assert.equal(lossReasonFromQuickAction('Price'), 'Price too high');
  assert.equal(lossReasonFromQuickAction('Timing'), 'Timing — buying later');
  assert.equal(lossReasonFromQuickAction('Out of area'), 'Out of service area');
  assert.equal(lossReasonFromQuickAction('At capacity'), 'Other');
});

test('quick-action: unknown / absent writes nothing', () => {
  assert.equal(lossReasonFromQuickAction('Rancher passed via email link'), null);
  assert.equal(lossReasonFromQuickAction(''), null);
  assert.equal(lossReasonFromQuickAction(undefined), null);
});

// ── Matching pairing-exclusion scope ────────────────────────────────────────
test('isExcludingLossReason: genuine rancher pass/decline reasons exclude', () => {
  assert.equal(isExcludingLossReason('Out of service area'), true);
  assert.equal(isExcludingLossReason('Wrong intent (not a buyer)'), true);
  assert.equal(isExcludingLossReason('Other'), true);
});

test('isExcludingLossReason: buyer-side outcomes stay eligible for re-pairing', () => {
  assert.equal(isExcludingLossReason('Price too high'), false);
  assert.equal(isExcludingLossReason('Timing — buying later'), false);
  assert.equal(isExcludingLossReason("Couldn't reach buyer"), false);
  assert.equal(isExcludingLossReason('Bought elsewhere'), false);
});

test('isExcludingLossReason: cron-noise rows (no/unknown reason) never exclude', () => {
  assert.equal(isExcludingLossReason(undefined), false);
  assert.equal(isExcludingLossReason(null), false);
  assert.equal(isExcludingLossReason(''), false);
  assert.equal(isExcludingLossReason('stale-expiry auto-close'), false);
});

test('isExcludingLossReason: tolerates the Airtable {name} singleSelect shape', () => {
  assert.equal(isExcludingLossReason({ name: 'Out of service area' }), true);
  assert.equal(isExcludingLossReason({ name: 'Price too high' }), false);
  assert.equal(isExcludingLossReason({ name: 'garbage' }), false);
});
