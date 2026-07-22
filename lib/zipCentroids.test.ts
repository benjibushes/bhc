// lib/zipCentroids.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeZip, lookupZipCentroid, resolveBuyerCentroid } from './zipCentroids';
import { haversineMiles } from './geoDistance';

// ── normalizeZip ────────────────────────────────────────────────────────────

test('normalizeZip: plain, padded, ZIP+4 and whitespace forms', () => {
  assert.equal(normalizeZip('78701'), '78701');
  assert.equal(normalizeZip('  78701  '), '78701');
  assert.equal(normalizeZip('78701-1234'), '78701');
  assert.equal(normalizeZip('787011234'), '78701');
  assert.equal(normalizeZip('78701 1234'), '78701');
});

test('normalizeZip: a numeric ZIP keeps its leading zeros', () => {
  // Airtable/JSON can hand us 1001 for "01001". Without the pad, every ZIP in
  // New England and Puerto Rico would silently miss the table.
  assert.equal(normalizeZip(1001), '01001');
  assert.equal(normalizeZip(78701), '78701');
});

test('normalizeZip: null for blank, short, long and non-numeric input', () => {
  assert.equal(normalizeZip(undefined), null);
  assert.equal(normalizeZip(null), null);
  assert.equal(normalizeZip(''), null);
  assert.equal(normalizeZip('   '), null);
  assert.equal(normalizeZip('787'), null);
  assert.equal(normalizeZip('7870A'), null);
  assert.equal(normalizeZip('K1A 0B1'), null, 'Canadian postal code');
});

// ── lookupZipCentroid ───────────────────────────────────────────────────────

test('lookupZipCentroid: known ZIPs land within a mile of their published centroid', () => {
  const austin = lookupZipCentroid('78701');
  assert.ok(austin, 'expected 78701 in the table');
  assert.equal(austin.state, 'TX');
  assert.ok(haversineMiles(austin.lat, austin.lng, 30.271, -97.743) < 1);

  const beverlyHills = lookupZipCentroid('90210');
  assert.ok(beverlyHills, 'expected 90210 in the table');
  assert.equal(beverlyHills.state, 'CA');
  assert.ok(haversineMiles(beverlyHills.lat, beverlyHills.lng, 34.09, -118.406) < 1);

  // Aurora NE — Champion Valley Farm's own ZIP, the live routing case.
  const aurora = lookupZipCentroid('68818');
  assert.ok(aurora, 'expected 68818 in the table');
  assert.equal(aurora.state, 'NE');
});

test('lookupZipCentroid: leading-zero ZIPs resolve', () => {
  const chicopee = lookupZipCentroid('01001');
  assert.ok(chicopee, 'expected 01001 in the table');
  assert.equal(chicopee.state, 'MA');
});

test('lookupZipCentroid: null for unknown / malformed ZIPs', () => {
  assert.equal(lookupZipCentroid('00000'), null);
  assert.equal(lookupZipCentroid('99999'), null);
  assert.equal(lookupZipCentroid('abcde'), null);
  assert.equal(lookupZipCentroid(''), null);
});

test('lookupZipCentroid: the table covers the whole country, not one region', () => {
  for (const [zip, state] of [
    ['99501', 'AK'], ['96813', 'HI'], ['33101', 'FL'], ['04988', 'ME'],
    ['59001', 'MT'], ['24966', 'WV'], ['65068', 'MO'], ['97759', 'OR'],
  ] as const) {
    const hit = lookupZipCentroid(zip);
    assert.ok(hit, `expected ${zip} in the table`);
    assert.equal(hit.state, state, `${zip} should be ${state}`);
  }
});

// ── resolveBuyerCentroid: the state cross-check ─────────────────────────────

test('resolveBuyerCentroid: resolves when the ZIP agrees with the routing state', () => {
  const hit = resolveBuyerCentroid('78701', 'TX');
  assert.ok(hit);
  assert.equal(hit.state, 'TX');
});

test('resolveBuyerCentroid: accepts a spelled-out state name', () => {
  // Consumers.State is free text — normalizeState handles "Texas" → "TX".
  const hit = resolveBuyerCentroid('78701', 'Texas');
  assert.ok(hit);
});

test('resolveBuyerCentroid: null when the ZIP belongs to another state', () => {
  // A typo'd or out-of-state ZIP must never move the buyer's location — the
  // caller falls back to the state-hop sort.
  assert.equal(resolveBuyerCentroid('90210', 'TX'), null);
});

test('resolveBuyerCentroid: null when ZIP or state is missing', () => {
  assert.equal(resolveBuyerCentroid('', 'TX'), null);
  assert.equal(resolveBuyerCentroid(null, 'TX'), null);
  assert.equal(resolveBuyerCentroid('78701', ''), null);
  assert.equal(resolveBuyerCentroid('78701', 'ZZ'), null);
});
