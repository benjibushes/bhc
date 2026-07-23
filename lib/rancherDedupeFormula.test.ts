// lib/rancherDedupeFormula.test.ts
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/rancherDedupeFormula.test.ts
//
// Pins buildRancherDedupeFormula — the filtered replacement (2026-07-23, the
// Justin incident) for findOrCreateRancherByEmail's old UNFILTERED full-table
// scan. The formula MUST be a superset of every JS dedupe tier (email / team /
// phone / ranch+state) so the caller's in-memory narrowing stays behavior-
// equivalent. These lock the field names, the tiers each input turns on, the
// last-4-digit phone superset, escaping, and the null "nothing to match" case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRancherDedupeFormula } from './airtable';

test('email turns on BOTH the exact Email tier and the Team Emails superset', () => {
  const f = buildRancherDedupeFormula({
    normalizedEmail: 'jesse@ranch.com',
    normalizedPhone: '',
  });
  assert.equal(
    f,
    'OR(LOWER(TRIM({Email})) = "jesse@ranch.com", FIND("jesse@ranch.com", LOWER({Team Emails})) > 0)',
  );
});

test('phone tier uses the LAST 4 digits (contiguous in every common US format)', () => {
  const f = buildRancherDedupeFormula({
    normalizedEmail: '',
    normalizedPhone: '4065551234',
  });
  // Single clause → no OR wrapper.
  assert.equal(f, 'FIND("1234", {Phone}) > 0');
});

test('phone shorter than 10 digits is ignored', () => {
  assert.equal(
    buildRancherDedupeFormula({ normalizedEmail: '', normalizedPhone: '5551234' }),
    null,
  );
});

test('ranch+state requires BOTH and matches trim+lower on each', () => {
  const f = buildRancherDedupeFormula({
    normalizedEmail: '',
    normalizedPhone: '',
    ranchName: 'Bar S Ranch',
    state: 'TX',
  });
  assert.equal(
    f,
    'AND(LOWER(TRIM({Ranch Name})) = "bar s ranch", LOWER(TRIM({State})) = "tx")',
  );
});

test('ranch WITHOUT state (or vice versa) does not emit a clause', () => {
  assert.equal(
    buildRancherDedupeFormula({ normalizedEmail: '', normalizedPhone: '', ranchName: 'Bar S' }),
    null,
  );
  assert.equal(
    buildRancherDedupeFormula({ normalizedEmail: '', normalizedPhone: '', state: 'TX' }),
    null,
  );
});

test('all tiers together OR into one formula', () => {
  const f = buildRancherDedupeFormula({
    normalizedEmail: 'a@b.com',
    normalizedPhone: '4065559876',
    ranchName: 'Lazy Bar',
    state: 'MT',
  });
  assert.equal(
    f,
    'OR(LOWER(TRIM({Email})) = "a@b.com", FIND("a@b.com", LOWER({Team Emails})) > 0, ' +
      'FIND("9876", {Phone}) > 0, ' +
      'AND(LOWER(TRIM({Ranch Name})) = "lazy bar", LOWER(TRIM({State})) = "mt"))',
  );
});

test('nothing to match on → null (caller skips the read, goes straight to create)', () => {
  assert.equal(buildRancherDedupeFormula({ normalizedEmail: '', normalizedPhone: '' }), null);
});

test('quotes in the email are escaped so the formula string stays well-formed', () => {
  const f = buildRancherDedupeFormula({
    normalizedEmail: 'we"ird@ranch.com',
    normalizedPhone: '',
  });
  assert.ok(f!.includes('LOWER(TRIM({Email})) = "we\\"ird@ranch.com"'));
});
