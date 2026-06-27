import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePreferences,
  formatPreferencesMessage,
  preferencesToReferralFields,
  fulfillmentLabel,
  WINDOW_MAX,
  CUT_NOTES_MAX,
} from './preferences';

test('valid pickup with window + cutNotes', () => {
  const r = validatePreferences({ fulfillment: 'pickup', window: 'mid July', cutNotes: 'thick ribeyes' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.value, { fulfillment: 'pickup', window: 'mid July', cutNotes: 'thick ribeyes' });
  }
});

test('valid delivery, case-insensitive + trimmed', () => {
  const r = validatePreferences({ fulfillment: '  Delivery  ' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.fulfillment, 'delivery');
});

test('missing fulfillment rejected', () => {
  const r = validatePreferences({ window: 'soon' });
  assert.equal(r.ok, false);
});

test('invalid fulfillment value rejected', () => {
  const r = validatePreferences({ fulfillment: 'teleport' });
  assert.equal(r.ok, false);
});

test('non-string fulfillment rejected', () => {
  const r = validatePreferences({ fulfillment: 3 });
  assert.equal(r.ok, false);
});

test('optional fields default to empty string', () => {
  const r = validatePreferences({ fulfillment: 'pickup' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.window, '');
    assert.equal(r.value.cutNotes, '');
  }
});

test('window + cutNotes are length-capped', () => {
  const r = validatePreferences({
    fulfillment: 'pickup',
    window: 'x'.repeat(WINDOW_MAX + 50),
    cutNotes: 'y'.repeat(CUT_NOTES_MAX + 500),
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.window.length, WINDOW_MAX);
    assert.equal(r.value.cutNotes.length, CUT_NOTES_MAX);
  }
});

test('non-string optional fields coerced to empty', () => {
  const r = validatePreferences({ fulfillment: 'delivery', window: 123, cutNotes: {} });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.window, '');
    assert.equal(r.value.cutNotes, '');
  }
});

test('fulfillmentLabel maps to title case', () => {
  assert.equal(fulfillmentLabel('pickup'), 'Pickup');
  assert.equal(fulfillmentLabel('delivery'), 'Delivery');
});

test('formatPreferencesMessage includes all three fields + name', () => {
  const msg = formatPreferencesMessage(
    { fulfillment: 'delivery', window: 'after the 20th', cutNotes: 'extra ground' },
    { buyerFirstName: 'Sam' },
  );
  assert.match(msg, /Buyer preferences from Sam:/);
  assert.match(msg, /Fulfillment: Delivery/);
  assert.match(msg, /Target window: after the 20th/);
  assert.match(msg, /Cut notes: extra ground/);
});

test('formatPreferencesMessage falls back gracefully on empties', () => {
  const msg = formatPreferencesMessage({ fulfillment: 'pickup', window: '', cutNotes: '' });
  assert.match(msg, /^Buyer preferences:/);
  assert.match(msg, /Target window: flexible/);
  assert.match(msg, /Cut notes: none yet/);
});

test('preferencesToReferralFields maps to Airtable field names + stamp', () => {
  const iso = '2026-06-27T12:00:00.000Z';
  const fields = preferencesToReferralFields(
    { fulfillment: 'pickup', window: 'July', cutNotes: 'no liver' },
    iso,
  );
  assert.deepEqual(fields, {
    'Buyer Fulfillment Pref': 'Pickup',
    'Buyer Window Pref': 'July',
    'Buyer Cut Notes': 'no liver',
    'Buyer Preferences Set At': iso,
  });
});
