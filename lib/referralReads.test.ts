// Dashboard-projection money-truth pins (broker reads wave, 2026-08-18).
//
// THE BUG THIS PINS AGAINST: every rancher-facing Referrals read goes through
// the REFERRAL_DASHBOARD_FIELDS projection in lib/referralReads. The broker
// rail's ONLY row-level discriminator is `Match Type` (see isBrokerReferralRow
// in lib/commission) — and the projection silently STRIPPED it, so every
// broker-aware branch downstream (dashboard net math, phantom-commission
// exclusion, CSV export) received rows on which isBrokerReferralRow was
// structurally ALWAYS false:
//   • a PAID broker deposit row read as tier_v2 → net shown as the FULL sale,
//     overstated by the deposit BHC kept;
//   • an UNPAID hand-closed broker Closed Won read as legacy → phantom
//     "Commission Owed — Invoice pending" contradicting the represented
//     rancher's agreement (deposit-is-the-fee, never invoiced).
//
// These tests simulate Airtable's fields[] projection exactly (only requested
// fields come back) and pin that a broker row REMAINS classifiable + nets
// correctly after projection. Removing 'Match Type' from
// REFERRAL_DASHBOARD_FIELDS makes them fail — that is the point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REFERRAL_DASHBOARD_FIELDS } from './referralReads';
import {
  isBrokerReferralRow,
  referralNetDollars,
  referralRail,
} from './commission';
import { BROKER_MATCH_TYPE } from './brokerRail';

// Airtable fields[] semantics: the response contains ONLY the requested
// fields (that exist on the record). Blank fields are omitted entirely.
function projectLikeAirtable(full: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const f of REFERRAL_DASHBOARD_FIELDS) {
    if (f in full && full[f] !== undefined && full[f] !== '') out[f] = full[f];
  }
  return out;
}

// A PAID broker referral exactly as the rail stamps it: Match Type at
// creation (lib/brokerReferral), Deposit Paid At / Deposit Amount /
// Total Sale Amount / BHC Fee Cents at settle (lib/brokerSettlement — on this
// rail the fee IS the whole deposit), Sale Amount at close.
const PAID_BROKER_ROW = {
  'Match Type': BROKER_MATCH_TYPE,
  'Status': 'Closed Won',
  'Sale Amount': 3000,
  'Total Sale Amount': 3000,
  'Deposit Paid At': '2026-08-10T12:00:00.000Z',
  'Deposit Amount': 500,
  'BHC Fee Cents': 50000,
  'Commission Due': 0,
  'Rancher': ['recRancher1'],
};

// An UNPAID hand-closed broker referral: Match Type stamped at creation, no
// deposit ever paid, Closed Won by hand with a Sale Amount — and a phantom
// Commission Due written by a pre-belt close path.
const UNPAID_BROKER_ROW = {
  'Match Type': BROKER_MATCH_TYPE,
  'Status': 'Closed Won',
  'Sale Amount': 3000,
  'Commission Due': 300,
  'Commission Paid': false,
  'Rancher': ['recRancher1'],
};

test('projection pin: Match Type survives REFERRAL_DASHBOARD_FIELDS — broker row stays classifiable', () => {
  const projected = projectLikeAirtable(PAID_BROKER_ROW);
  assert.equal(isBrokerReferralRow(projected), true);
});

test('projection pin: PAID broker row nets sale − the deposit BHC kept after projection', () => {
  const projected = projectLikeAirtable(PAID_BROKER_ROW);
  // Without 'Match Type' in the projection this row reads tier_v2 (Deposit
  // Paid At present) and nets the FULL sale — overstated by the $500 deposit.
  assert.equal(referralRail(projected), 'tier_v2'); // the trap the belt exists for
  assert.equal(referralNetDollars(projected), 2500);
});

test('projection pin: UNPAID hand-closed broker row nets the FULL sale — phantom Commission Due never subtracted', () => {
  const projected = projectLikeAirtable(UNPAID_BROKER_ROW);
  // Without 'Match Type' this row reads legacy and nets sale − phantom (2700)
  // while ALSO flowing into the "Commission Owed — Invoice pending" sum.
  assert.equal(isBrokerReferralRow(projected), true);
  assert.equal(referralNetDollars(projected), 3000);
});

test('projection keeps the ownership belt + status/money fields (sanity, not the pin)', () => {
  const projected = projectLikeAirtable(PAID_BROKER_ROW);
  assert.deepEqual(projected['Rancher'], ['recRancher1']);
  assert.equal(projected['Status'], 'Closed Won');
  assert.equal(projected['Sale Amount'], 3000);
  assert.equal(projected['BHC Fee Cents'], 50000);
});
