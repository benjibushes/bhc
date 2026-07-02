import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nationwideAllowed,
  normalizeNationwidePreference,
  NATIONWIDE_OK,
  LOCAL_ONLY,
  NATIONWIDE_PREFERENCE_FIELD,
} from './nationwidePreference';

// ── nationwideAllowed: the matching gate ────────────────────────────────────
// Semantics (founder directive, 2026-07-01):
//   'nationwide-ok'      → opted in  → fallback allowed
//   'local-only'         → opted out → fallback BLOCKED (buyer waits local)
//   empty/missing/other  → never asked → fallback allowed (today's behavior,
//                          zero regression for existing buyers)

test('nationwideAllowed: explicit opt-in → allowed', () => {
  assert.equal(nationwideAllowed('nationwide-ok'), true);
});

test('nationwideAllowed: explicit opt-out → blocked', () => {
  assert.equal(nationwideAllowed('local-only'), false);
});

test('nationwideAllowed: undefined (field never set) → allowed', () => {
  assert.equal(nationwideAllowed(undefined), true);
});

test('nationwideAllowed: null → allowed', () => {
  assert.equal(nationwideAllowed(null), true);
});

test('nationwideAllowed: empty string → allowed', () => {
  assert.equal(nationwideAllowed(''), true);
});

test('nationwideAllowed: garbage string → allowed (never blocks by accident)', () => {
  assert.equal(nationwideAllowed('yes please'), true);
  assert.equal(nationwideAllowed('false'), true);
  assert.equal(nationwideAllowed('0'), true);
});

test('nationwideAllowed: non-string garbage → allowed', () => {
  assert.equal(nationwideAllowed(42), true);
  assert.equal(nationwideAllowed(true), true);
  assert.equal(nationwideAllowed(false), true);
  assert.equal(nationwideAllowed([]), true);
  assert.equal(nationwideAllowed({}), true);
});

// Airtable singleSelect fields can arrive as a string OR as an
// {id, name, color} object depending on read path — normalize both
// (same dual-shape handling as tierFor in lib/tiers.ts).
test('nationwideAllowed: Airtable select-object shape', () => {
  assert.equal(nationwideAllowed({ id: 'sel1', name: 'local-only', color: 'red' }), false);
  assert.equal(nationwideAllowed({ id: 'sel2', name: 'nationwide-ok', color: 'green' }), true);
});

test('nationwideAllowed: case/whitespace-insensitive on the block value', () => {
  assert.equal(nationwideAllowed(' LOCAL-ONLY '), false);
  assert.equal(nationwideAllowed('Local-Only'), false);
});

// ── normalizeNationwidePreference ───────────────────────────────────────────

test('normalize: string passthrough, trimmed + lowercased', () => {
  assert.equal(normalizeNationwidePreference(' Nationwide-OK '), 'nationwide-ok');
  assert.equal(normalizeNationwidePreference('local-only'), 'local-only');
});

test('normalize: select object → its name', () => {
  assert.equal(normalizeNationwidePreference({ name: 'nationwide-ok' }), 'nationwide-ok');
});

test('normalize: unset/garbage → empty string', () => {
  assert.equal(normalizeNationwidePreference(undefined), '');
  assert.equal(normalizeNationwidePreference(null), '');
  assert.equal(normalizeNationwidePreference(7), '');
  assert.equal(normalizeNationwidePreference({}), '');
});

// ── constants are load-bearing (written to Airtable + read by the gate) ─────

test('canonical option values + field name', () => {
  assert.equal(NATIONWIDE_OK, 'nationwide-ok');
  assert.equal(LOCAL_ONLY, 'local-only');
  assert.equal(NATIONWIDE_PREFERENCE_FIELD, 'Nationwide Preference');
});
