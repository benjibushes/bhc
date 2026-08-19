import test from 'node:test';
import assert from 'node:assert';
import {
  SCHEMA_GUARD_ALLOWLIST,
  isFieldAllowlisted,
  isOptionAllowlisted,
} from './schemaGuardAllowlist';
import { AIRTABLE_SELECT_FIELDS, AIRTABLE_TABLE_FIELDS } from './airtableSchema.generated';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// The whole point of the allowlist is that it CANNOT become a silent skip.
// These tests are the enforcement.

test('every entry carries a real reason', () => {
  for (const e of SCHEMA_GUARD_ALLOWLIST) {
    const label = `${e.table}.${e.field}${e.value ? ` = ${e.value}` : ''}`;
    assert.ok(e.reason && e.reason.trim().length >= 40, `${label}: reason must explain, not label (got ${JSON.stringify(e.reason)})`);
  }
});

test('every entry carries addedOn and expiresOn as real YYYY-MM-DD dates', () => {
  for (const e of SCHEMA_GUARD_ALLOWLIST) {
    const label = `${e.table}.${e.field}${e.value ? ` = ${e.value}` : ''}`;
    assert.match(e.addedOn, ISO_DAY, `${label}: addedOn must be YYYY-MM-DD`);
    assert.match(e.expiresOn, ISO_DAY, `${label}: expiresOn must be YYYY-MM-DD`);
    assert.ok(!Number.isNaN(Date.parse(e.addedOn)), `${label}: addedOn is not a real date`);
    assert.ok(!Number.isNaN(Date.parse(e.expiresOn)), `${label}: expiresOn is not a real date`);
    assert.ok(Date.parse(e.expiresOn) > Date.parse(e.addedOn), `${label}: expiresOn must be after addedOn`);
  }
});

test('no duplicate entries', () => {
  const seen = new Set<string>();
  for (const e of SCHEMA_GUARD_ALLOWLIST) {
    const k = `${e.table}|${e.field}|${e.value ?? ''}`;
    assert.equal(seen.has(k), false, `duplicate allowlist entry: ${k}`);
    seen.add(k);
  }
});

test('every entry names a table that actually exists in the snapshot', () => {
  for (const e of SCHEMA_GUARD_ALLOWLIST) {
    assert.ok(AIRTABLE_TABLE_FIELDS[e.table], `${e.table}: not a table in the snapshot — typo?`);
  }
});

test('an option entry must name a field that exists and a value that does NOT', () => {
  for (const e of SCHEMA_GUARD_ALLOWLIST) {
    // `value: ''` is a real option entry (the empty-named-choice class), so
    // this must test for undefined, not falsiness.
    if (e.value === undefined) continue;
    const spec = AIRTABLE_SELECT_FIELDS[e.table]?.[e.field];
    assert.ok(spec, `${e.table}.${e.field}: parked as a missing OPTION but it is not a select field in the snapshot`);
    // '' is special: it may literally BE a choice (four fields in this base
    // carry one, minted by exactly the writes this guard exists to stop), and
    // it is still never a legitimate thing to write.
    if (e.value === '') continue;
    assert.equal(
      spec!.choices.includes(e.value),
      false,
      `${e.table}.${e.field} = ${e.value}: the option EXISTS now. Delete this allowlist entry.`,
    );
  }
});

test('a field entry must name a field that does NOT exist', () => {
  for (const e of SCHEMA_GUARD_ALLOWLIST) {
    if (e.value !== undefined) continue;
    assert.equal(
      (AIRTABLE_TABLE_FIELDS[e.table] || []).includes(e.field),
      false,
      `${e.table}.${e.field}: the field EXISTS now. Delete this allowlist entry.`,
    );
  }
});

test('lookups distinguish an option entry from a field entry', () => {
  assert.equal(isOptionAllowlisted('Payments', 'Status', 'requires_webhook_replay'), true);
  assert.equal(isOptionAllowlisted('Payments', 'Status', 'not_parked'), false);
  // An option entry must NOT also allowlist the whole field.
  assert.equal(isFieldAllowlisted('Payments', 'Status'), false);
});
