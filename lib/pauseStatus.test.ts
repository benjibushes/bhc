import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAUSE_TOGGLE_VALUES,
  SELF_SERVE_PAUSE_CURRENT_STATES,
  validatePauseValue,
  validatePauseTransition,
} from './pauseStatus';

// ── Whitelist shape ─────────────────────────────────────────────────────────
// The whole point of this module: a rancher can only ever write EXACTLY
// 'Active' or 'Paused'. If this constant grows, someone is widening the
// self-serve surface — make that a deliberate, reviewed decision.
test('whitelist is exactly Active + Paused', () => {
  assert.deepEqual([...PAUSE_TOGGLE_VALUES], ['Active', 'Paused']);
});

// ── validatePauseValue ──────────────────────────────────────────────────────
test('accepts the two canonical values', () => {
  assert.deepEqual(validatePauseValue('Active'), { ok: true, value: 'Active' });
  assert.deepEqual(validatePauseValue('Paused'), { ok: true, value: 'Paused' });
});

test('normalizes case and whitespace to the canonical value', () => {
  assert.deepEqual(validatePauseValue('paused'), { ok: true, value: 'Paused' });
  assert.deepEqual(validatePauseValue('  ACTIVE  '), { ok: true, value: 'Active' });
});

test('rejects privileged / admin-only statuses', () => {
  for (const v of ['Removed', 'At Capacity', 'Pending', 'Onboarding', 'Live']) {
    const r = validatePauseValue(v);
    assert.equal(r.ok, false, `expected "${v}" to be rejected`);
  }
});

test('rejects arbitrary strings and injection-shaped values', () => {
  for (const v of ['', 'Activee', 'Paused; Removed', 'active-ish', 'DROP TABLE']) {
    assert.equal(validatePauseValue(v).ok, false, `expected "${v}" to be rejected`);
  }
});

test('rejects non-string values', () => {
  for (const v of [null, undefined, 42, true, {}, ['Active'], { name: 'Active' }]) {
    assert.equal(validatePauseValue(v).ok, false, `expected ${JSON.stringify(v)} to be rejected`);
  }
});

test('rejection carries a human error message', () => {
  const r = validatePauseValue('Removed');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /Active.*Paused|Paused.*Active/);
});

// ── validatePauseTransition ─────────────────────────────────────────────────
// A rancher may only self-toggle from an already-live state. This is the guard
// that stops a Removed/Pending rancher from self-ACTIVATING via the whitelist.
test('live states may pause and resume', () => {
  for (const cur of SELF_SERVE_PAUSE_CURRENT_STATES) {
    assert.equal(validatePauseTransition(cur, 'Paused').ok, true, `${cur} -> Paused`);
    assert.equal(validatePauseTransition(cur, 'Active').ok, true, `${cur} -> Active`);
  }
});

test('non-live states cannot self-toggle (no self-activation)', () => {
  for (const cur of ['Removed', 'Pending', 'Onboarding', '', null, undefined]) {
    const toActive = validatePauseTransition(cur, 'Active');
    assert.equal(toActive.ok, false, `${String(cur)} -> Active must be blocked`);
    const toPaused = validatePauseTransition(cur, 'Paused');
    assert.equal(toPaused.ok, false, `${String(cur)} -> Paused must be blocked`);
  }
});

test('transition tolerates Airtable enum-object current values', () => {
  // Airtable singleSelect fields sometimes hydrate as { name: 'Active' }.
  assert.equal(validatePauseTransition({ name: 'Active' }, 'Paused').ok, true);
  assert.equal(validatePauseTransition({ name: 'Removed' }, 'Active').ok, false);
});
