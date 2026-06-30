import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSACTIONAL_WHITELIST } from './emailFrequencyGuard';

// The buyer's money-moment confirmations must NEVER be frequency-capped.
// A fresh deposit buyer receives several emails in the same window
// (welcome + quiz-invite + intro), so any of these getting silently
// dropped = "did my payment go through?" anxiety, refunds, chargebacks.
const MONEY_MOMENT_CONFIRMATIONS = [
  'sendPostPurchaseWelcome', // deposit-paid confirmation (the #1 moment)
  'sendBuyerSlotLocked',
  'sendBuyerFinalInvoice',
  'sendRancherDepositPaid',
  // The two quiz-complete invites are the #1 funnel conversion emails: a
  // qualified buyer gets exactly one (deposit invite for tier_v2/Connect,
  // cal invite for legacy). Either being frequency-capped = the qualified
  // buyer is told nothing post-quiz. Must never be capped.
  'quiz_complete_deposit_invite',
  'quiz_complete_cal_invite',
];

for (const template of MONEY_MOMENT_CONFIRMATIONS) {
  test(`TRANSACTIONAL_WHITELIST includes money-moment confirmation: ${template}`, () => {
    assert.equal(
      TRANSACTIONAL_WHITELIST.has(template),
      true,
      `${template} must be transactional-whitelisted so it can never be frequency-capped`
    );
  });
}
