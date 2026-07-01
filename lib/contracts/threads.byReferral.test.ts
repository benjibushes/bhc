import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadsByReferralFormula, THREADS_REFERRAL_ID_TEXT_FIELD } from './threads';

// Threads-by-referral formula builder — same bug class as Payments G1/E6.
//
// Both Threads-by-referral lookups (thread dedup in getOrCreateThreadForReferral
// and thread-close-on-terminal-close in contracts/rancher.recordClose) used to
// run `SEARCH("<refId>", ARRAYJOIN({Referral}))`. ARRAYJOIN over a link field
// joins the linked records' PRIMARY-FIELD values, and the Referrals primary
// field (`Name`, singleLineText) is empty on every prod row — so the scan NEVER
// matched: duplicate threads per referral (observed live 2026-07-01: two Active
// threads for the same referral), and threads never closed on Closed Won/Lost.
// The fix mirrors payments.ts: denormalize the referral record id into a plain
// `Referral Id Text` field on Threads at creation and exact-match it; the
// legacy formula survives one release as a fallback.
//
// This suite pins the formula builder: exact output shapes, record-id shape
// validation, and the injection guard (a quote inside a refId must never be
// able to break out of the formula string).

const REF = 'recAbCdEf1234567Z9'.slice(0, 17); // rec + 14 chars

test('threads refId shape sanity for this suite', () => {
  assert.match(REF, /^rec[A-Za-z0-9]{14}$/);
});

test('threads fast path: exact-match formula on the denormalized text field', () => {
  assert.equal(
    threadsByReferralFormula(REF),
    `{${THREADS_REFERRAL_ID_TEXT_FIELD}} = "${REF}"`,
  );
});

test('threads legacy path: ARRAYJOIN SEARCH formula (back-compat, pre-field rows)', () => {
  assert.equal(
    threadsByReferralFormula(REF, { legacy: true }),
    `SEARCH("${REF}", ARRAYJOIN({Referral}))`,
  );
});

test('threads field name is the exact agreed schema name (same as Payments)', () => {
  assert.equal(THREADS_REFERRAL_ID_TEXT_FIELD, 'Referral Id Text');
});

test('threads: quote injection cannot break out of the formula (invalid shape → never-match)', () => {
  for (const evil of [
    'rec"1234567890123',
    'recAAAAAAAAAAAAAA", TRUE())',
    '") , {Status}="Active',
    'rec\\"12345678901',
  ]) {
    const f = threadsByReferralFormula(evil);
    assert.equal(f, 'FALSE()', `unsafe id must never-match: ${evil}`);
    const fl = threadsByReferralFormula(evil, { legacy: true });
    assert.equal(fl, 'FALSE()', `unsafe id must never-match (legacy): ${evil}`);
  }
});

test('threads shape validation: non-record-ids are rejected (never-match), valid ids pass', () => {
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
    assert.equal(threadsByReferralFormula(id), 'FALSE()', `must reject: ${JSON.stringify(id)}`);
  }
  const good = ['rec12345678901234', 'recABCDEFGHIJKLMN', 'recabcdefghijklmn', 'rec0aB1cD2eF3gH4i'];
  for (const id of good) {
    assert.equal(threadsByReferralFormula(id), `{${THREADS_REFERRAL_ID_TEXT_FIELD}} = "${id}"`);
  }
});
