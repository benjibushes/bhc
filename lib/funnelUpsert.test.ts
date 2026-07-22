// lib/funnelUpsert.test.ts
// Runner: npm test (tsx --test 'lib/**/*.test.ts')

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardFunnelUpsertFields } from './funnelUpsert';

const FIELDS = {
  'Full Name': 'Jane Buyer',
  'Buyer Stage': 'WAITING',
  'Buyer Stage Updated At': '2026-07-22T12:00:00.000Z',
  'Status': 'Approved',
  'Created': '2026-07-22',
  'Approved At': '2026-07-22T12:00:00.000Z',
  'Source': 'funnel',
};

test('new record (no existing) → fields pass through untouched', () => {
  assert.deepEqual(guardFunnelUpsertFields(FIELDS, null), FIELDS);
  assert.deepEqual(guardFunnelUpsertFields(FIELDS, undefined), FIELDS);
});

test('existing MATCHED buyer → stage write dropped (never downgrade)', () => {
  const out = guardFunnelUpsertFields(FIELDS, { 'Buyer Stage': 'MATCHED' });
  assert.equal('Buyer Stage' in out, false);
  assert.equal('Buyer Stage Updated At' in out, false);
  // Non-stage fields untouched.
  assert.equal(out['Full Name'], 'Jane Buyer');
});

test('existing CLOSED buyer → stage write dropped', () => {
  const out = guardFunnelUpsertFields(FIELDS, { 'Buyer Stage': 'CLOSED' });
  assert.equal('Buyer Stage' in out, false);
});

test('existing READY buyer → stage write dropped', () => {
  const out = guardFunnelUpsertFields(FIELDS, { 'Buyer Stage': 'READY' });
  assert.equal('Buyer Stage' in out, false);
});

test('blank/NEW/WAITING stages keep the WAITING write (not a downgrade)', () => {
  for (const stage of ['', 'NEW', 'WAITING']) {
    const out = guardFunnelUpsertFields(FIELDS, { 'Buyer Stage': stage });
    assert.equal(out['Buyer Stage'], 'WAITING', `stage=${JSON.stringify(stage)}`);
    assert.equal(out['Buyer Stage Updated At'], FIELDS['Buyer Stage Updated At']);
  }
});

test('Created / Approved At / Source never stomped when already set', () => {
  const out = guardFunnelUpsertFields(FIELDS, {
    'Buyer Stage': 'WAITING',
    'Created': '2026-02-01',
    'Approved At': '2026-02-01T09:00:00.000Z',
    'Source': 'meta-ads',
  });
  assert.equal('Created' in out, false);
  assert.equal('Approved At' in out, false);
  assert.equal('Source' in out, false);
});

test('Created / Approved At / Source written when existing values are blank', () => {
  const out = guardFunnelUpsertFields(FIELDS, { 'Buyer Stage': 'WAITING', 'Source': '' });
  assert.equal(out['Created'], '2026-07-22');
  assert.equal(out['Approved At'], '2026-07-22T12:00:00.000Z');
  assert.equal(out['Source'], 'funnel');
});

test('input fields object is not mutated', () => {
  const copy = { ...FIELDS };
  guardFunnelUpsertFields(FIELDS, { 'Buyer Stage': 'MATCHED', 'Source': 'x' });
  assert.deepEqual(FIELDS, copy);
});
