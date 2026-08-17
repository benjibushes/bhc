// Public rancher-page visibility formula (rancherOrProspectBySlugFormula —
// the filterByFormula getRancherOrProspectBySlug sends to Airtable).
//
// Pins the BROKER SELF-SERVE relaxation (2026-08-17): the blanket broker
// exclusion became OR(NOT broker, self-serve), and the Page Live OR gained
// AND(broker, self-serve) — a self-serve broker ranch is page-live by
// definition of the opt-in (the launch ranch has Page Live unset), while a
// stray self-serve tick on a NON-broker ranch publishes nothing. Same
// exact-string convention as lib/airtableReadPath.test.ts /
// lib/cronReadFilters.test.ts: field names must be real and long-standing — a
// typo'd field errors the whole query, which on this read = every rancher
// page 404s.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rancherOrProspectBySlugFormula } from './airtable';

test('exact formula string — visibility gates + the broker self-serve relaxation', () => {
  assert.equal(
    rancherOrProspectBySlugFormula('granite-hollow-beef'),
    'AND({Slug} = "granite-hollow-beef", NOT({Public Map Hidden} = 1), ' +
      '{Verification Status} != "Removed", ' +
      'OR(NOT({Broker Rail} = 1), {Broker Self Serve} = 1), ' +
      'OR({Page Live} = 1, {Verification Status} = "Prospect", ' +
      'AND({Broker Rail} = 1, {Broker Self Serve} = 1)))',
  );
});

test('the broker exclusion is the relaxed OR, not the old blanket NOT', () => {
  const formula = rancherOrProspectBySlugFormula('any-ranch');
  assert.ok(
    formula.includes('OR(NOT({Broker Rail} = 1), {Broker Self Serve} = 1)'),
    'must admit a self-serve broker ranch',
  );
  // The old standalone exclusion (…, NOT({Broker Rail} = 1), OR({Page Live}…)
  // must be gone — it survives only as the first arm INSIDE the new OR.
  assert.ok(
    !formula.includes('NOT({Broker Rail} = 1), OR({Page Live} = 1'),
    'blanket broker exclusion must not survive alongside the relaxation',
  );
});

test('page-live clause admits ONLY a broker+self-serve ranch without Page Live', () => {
  const formula = rancherOrProspectBySlugFormula('any-ranch');
  assert.ok(
    formula.includes(
      'OR({Page Live} = 1, {Verification Status} = "Prospect", ' +
        'AND({Broker Rail} = 1, {Broker Self Serve} = 1))',
    ),
    'self-serve alone (non-broker) must NOT count as page-live — fail closed',
  );
});

test('hard gates survive unconditionally (hidden / removed stay unreachable)', () => {
  const formula = rancherOrProspectBySlugFormula('any-ranch');
  assert.ok(formula.includes('NOT({Public Map Hidden} = 1)'));
  assert.ok(formula.includes('{Verification Status} != "Removed"'));
});

test('slug is escaped (injection guard, same as every sibling builder)', () => {
  assert.ok(
    rancherOrProspectBySlugFormula('x"\\y').startsWith('AND({Slug} = "x\\"\\\\y", '),
  );
});
