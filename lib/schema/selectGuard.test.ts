import test from 'node:test';
import assert from 'node:assert';
import {
  guardSelectWrites,
  isSchemaGuardStrict,
  SchemaGuardError,
} from './selectGuard';

// ── The core invariant ───────────────────────────────────────────────────
// "A value that is not a legitimate option can never silently become one."

test('a legitimate option passes through untouched', () => {
  const r = guardSelectWrites('Referrals', { Status: 'Closed Lost', Notes: 'hi' });
  assert.deepEqual(r.fields, { Status: 'Closed Lost', Notes: 'hi' });
  assert.equal(r.violations.length, 0);
});

test('a value that is NOT an option is dropped, never sent', () => {
  const r = guardSelectWrites('Referrals', { Status: 'Lost', Notes: 'keep me' });
  assert.equal('Status' in r.fields, false, 'the minting value must never reach Airtable');
  assert.equal(r.fields.Notes, 'keep me', 'sibling fields still land');
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].table, 'Referrals');
  assert.equal(r.violations[0].field, 'Status');
  assert.equal(r.violations[0].value, 'Lost');
});

test("empty string on a select CLEARS the field instead of minting an '' choice", () => {
  const r = guardSelectWrites('Ranchers', { 'Onboarding Status': '' });
  assert.equal(r.fields['Onboarding Status'], null);
  assert.equal(r.violations.length, 0);
  assert.deepEqual(r.normalizedToNull, ['Onboarding Status']);
});

test("even when '' IS already a choice, we clear rather than re-select it", () => {
  // Ranchers.Stripe Connect Status carries a real '' choice — residue of the
  // very bug this guard exists to stop. Writing null is the honest clear.
  const r = guardSelectWrites('Ranchers', { 'Stripe Connect Status': '' });
  assert.equal(r.fields['Stripe Connect Status'], null);
});

test('null / undefined are explicit clears and pass through', () => {
  const r = guardSelectWrites('Referrals', { Status: null });
  assert.equal(r.fields.Status, null);
  assert.equal(r.violations.length, 0);
});

test('non-select fields are never touched', () => {
  const r = guardSelectWrites('Referrals', { 'Sale Amount': 0, 'Notes': '', 'Deposit Paid At': null });
  assert.deepEqual(r.fields, { 'Sale Amount': 0, 'Notes': '', 'Deposit Paid At': null });
  assert.equal(r.violations.length, 0);
});

test('an unknown table is passed through untouched (the guard does not guess)', () => {
  const r = guardSelectWrites('Not A Real Table', { Status: 'Whatever' });
  assert.deepEqual(r.fields, { Status: 'Whatever' });
  assert.equal(r.violations.length, 0);
  assert.equal(r.unknownTable, true);
});

test('an unknown FIELD is passed through — field names are the static guard + strip handler beat', () => {
  const r = guardSelectWrites('Referrals', { 'Totally Invented Field': 'x' });
  assert.deepEqual(r.fields, { 'Totally Invented Field': 'x' });
  assert.equal(r.violations.length, 0);
});

// ── multipleSelects ──────────────────────────────────────────────────────

test('multipleSelects: every member must be a real option', () => {
  const r = guardSelectWrites('Consumers', { Interests: ['Beef'] });
  assert.deepEqual(r.fields.Interests, ['Beef']);
  assert.equal(r.violations.length, 0);
});

test('multipleSelects: one bad member drops the WHOLE key (never half-write a set)', () => {
  const r = guardSelectWrites('Consumers', { Interests: ['Beef', 'Unicorn Meat'] });
  assert.equal('Interests' in r.fields, false);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].value, 'Unicorn Meat');
});

test('multipleSelects: empty array is a legitimate clear', () => {
  const r = guardSelectWrites('Consumers', { Interests: [] });
  assert.deepEqual(r.fields.Interests, []);
  assert.equal(r.violations.length, 0);
});

// ── non-string values ────────────────────────────────────────────────────

test('a number written to a select is compared as a string, not waved through', () => {
  const r = guardSelectWrites('Referrals', { Status: 42 as any });
  assert.equal('Status' in r.fields, false);
  assert.equal(r.violations[0].value, '42');
});

// ── the allowlist ────────────────────────────────────────────────────────

test('an allowlisted value is STILL dropped — the allowlist silences the alarm, not the guard', () => {
  // Payments.Status 'requires_webhook_replay' ships allowlisted on day one.
  const r = guardSelectWrites('Payments', { Status: 'requires_webhook_replay' });
  assert.equal('Status' in r.fields, false, 'allowlisted must never mean "mint it"');
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].allowlisted, true);
});

test('a non-allowlisted violation is not marked allowlisted', () => {
  const r = guardSelectWrites('Payments', { Status: 'brand_new_never_seen' });
  assert.equal(r.violations[0].allowlisted, false);
});

// ── strictness resolution ────────────────────────────────────────────────

test('strict by default outside production; explicit env wins both ways', () => {
  const prevStrict = process.env.SCHEMA_GUARD_STRICT;
  const prevNode = process.env.NODE_ENV;
  try {
    delete process.env.SCHEMA_GUARD_STRICT;
    (process.env as any).NODE_ENV = 'development';
    assert.equal(isSchemaGuardStrict(), true, 'dev/test fail loud');

    (process.env as any).NODE_ENV = 'production';
    assert.equal(isSchemaGuardStrict(), false, 'prod degrades — never throw mid-transaction');

    process.env.SCHEMA_GUARD_STRICT = '1';
    assert.equal(isSchemaGuardStrict(), true, 'explicit on');

    process.env.SCHEMA_GUARD_STRICT = '0';
    (process.env as any).NODE_ENV = 'development';
    assert.equal(isSchemaGuardStrict(), false, 'explicit off');
  } finally {
    if (prevStrict === undefined) delete process.env.SCHEMA_GUARD_STRICT;
    else process.env.SCHEMA_GUARD_STRICT = prevStrict;
    (process.env as any).NODE_ENV = prevNode;
  }
});

test('SchemaGuardError names table.field and the offending value', () => {
  const e = new SchemaGuardError([
    { table: 'Referrals', field: 'Status', value: 'Lost', kind: 'singleSelect', allowlisted: false },
  ]);
  assert.match(e.message, /Referrals\.Status/);
  assert.match(e.message, /Lost/);
});

// ── purity ───────────────────────────────────────────────────────────────

test('the caller payload is never mutated in place', () => {
  const input = { Status: 'Lost', Notes: 'x' };
  guardSelectWrites('Referrals', input);
  assert.deepEqual(input, { Status: 'Lost', Notes: 'x' });
});

// ── the decision the write path actually consumes ────────────────────────

import { decideSelectGuardAction } from './selectGuard';

const withEnv = (strict: boolean, fn: () => void) => {
  const prev = process.env.SCHEMA_GUARD_STRICT;
  process.env.SCHEMA_GUARD_STRICT = strict ? '1' : '0';
  try { fn(); } finally {
    if (prev === undefined) delete process.env.SCHEMA_GUARD_STRICT;
    else process.env.SCHEMA_GUARD_STRICT = prev;
  }
};

test('strict: an un-parked violation tells the caller to throw', () => {
  withEnv(true, () => {
    const a = decideSelectGuardAction('Referrals', { Status: 'Lost' }, 'update');
    assert.equal(a.shouldThrow, true);
    assert.equal('Status' in a.fields, false);
  });
});

test('strict: a PARKED violation never throws — it is already on the list', () => {
  withEnv(true, () => {
    const a = decideSelectGuardAction('Payments', { Status: 'requires_webhook_replay' }, 'update');
    assert.equal(a.shouldThrow, false);
    assert.equal('Status' in a.fields, false);
  });
});

test('lenient: never throws, always drops, always alerts', () => {
  withEnv(false, () => {
    const a = decideSelectGuardAction('Referrals', { Status: 'Lost', Notes: 'n' }, 'update');
    assert.equal(a.shouldThrow, false);
    assert.deepEqual(a.fields, { Notes: 'n' });
    assert.equal(a.alerts.length, 1);
    assert.match(a.alerts[0].summary, /Referrals\.Status/);
    assert.match(a.alerts[0].detail, /Lost/);
    assert.match(a.alerts[0].dedupeKey, /Referrals/);
  });
});

test('a clean payload produces no alerts and no throw', () => {
  withEnv(true, () => {
    const a = decideSelectGuardAction('Referrals', { Status: 'Dormant' }, 'update');
    assert.equal(a.shouldThrow, false);
    assert.equal(a.alerts.length, 0);
    assert.deepEqual(a.fields, { Status: 'Dormant' });
  });
});

test("normalising '' to null is silent — it is a fix, not an incident", () => {
  withEnv(true, () => {
    const a = decideSelectGuardAction('Ranchers', { 'Onboarding Status': '' }, 'update');
    assert.equal(a.shouldThrow, false);
    assert.equal(a.alerts.length, 0);
    assert.equal(a.fields['Onboarding Status'], null);
  });
});

test('the alert dedupe key separates create from update and value from value', () => {
  withEnv(false, () => {
    const c = decideSelectGuardAction('Referrals', { Status: 'Lost' }, 'create');
    const u = decideSelectGuardAction('Referrals', { Status: 'Lost' }, 'update');
    const other = decideSelectGuardAction('Referrals', { Status: 'Nope' }, 'update');
    assert.notEqual(c.alerts[0].dedupeKey, u.alerts[0].dedupeKey);
    assert.notEqual(u.alerts[0].dedupeKey, other.alerts[0].dedupeKey);
  });
});

test('the break-glass env turns the whole guard into a no-op', () => {
  const prev = process.env.SCHEMA_GUARD_OFF;
  process.env.SCHEMA_GUARD_OFF = '1';
  try {
    const a = decideSelectGuardAction('Referrals', { Status: 'Lost' }, 'update');
    assert.deepEqual(a.fields, { Status: 'Lost' });
    assert.equal(a.shouldThrow, false);
    assert.equal(a.alerts.length, 0);
  } finally {
    if (prev === undefined) delete process.env.SCHEMA_GUARD_OFF;
    else process.env.SCHEMA_GUARD_OFF = prev;
  }
});
