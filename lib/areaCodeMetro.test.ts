// lib/areaCodeMetro.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { areaCodeOf, metroFromPhone, HOUSTON_AREA_CODES, AUSTIN_AREA_CODES } from './areaCodeMetro';

// ── areaCodeOf ──────────────────────────────────────────────────────────────

test('areaCodeOf: extracts from common US formats', () => {
  assert.equal(areaCodeOf('(713) 555-1234'), '713');
  assert.equal(areaCodeOf('713-555-1234'), '713');
  assert.equal(areaCodeOf('7135551234'), '713');
  assert.equal(areaCodeOf('+1 713 555 1234'), '713');
  assert.equal(areaCodeOf('1-713-555-1234'), '713');
});

test('areaCodeOf: null for junk / too short / missing', () => {
  assert.equal(areaCodeOf(''), null);
  assert.equal(areaCodeOf(null), null);
  assert.equal(areaCodeOf(undefined), null);
  assert.equal(areaCodeOf('555'), null);
  assert.equal(areaCodeOf('abcdefghij'), null);
});

test('areaCodeOf: 11-digit non-1 country prefix is not treated as US', () => {
  // 44 20 7946 0000 → 12 digits, not a US 10/11-digit number.
  assert.equal(areaCodeOf('+44 20 7946 0000'), null);
});

// ── metroFromPhone ──────────────────────────────────────────────────────────

test('metroFromPhone: Houston area codes → houston', () => {
  for (const ac of HOUSTON_AREA_CODES) {
    assert.equal(metroFromPhone(`${ac}5551234`), 'houston', `${ac} should be houston`);
  }
});

test('metroFromPhone: Austin/Central area codes → austin', () => {
  for (const ac of AUSTIN_AREA_CODES) {
    assert.equal(metroFromPhone(`${ac}5551234`), 'austin', `${ac} should be austin`);
  }
});

test('metroFromPhone: a non-TX-metro area code → null', () => {
  assert.equal(metroFromPhone('(212) 555-1234'), null); // NYC
  assert.equal(metroFromPhone('3105551234'), null); // LA
});

test('metroFromPhone: unparseable phone → null (never misclassify)', () => {
  assert.equal(metroFromPhone(''), null);
  assert.equal(metroFromPhone(null), null);
  assert.equal(metroFromPhone('not a phone'), null);
});

test('metroFromPhone: the two sets are disjoint', () => {
  const austin: readonly string[] = AUSTIN_AREA_CODES;
  const overlap = HOUSTON_AREA_CODES.filter((c) => austin.includes(c));
  assert.deepEqual(overlap, []);
});
