import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveSalesMetrics,
  isReferralSale,
  referralSaleValue,
} from './salesMetrics';

// THE B4 defect class: a Closed Won referral that (like every funnel deal)
// also has 'Deposit Paid At' must be ONE sale with its money counted ONCE.
// The live route summed it in referralRevenue/-Commission AND added the
// Closed Won slice again at response time — revenue/commission ~doubled the
// moment the first funnel deal closed.
test('a deposit-paid referral that closes is one sale, counted once', () => {
  const referral = {
    'Deposit Paid At': '2026-06-20T15:00:00.000Z',
    'Status': 'Closed Won',
    'Sale Amount': 2400,
    'Commission Due': 240,
  };
  const m = deriveSalesMetrics([], [referral], 10);

  assert.equal(m.depositsPaid, 1);
  assert.equal(m.salesClosed, 1);
  assert.equal(m.referralSales, 1);
  assert.equal(m.totalSales, 1);
  // NOT 4800 / 480 — the double-count the dashboard used to show.
  assert.equal(m.totalRevenue, 2400);
  assert.equal(m.totalCommission, 240);
});

test('deposit paid but not yet closed: depositsPaid counts it, salesClosed does not', () => {
  const referral = {
    'Deposit Paid At': '2026-06-28T09:00:00.000Z',
    'Status': 'Awaiting Fulfillment',
    'Total Sale Amount': 1900,
    'Commission Due': 190,
  };
  const m = deriveSalesMetrics([], [referral], 10);

  assert.equal(m.depositsPaid, 1);
  assert.equal(m.salesClosed, 0);
  assert.equal(m.totalSales, 1); // money landed = a real sale for the headline
  assert.equal(m.totalRevenue, 1900);
  assert.equal(m.totalCommission, 190);
});

test('open referrals are not sales', () => {
  const open = { 'Status': 'Awaiting Payment', 'Deposit Amount': 500 };
  assert.equal(isReferralSale(open), false);
  const m = deriveSalesMetrics([], [open], 10);
  assert.equal(m.totalSales, 0);
  assert.equal(m.totalRevenue, 0);
});

test('legacy Inquiries sales stay visible and count into the totals', () => {
  const inquiry = {
    'Status': 'Sale Completed',
    'Sale Amount': '1800', // Airtable strings must parse
    'Commission Amount': '180',
  };
  const referral = {
    'Deposit Paid At': '2026-06-25T12:00:00.000Z',
    'Status': 'Closed Won',
    'Total Sale Amount': 2000,
    'Commission Due': 200,
  };
  const m = deriveSalesMetrics([inquiry, { 'Status': 'Pending' }], [referral], 20);

  assert.equal(m.legacyInquirySales, 1);
  assert.equal(m.legacyInquiryRevenue, 1800);
  assert.equal(m.legacyInquiryCommission, 180);
  assert.equal(m.totalSales, 2);
  assert.equal(m.totalRevenue, 3800);
  assert.equal(m.totalCommission, 380);
});

test('conversion = sales per consumer lead, zero-safe', () => {
  const referral = { 'Deposit Paid At': '2026-06-25T12:00:00.000Z', 'Status': 'Matched' };
  assert.equal(deriveSalesMetrics([], [referral], 4).conversionRate, 0.25);
  assert.equal(deriveSalesMetrics([], [referral], 0).conversionRate, 0);
  assert.equal(deriveSalesMetrics([], [], 50).conversionRate, 0);
});

test('referral sale value coalesces Total Sale Amount → Sale Amount → Deposit Amount', () => {
  assert.equal(referralSaleValue({ 'Total Sale Amount': 2500, 'Sale Amount': 99, 'Deposit Amount': 1 }), 2500);
  assert.equal(referralSaleValue({ 'Sale Amount': 2200, 'Deposit Amount': 500 }), 2200);
  assert.equal(referralSaleValue({ 'Deposit Amount': 500 }), 500);
  assert.equal(referralSaleValue({}), 0);
  // garbage in → 0, never NaN into the founder's revenue number
  assert.equal(referralSaleValue({ 'Total Sale Amount': 'not-a-number' }), 0);
});
