import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentsByReferralFormula, REFERRAL_ID_TEXT_FIELD } from './payments';

// Payments-by-referral formula builder — G1/E6 (referral-id denorm).
//
// Every Payments-by-referral lookup used to run
// `SEARCH("<refId>", ARRAYJOIN({Referral}))` — an unindexable full-table scan
// that is ALSO semantically dead: ARRAYJOIN over a link field joins the linked
// records' PRIMARY-FIELD values, and the Referrals primary field (`Name`,
// singleLineText) is never written by code, so ARRAYJOIN({Referral}) emits ""
// and SEARCH(recId, "") never matches. The fix denormalizes the referral
// record id into a plain `Referral Id Text` field on Payments and queries that
// with an exact match; the legacy formula survives one release as a fallback.
//
// This suite pins the formula builder: exact output shapes, record-id shape
// validation, and the injection guard (a quote inside a refId must never be
// able to break out of the formula string).

const REF = 'recAbCdEf1234567Z9'.slice(0, 17); // rec + 14 chars

test('refId shape sanity for this suite', () => {
  assert.match(REF, /^rec[A-Za-z0-9]{14}$/);
});

test('fast path: exact-match formula on the denormalized text field', () => {
  assert.equal(
    paymentsByReferralFormula(REF),
    `{${REFERRAL_ID_TEXT_FIELD}} = "${REF}"`,
  );
});

test('legacy path: ARRAYJOIN SEARCH formula (back-compat, pre-field rows)', () => {
  assert.equal(
    paymentsByReferralFormula(REF, { legacy: true }),
    `SEARCH("${REF}", ARRAYJOIN({Referral}))`,
  );
});

test('field name is the exact agreed schema name', () => {
  assert.equal(REFERRAL_ID_TEXT_FIELD, 'Referral Id Text');
});

test('quote injection cannot break out of the formula (invalid shape → never-match)', () => {
  // A refId is always rec[A-Za-z0-9]{14}; anything else (including anything
  // containing a quote) must yield a formula that can never match a row —
  // NOT an interpolated string that lets `", TRUE())` style payloads escape.
  for (const evil of [
    'rec"1234567890123',
    'recAAAAAAAAAAAAAA", TRUE())',
    '") , {Status}="pending',
    'rec\\"12345678901',
  ]) {
    const f = paymentsByReferralFormula(evil);
    assert.equal(f, 'FALSE()', `unsafe id must never-match: ${evil}`);
    const fl = paymentsByReferralFormula(evil, { legacy: true });
    assert.equal(fl, 'FALSE()', `unsafe id must never-match (legacy): ${evil}`);
  }
});

test('shape validation: non-record-ids are rejected (never-match), valid ids pass', () => {
  const bad = [
    '',                       // empty
    'rec',                    // too short
    'recAbCdEf1234567',       // 13 chars after rec
    'recAbCdEf123456789',     // 15 chars after rec
    'recAbCdEf123456!',       // non-alphanumeric
    'REC12345678901234',      // wrong case prefix
    'xxx12345678901234',      // wrong prefix
    ' rec12345678901234',     // leading space
    'rec12345678901234 ',     // trailing space
  ];
  for (const id of bad) {
    assert.equal(paymentsByReferralFormula(id), 'FALSE()', `must reject: ${JSON.stringify(id)}`);
  }
  const good = ['rec12345678901234', 'recABCDEFGHIJKLMN', 'recabcdefghijklmn', 'rec0aB1cD2eF3gH4i'];
  for (const id of good) {
    assert.equal(paymentsByReferralFormula(id), `{${REFERRAL_ID_TEXT_FIELD}} = "${id}"`);
  }
});
