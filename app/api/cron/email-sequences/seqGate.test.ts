import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeqGate, SEQ_KEYS, SEQ_DEFAULT_ON } from './route';

// ─── default behavior (EMAIL_SEQUENCES_ALLOW unset) ──────────────────────────
// Only the high-ROI buyer sequences should fire; everything else stays dark.

test('unset allowlist enables exactly the high-ROI default set', () => {
  const gate = buildSeqGate(undefined);
  // The four revived buyer sequences are ON.
  assert.equal(gate(SEQ_KEYS.abandonedRecovery), true);
  assert.equal(gate(SEQ_KEYS.incompleteProfile), true);
  assert.equal(gate(SEQ_KEYS.closedRepeat), true);
  assert.equal(gate(SEQ_KEYS.warmLeadCheck), true);
  // Everything else stays dark.
  assert.equal(gate(SEQ_KEYS.waitingLetters), false);
  assert.equal(gate(SEQ_KEYS.readyNudge), false);
  assert.equal(gate(SEQ_KEYS.matchedD4), false);
  assert.equal(gate(SEQ_KEYS.closedCuts), false);
  assert.equal(gate(SEQ_KEYS.closedMonthly), false);
  assert.equal(gate(SEQ_KEYS.matchNow), false);
  assert.equal(gate(SEQ_KEYS.nudgeToEngage), false);
  assert.equal(gate(SEQ_KEYS.noBudgetFounderPitch), false);
  assert.equal(gate(SEQ_KEYS.stateWaitlist), false);
  assert.equal(gate(SEQ_KEYS.rancherDocsReminder), false);
});

test('empty / whitespace allowlist falls back to the default set', () => {
  for (const raw of ['', '   ', '\n']) {
    const gate = buildSeqGate(raw);
    assert.equal(gate(SEQ_KEYS.closedRepeat), true, `"${raw}" → default on`);
    assert.equal(gate(SEQ_KEYS.waitingLetters), false, `"${raw}" → default off`);
  }
});

test('default set has exactly the four revived buyer sequences', () => {
  assert.equal(SEQ_DEFAULT_ON.size, 4);
  assert.ok(SEQ_DEFAULT_ON.has(SEQ_KEYS.abandonedRecovery));
  assert.ok(SEQ_DEFAULT_ON.has(SEQ_KEYS.incompleteProfile));
  assert.ok(SEQ_DEFAULT_ON.has(SEQ_KEYS.closedRepeat));
  assert.ok(SEQ_DEFAULT_ON.has(SEQ_KEYS.warmLeadCheck));
});

// ─── wildcard ("*") → full legacy engine ─────────────────────────────────────

test('wildcard enables every sequence', () => {
  const gate = buildSeqGate('*');
  for (const key of Object.values(SEQ_KEYS)) {
    assert.equal(gate(key), true, `${key} should be on under "*"`);
  }
  // Even an unknown key is on under wildcard (predicate is unconditional).
  assert.equal(gate('something_new'), true);
});

test('wildcard tolerates surrounding whitespace', () => {
  const gate = buildSeqGate('  *  ');
  assert.equal(gate(SEQ_KEYS.waitingLetters), true);
});

// ─── explicit comma-separated allowlist ──────────────────────────────────────

test('explicit list enables only the named keys', () => {
  const gate = buildSeqGate('closed_repeat,warm_lead_check');
  assert.equal(gate(SEQ_KEYS.closedRepeat), true);
  assert.equal(gate(SEQ_KEYS.warmLeadCheck), true);
  // A default-on key NOT in the explicit list is now OFF — explicit overrides default.
  assert.equal(gate(SEQ_KEYS.abandonedRecovery), false);
  assert.equal(gate(SEQ_KEYS.incompleteProfile), false);
});

test('explicit list normalizes case and whitespace, ignores empties', () => {
  const gate = buildSeqGate(' Closed_Repeat , , WARM_LEAD_CHECK ,');
  assert.equal(gate(SEQ_KEYS.closedRepeat), true);
  assert.equal(gate(SEQ_KEYS.warmLeadCheck), true);
  assert.equal(gate(SEQ_KEYS.abandonedRecovery), false);
});

test('unknown key in explicit list does not enable real ones', () => {
  const gate = buildSeqGate('bogus_key');
  for (const key of Object.values(SEQ_KEYS)) {
    assert.equal(gate(key), false, `${key} should stay off`);
  }
});
