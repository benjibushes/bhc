import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeUnpaidCommission,
  computeLegacyCommissionEarned,
  computeConnectFeeCaptured,
  countConnectFeePayments,
  legacyClosedWon,
} from './commissionStats';

test('sums Commission Due across all Closed Won referrals that are not paid', () => {
  const refs = [
    { Status: 'Closed Won', 'Commission Due': 100, 'Commission Paid': false },
    { Status: 'Closed Won', 'Commission Due': 50, 'Commission Paid': true },
    { Status: 'Closed Won', 'Commission Due': 25 }, // Commission Paid absent => unpaid
  ];
  assert.equal(computeUnpaidCommission(refs), 125);
});

test('ignores non-Closed-Won referrals entirely', () => {
  const refs = [
    { Status: 'Pending Approval', 'Commission Due': 999 },
    { Status: 'Closed Lost', 'Commission Due': 999 },
    { Status: 'Intro Sent', 'Commission Due': 999 },
    { Status: 'Closed Won', 'Commission Due': 40, 'Commission Paid': false },
  ];
  assert.equal(computeUnpaidCommission(refs), 40);
});

test('is all-time, not month-scoped — old unpaid closes still count', () => {
  // No date filtering at all: a close from any month contributes.
  const refs = [
    { Status: 'Closed Won', 'Commission Due': 200, 'Commission Paid': false },
    { Status: 'Closed Won', 'Commission Due': 300, 'Commission Paid': false },
  ];
  assert.equal(computeUnpaidCommission(refs), 500);
});

test('coerces null/undefined/string Commission Due to numbers safely', () => {
  const refs = [
    { Status: 'Closed Won', 'Commission Due': null, 'Commission Paid': false },
    { Status: 'Closed Won', 'Commission Due': undefined, 'Commission Paid': false },
    { Status: 'Closed Won', 'Commission Due': '75.5', 'Commission Paid': false },
  ];
  assert.equal(computeUnpaidCommission(refs), 75.5);
});

test('only Commission Paid === true (strict) is treated as paid', () => {
  // Truthy-but-not-true values must NOT be treated as paid.
  const refs = [
    { Status: 'Closed Won', 'Commission Due': 10, 'Commission Paid': null },
    { Status: 'Closed Won', 'Commission Due': 10, 'Commission Paid': false },
    { Status: 'Closed Won', 'Commission Due': 10, 'Commission Paid': true },
  ] as any[];
  assert.equal(computeUnpaidCommission(refs), 20);
});

test('rounds to cents', () => {
  const refs = [
    { Status: 'Closed Won', 'Commission Due': 0.1, 'Commission Paid': false },
    { Status: 'Closed Won', 'Commission Due': 0.2, 'Commission Paid': false },
  ];
  assert.equal(computeUnpaidCommission(refs), 0.3);
});

// ── RAIL AWARENESS (money-model truth, 2026-07-24) ───────────────────────────
// `Commission Due` is a LEGACY-rail artifact. A Connect-rail close (Deposit
// Paid At stamped) already had its 10% taken at deposit via application_fee —
// counting it as a receivable makes /admin disagree with the rancher dashboard
// about the same deal.

test('excludes Connect-rail (Deposit Paid At stamped) closes from unpaid commission', () => {
  const refs = [
    { Status: 'Closed Won', 'Commission Due': 100, 'Commission Paid': false },
    {
      Status: 'Closed Won',
      'Commission Due': 999,
      'Commission Paid': false,
      'Deposit Paid At': '2026-07-19T03:31:00.631Z',
    },
  ];
  assert.equal(computeUnpaidCommission(refs), 100);
});

test('an empty / whitespace Deposit Paid At is still the legacy rail', () => {
  // Airtable empties arrive as '', null or undefined — none of them mean
  // "a deposit was paid". Mirrors referralRail's own tolerance.
  const refs = [
    { Status: 'Closed Won', 'Commission Due': 10, 'Deposit Paid At': '' },
    { Status: 'Closed Won', 'Commission Due': 10, 'Deposit Paid At': null },
    { Status: 'Closed Won', 'Commission Due': 10, 'Deposit Paid At': '   ' },
    { Status: 'Closed Won', 'Commission Due': 10 },
  ];
  assert.equal(computeUnpaidCommission(refs), 40);
});

test('legacyClosedWon partitions a mixed referral set by rail, not by rancher', () => {
  const refs = [
    { Status: 'Closed Won', 'Commission Due': 1 },
    { Status: 'Closed Won', 'Commission Due': 2, 'Deposit Paid At': '2026-07-19T00:00:00Z' },
    { Status: 'Closed Lost', 'Commission Due': 3 },
    { Status: 'Intro Sent', 'Commission Due': 4 },
    { Status: 'Closed Won', 'Commission Due': 5 },
  ];
  assert.deepEqual(
    legacyClosedWon(refs).map((r) => r['Commission Due']),
    [1, 5],
  );
});

test('computeLegacyCommissionEarned counts paid + unpaid, legacy rail only', () => {
  const refs = [
    { Status: 'Closed Won', 'Commission Due': 100, 'Commission Paid': true },
    { Status: 'Closed Won', 'Commission Due': 50, 'Commission Paid': false },
    {
      Status: 'Closed Won',
      'Commission Due': 999,
      'Commission Paid': true,
      'Deposit Paid At': '2026-07-19T00:00:00Z',
    },
    { Status: 'Closed Lost', 'Commission Due': 999 },
  ];
  assert.equal(computeLegacyCommissionEarned(refs), 150);
});

// ── CONNECT-RAIL FEE (Payments.Platform Fee Cents) ───────────────────────────

test('computeConnectFeeCaptured sums Platform Fee Cents on succeeded rows only', () => {
  const payments = [
    { Status: 'succeeded', 'Platform Fee Cents': 15315 },
    { Status: 'succeeded', 'Platform Fee Cents': 29990 },
    { Status: 'abandoned', 'Platform Fee Cents': 19500 },
    { Status: 'pending', 'Platform Fee Cents': 5000 },
    { Status: 'refunded', 'Platform Fee Cents': 7000 },
    { Status: 'failed', 'Platform Fee Cents': 1000 },
    { Status: 'requires_webhook_replay', 'Platform Fee Cents': 1000 },
  ];
  // 15315 + 29990 = 45305 cents
  assert.equal(computeConnectFeeCaptured(payments), 453.05);
});

test('computeConnectFeeCaptured tolerates Airtable empties and string numbers', () => {
  const payments = [
    { Status: 'succeeded', 'Platform Fee Cents': null },
    { Status: 'succeeded', 'Platform Fee Cents': undefined },
    { Status: 'succeeded' },
    { Status: 'succeeded', 'Platform Fee Cents': '12345' },
    { 'Platform Fee Cents': 9999 }, // no Status at all => never counted
  ];
  assert.equal(computeConnectFeeCaptured(payments), 123.45);
});

test('computeConnectFeeCaptured is 0 (never null/NaN) on an empty table', () => {
  assert.equal(computeConnectFeeCaptured([]), 0);
});

test('countConnectFeePayments counts only succeeded rows with a non-zero fee', () => {
  const payments = [
    { Status: 'succeeded', 'Platform Fee Cents': 15315 },
    { Status: 'succeeded', 'Platform Fee Cents': 0 },
    { Status: 'succeeded' },
    { Status: 'abandoned', 'Platform Fee Cents': 19500 },
  ];
  assert.equal(countConnectFeePayments(payments), 1);
});
