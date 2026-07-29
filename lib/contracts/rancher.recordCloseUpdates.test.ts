// MONEY-TRUTH TAIL (2026-07-01) — finding 2: confirm-payment must close deals
// THROUGH recordClose (capacity DECR, buyer stage flip, funnel event, affiliate
// enrollment), not with its own Airtable writes. recordClose grows an optional
// `extraFields` so confirm-payment's payment-confirmation stamps ride the SAME
// single Referrals write as the close.
//
// buildRecordCloseUpdates is the extracted pure field-builder. Two guardrails
// pinned here:
//   1. BYTE-PRESERVATION — existing callers (no extraFields) produce the exact
//      field set recordClose has always written. Any drift here changes every
//      close path on the platform.
//   2. MERGE ORDER — extraFields land AFTER the base fields, so a caller can
//      override 'Closed At' (confirm-payment preserves a pre-existing close
//      stamp) without recordClose losing its defaults for everyone else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecordCloseUpdates, recordCloseBehavior } from './rancher';

// ── recordCloseBehavior — My Leads (rancher-entered) close semantics ────────
// A 'Referral Source' = 'rancher-added' row closes through the SAME contract
// but: no capacity DECR (never INCR'd), no affiliate/CAPI (no consent, no ad
// attribution), and lost → buyer CLOSED (never READY-restored into the
// routing pool — the buyer belongs to the rancher).

test('recordCloseBehavior: routed rows keep every historical side effect', () => {
  for (const ref of [{}, { 'Referral Source': '' }, { 'Referral Source': 'ads' }, null]) {
    assert.deepEqual(recordCloseBehavior(ref), {
      skipCapacityDecrement: false,
      skipAffiliateAndCapi: false,
      lostBuyerHandling: 'restore',
    });
  }
});

test('recordCloseBehavior: rancher-added rows skip DECR + affiliate/CAPI and close the buyer on lost', () => {
  for (const src of ['rancher-added', { name: 'rancher-added' }]) {
    assert.deepEqual(recordCloseBehavior({ 'Referral Source': src }), {
      skipCapacityDecrement: true,
      skipAffiliateAndCapi: true,
      lostBuyerHandling: 'close',
    });
  }
});

const NOW = '2026-07-01T12:00:00.000Z';

test('byte-preserve: won close without extraFields = the historical field set', () => {
  const updates = buildRecordCloseUpdates(
    { referralId: 'recRef', rancherId: 'recRan', outcome: 'won', saleAmount: 1500 },
    NOW,
  );
  assert.deepEqual(updates, {
    'Status': 'Closed Won',
    'Closed At': NOW,
    'Last Rancher Activity At': NOW,
    'Rancher Engaged Flag': true,
    'Sale Amount': 1500,
  });
});

test('byte-preserve: lost close without extraFields (no Sale Amount)', () => {
  const updates = buildRecordCloseUpdates(
    { referralId: 'recRef', rancherId: 'recRan', outcome: 'lost' },
    NOW,
  );
  assert.deepEqual(updates, {
    'Status': 'Closed Lost',
    'Closed At': NOW,
    'Last Rancher Activity At': NOW,
    'Rancher Engaged Flag': true,
  });
});

test('byte-preserve: awaiting_payment maps to Awaiting Payment, Sale Amount only on won', () => {
  const updates = buildRecordCloseUpdates(
    { referralId: 'recRef', rancherId: 'recRan', outcome: 'awaiting_payment', saleAmount: 900 },
    NOW,
  );
  assert.equal(updates['Status'], 'Awaiting Payment');
  assert.equal('Sale Amount' in updates, false, 'Sale Amount is a won-only field');
});

test('extraFields merge AFTER base — confirm-payment stamps + Closed At override', () => {
  const updates = buildRecordCloseUpdates(
    {
      referralId: 'recRef',
      rancherId: 'recRan',
      outcome: 'won',
      saleAmount: 1500,
      extraFields: {
        'Commission Due': 60,
        'Payment Confirmed At': NOW,
        'Payment Confirmation Method': 'cash',
        // Preserve an earlier close stamp (deal closed once, payment confirmed later)
        'Closed At': '2026-06-28T09:00:00.000Z',
      },
    },
    NOW,
  );
  assert.equal(updates['Closed At'], '2026-06-28T09:00:00.000Z', 'caller override wins');
  assert.equal(updates['Commission Due'], 60);
  assert.equal(updates['Payment Confirmed At'], NOW);
  assert.equal(updates['Payment Confirmation Method'], 'cash');
  // Base fields not overridden stay put.
  assert.equal(updates['Status'], 'Closed Won');
  assert.equal(updates['Sale Amount'], 1500);
  assert.equal(updates['Rancher Engaged Flag'], true);
});

test('empty extraFields object is identical to no extraFields', () => {
  const a = buildRecordCloseUpdates(
    { referralId: 'r', rancherId: 'x', outcome: 'won', saleAmount: 10, extraFields: {} },
    NOW,
  );
  const b = buildRecordCloseUpdates(
    { referralId: 'r', rancherId: 'x', outcome: 'won', saleAmount: 10 },
    NOW,
  );
  assert.deepEqual(a, b);
});
