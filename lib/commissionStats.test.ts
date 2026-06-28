import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeUnpaidCommission } from './commissionStats';

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
