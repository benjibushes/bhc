// Read-path optimization helpers (audit slice 9 — dashboard full-scan kill).
//
// Pins the two things that MUST NOT drift:
//   1. The filterByFormula strings sent to Airtable (escaping + exact field
//      names — 'Rancher Record Id' / 'Suggested Rancher Record Id' are the
//      lookup fields the founder creates manually; 'Buyer Email' is the
//      long-standing Referrals email field).
//   2. The error classifiers that route the graceful fallback. Airtable's
//      INVALID_FILTER_BY_FORMULA message ("...Unknown field names: x") and
//      UNKNOWN_FIELD_NAME message ('Unknown field name: "X"') overlap
//      textually — misclassifying one as the other would either fire the
//      operator signal on a projection miss or full-scan on a projection
//      miss. These tests pin the disambiguation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  referralsByRancherFormula,
  referralsByBuyerEmailFormula,
  isInvalidFilterFormulaError,
  isUnknownFieldNameError,
} from './airtable';

// ── referralsByRancherFormula ───────────────────────────────────────────

test('referralsByRancherFormula matches both the Rancher and Suggested Rancher lookups', () => {
  assert.equal(
    referralsByRancherFormula('rec123AbC456dEf78'),
    'OR({Rancher Record Id} = "rec123AbC456dEf78", {Suggested Rancher Record Id} = "rec123AbC456dEf78")',
  );
});

test('referralsByRancherFormula escapes quotes and backslashes (injection guard)', () => {
  // Record ids never contain these, but the builder must never be the hole.
  assert.equal(
    referralsByRancherFormula('rec"\\x'),
    'OR({Rancher Record Id} = "rec\\"\\\\x", {Suggested Rancher Record Id} = "rec\\"\\\\x")',
  );
});

// ── referralsByBuyerEmailFormula ────────────────────────────────────────

test('referralsByBuyerEmailFormula builds the exact + wrapped-address OR match, lowercased', () => {
  // Mirrors findReferralByBuyerEmail: exact bare match OR exact match inside
  // a "Name <addr>" wrapper — never a bare substring (ben@x vs rueben@x).
  assert.equal(
    referralsByBuyerEmailFormula('  Ben@Example.COM '),
    'OR(LOWER(TRIM({Buyer Email})) = "ben@example.com", FIND("<ben@example.com>", LOWER({Buyer Email})) > 0)',
  );
});

test('referralsByBuyerEmailFormula strips quotes so the formula cannot be broken out of', () => {
  assert.equal(
    referralsByBuyerEmailFormula('a"b@x.com'),
    'OR(LOWER(TRIM({Buyer Email})) = "ab@x.com", FIND("<ab@x.com>", LOWER({Buyer Email})) > 0)',
  );
});

test('referralsByBuyerEmailFormula returns null for empty / non-email input', () => {
  assert.equal(referralsByBuyerEmailFormula(''), null);
  assert.equal(referralsByBuyerEmailFormula('   '), null);
  assert.equal(referralsByBuyerEmailFormula('not-an-email'), null);
  assert.equal(referralsByBuyerEmailFormula(undefined as any), null);
});

// ── error classifiers ───────────────────────────────────────────────────

// Shapes mirror what airtable.js throws (AirtableError: .error = type code,
// .message, .statusCode).
const formulaErr = {
  error: 'INVALID_FILTER_BY_FORMULA',
  message: 'The formula for filtering records is invalid: Unknown field names: rancher record id',
  statusCode: 422,
};
const unknownFieldErr = {
  error: 'UNKNOWN_FIELD_NAME',
  message: 'Unknown field name: "Fulfillment Status"',
  statusCode: 422,
};

test('isInvalidFilterFormulaError matches the missing-lookup formula error', () => {
  assert.equal(isInvalidFilterFormulaError(formulaErr), true);
  // Message-only fallback (type code missing, e.g. rewrapped error).
  assert.equal(
    isInvalidFilterFormulaError({ message: formulaErr.message }),
    true,
  );
});

test('isInvalidFilterFormulaError does NOT match projection or unrelated errors', () => {
  assert.equal(isInvalidFilterFormulaError(unknownFieldErr), false);
  assert.equal(isInvalidFilterFormulaError(new Error('connect ETIMEDOUT')), false);
  assert.equal(isInvalidFilterFormulaError(null), false);
});

test('isUnknownFieldNameError matches the fields[] projection error', () => {
  assert.equal(isUnknownFieldNameError(unknownFieldErr), true);
  // Message-only fallback — the quote after the colon disambiguates from the
  // formula error's plural "Unknown field names: ...".
  assert.equal(
    isUnknownFieldNameError({ message: 'Unknown field name: "Foo"' }),
    true,
  );
});

test('isUnknownFieldNameError does NOT match the formula error (plural "names") or unrelated errors', () => {
  assert.equal(isUnknownFieldNameError(formulaErr), false);
  assert.equal(isUnknownFieldNameError(new Error('rate limit')), false);
  assert.equal(isUnknownFieldNameError(undefined), false);
});
