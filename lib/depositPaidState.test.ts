// lib/depositPaidState.test.ts — decision table for the deposit-page re-pay
// guard. The load-bearing case is REQUESTED-BUT-UNPAID → payable (the
// 2026-07-14 bricked-buyer bug: Status was flipped to 'Awaiting Payment' at
// request time and the old guard read that as "already paid").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDepositAlreadyPaid } from './depositPaidState';

test('paid: Deposit Paid At set (authoritative regardless of status)', () => {
  assert.equal(
    isDepositAlreadyPaid({ Status: 'Awaiting Payment', 'Deposit Paid At': '2026-07-01T00:00:00Z' }),
    true,
  );
  assert.equal(
    isDepositAlreadyPaid({ Status: 'Intro Sent', 'Deposit Paid At': '2026-07-01T00:00:00Z' }),
    true,
  );
});

test('paid: Slot Locked (post-accept — accept gates on Deposit Paid At)', () => {
  assert.equal(isDepositAlreadyPaid({ Status: 'Slot Locked' }), true);
});

test('PAYABLE: requested-but-unpaid under Awaiting Payment (the bricked-buyer bug)', () => {
  assert.equal(
    isDepositAlreadyPaid({
      Status: 'Awaiting Payment',
      'Deposit Requested At': '2026-07-02T22:14:04Z',
      'Deposit Paid At': undefined,
    }),
    false,
  );
});

test('paid: Awaiting Payment with NO request stamp (legacy settle-row redundancy)', () => {
  assert.equal(isDepositAlreadyPaid({ Status: 'Awaiting Payment' }), true);
  assert.equal(isDepositAlreadyPaid({ Status: 'Awaiting Payment', 'Deposit Requested At': '' }), true);
});

test('not paid: pre-deposit statuses + empty inputs', () => {
  assert.equal(isDepositAlreadyPaid({ Status: 'Intro Sent' }), false);
  assert.equal(isDepositAlreadyPaid({ Status: 'READY' }), false);
  assert.equal(
    isDepositAlreadyPaid({ Status: 'Negotiation', 'Deposit Requested At': '2026-07-01T00:00:00Z' }),
    false,
  );
  assert.equal(isDepositAlreadyPaid({}), false);
  assert.equal(isDepositAlreadyPaid(null), false);
  assert.equal(isDepositAlreadyPaid(undefined), false);
});

test('whitespace-only stamps are treated as empty', () => {
  assert.equal(
    isDepositAlreadyPaid({
      Status: 'Awaiting Payment',
      'Deposit Requested At': '2026-07-02T22:14:04Z',
      'Deposit Paid At': '  ',
    }),
    false,
  );
});
