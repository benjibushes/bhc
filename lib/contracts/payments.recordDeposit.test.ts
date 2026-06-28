import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReusablePaymentRow } from './payments';

// recordDeposit dedup correctness — money-loss regression guards (PR #131).
//
// selectReusablePaymentRow is the pure decision recordDeposit uses to choose
// whether to reuse/re-stamp an existing pending Payments row or create a new
// one. It must reuse ONLY a Status==='pending' row whose Stripe Payment Intent
// Id is EXACTLY the live PI. Two regressions guarded:
//   1. A pending row for the SAME referral but a DIFFERENT PI must NOT be
//      reused — re-stamping it overwrites old→new PI and orphans the older PI
//      (completing the older Stripe session settles with no Payments row →
//      silent orphan deposit). A new row must be created instead (null here).
//   2. A 'requires_webhook_replay' row must NEVER be reused — that flag means a
//      SUCCEEDED PI never settled (real money awaiting manual replay); recycling
//      it would mask an unreconciled charge.

const PI = 'pi_NEW';

test('exact PI match on a pending row → reuse that row', () => {
  const rows = [{ id: 'recPay1', Status: 'pending', 'Stripe Payment Intent Id': 'pi_NEW' }];
  const reusable = selectReusablePaymentRow(rows, PI);
  assert.equal(reusable?.id, 'recPay1');
});

test('different PI, same referral, pending row → no reuse (create a NEW row)', () => {
  // An in-flight pending row for the same referral but a DIFFERENT live PI
  // (quarter→half re-quote). Reusing it would orphan pi_OLD.
  const rows = [{ id: 'recPayOld', Status: 'pending', 'Stripe Payment Intent Id': 'pi_OLD' }];
  const reusable = selectReusablePaymentRow(rows, PI); // pi_NEW
  assert.equal(reusable, null, 'must not reuse the pi_OLD row');
});

test('requires_webhook_replay row is NEVER reused (even on exact PI match)', () => {
  // Orphan-reaper already saw a SUCCEEDED pi_NEW that never settled. Recycling
  // this row would mask an unreconciled charge.
  const rows = [
    { id: 'recReplay', Status: 'requires_webhook_replay', 'Stripe Payment Intent Id': 'pi_NEW' },
  ];
  const reusable = selectReusablePaymentRow(rows, PI); // pi_NEW
  assert.equal(reusable, null, 'must not reuse the replay-flagged row');
});

test('terminal rows (succeeded/refunded/abandoned/failed) are never reused', () => {
  for (const status of ['succeeded', 'refunded', 'abandoned', 'failed']) {
    const rows = [{ id: 'recTerm', Status: status, 'Stripe Payment Intent Id': 'pi_NEW' }];
    assert.equal(
      selectReusablePaymentRow(rows, PI),
      null,
      `must not reuse a ${status} row`,
    );
  }
});

test('no candidates → no reuse (create)', () => {
  assert.equal(selectReusablePaymentRow([], PI), null);
});

test('mixed set: picks the exact-PI pending row, ignores different-PI + replay', () => {
  const rows = [
    { id: 'recReplay', Status: 'requires_webhook_replay', 'Stripe Payment Intent Id': 'pi_NEW' },
    { id: 'recOld', Status: 'pending', 'Stripe Payment Intent Id': 'pi_OLD' },
    { id: 'recMatch', Status: 'pending', 'Stripe Payment Intent Id': 'pi_NEW' },
  ];
  const reusable = selectReusablePaymentRow(rows, PI);
  assert.equal(reusable?.id, 'recMatch');
});
