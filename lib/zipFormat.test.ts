// lib/zipFormat.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeZip } from './zipFormat';

test('normalizeZip: plain, padded, ZIP+4 and whitespace forms', () => {
  assert.equal(normalizeZip('78701'), '78701');
  assert.equal(normalizeZip('  78701  '), '78701');
  assert.equal(normalizeZip('78701-1234'), '78701');
  assert.equal(normalizeZip('787011234'), '78701');
  assert.equal(normalizeZip('78701 1234'), '78701');
});

test('normalizeZip: a numeric ZIP keeps its leading zeros', () => {
  assert.equal(normalizeZip(1001), '01001');
  assert.equal(normalizeZip(78701), '78701');
});

test('normalizeZip: null for everything that is not a US ZIP', () => {
  // The signup path writes `Zip` ONLY when this returns non-null, so each of
  // these must produce a blank field rather than junk that never resolves.
  for (const bad of [undefined, null, '', '   ', '787', '7870', '7870A', 'K1A 0B1', '00', 'abcde', {}, []]) {
    assert.equal(normalizeZip(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('normalizeZip: is the exact gate the consumers route relies on', () => {
  // A skipped ZIP must be indistinguishable from no ZIP at all — this is what
  // keeps the funnel's optional field from ever blocking or dirtying a signup.
  assert.equal(normalizeZip(''), null);
  assert.equal(normalizeZip(undefined), null);
});
