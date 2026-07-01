import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadsByRancherFormula, THREADS_RANCHER_ID_TEXT_FIELD } from './threads';

// Threads-by-rancher formula builder — same bug class as the by-referral
// lookups (and Payments G1/E6).
//
// The rancher inbox (app/api/rancher/inbox) used to run
// `SEARCH("<rancherId>", ARRAYJOIN({Rancher}))`. ARRAYJOIN over a link field
// joins the linked records' PRIMARY-FIELD values — for Ranchers that's the
// Ranch Name, never the record id — so the scan NEVER matched and the rancher
// inbox has listed zero threads since it shipped.
//
// The fix mirrors the by-referral denorm: createThread writes the rancher
// record id into a plain `Rancher Id Text` field on Threads, and the inbox
// exact-matches it. Unlike by-referral there is NO legacy formula variant —
// the old scan could never match a record id, so there is nothing it can
// back-compat to; the fallback for pre-field rows is a full Threads scan with
// a JS filter on the {Rancher} link array (real record ids), which lives in
// listThreadsForRancher, not in the formula builder.
//
// This suite pins the formula builder: exact output shape, the agreed schema
// field name, record-id shape validation, and the injection guard (a quote
// inside a rancherId must never be able to break out of the formula string).

const RANCHER = 'recRaNcHeR12345Zz'.slice(0, 17); // rec + 14 chars

test('threads byRancher: rancherId shape sanity for this suite', () => {
  assert.match(RANCHER, /^rec[A-Za-z0-9]{14}$/);
});

test('threads byRancher fast path: exact-match formula on the denormalized text field', () => {
  assert.equal(
    threadsByRancherFormula(RANCHER),
    `{${THREADS_RANCHER_ID_TEXT_FIELD}} = "${RANCHER}"`,
  );
});

test('threads byRancher field name is the exact agreed schema name', () => {
  assert.equal(THREADS_RANCHER_ID_TEXT_FIELD, 'Rancher Id Text');
});

test('threads byRancher: quote injection cannot break out of the formula (invalid shape → never-match)', () => {
  for (const evil of [
    'rec"1234567890123',
    'recAAAAAAAAAAAAAA", TRUE())',
    '") , {Status}="Active',
    'rec\\"12345678901',
  ]) {
    const f = threadsByRancherFormula(evil);
    assert.equal(f, 'FALSE()', `unsafe id must never-match: ${evil}`);
  }
});

test('threads byRancher shape validation: non-record-ids are rejected (never-match), valid ids pass', () => {
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
    assert.equal(threadsByRancherFormula(id), 'FALSE()', `must reject: ${JSON.stringify(id)}`);
  }
  const good = ['rec12345678901234', 'recABCDEFGHIJKLMN', 'recabcdefghijklmn', 'rec0aB1cD2eF3gH4i'];
  for (const id of good) {
    assert.equal(threadsByRancherFormula(id), `{${THREADS_RANCHER_ID_TEXT_FIELD}} = "${id}"`);
  }
});
