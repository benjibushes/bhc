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
  'sendRancherFinalPaid', // deal fully paid — the rancher's payday ping
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

// Money-path sends that previously went through generic sendEmail() with the
// default 'sendEmail' templateName — i.e. subject to the 3/week cap. A rancher
// or buyer mid-deal trivially exceeds 3 emails/week, after which these were
// silently suppressed: a NEW paying store lead's order request vanished, thread
// replies dropped mid-conversation, payout-failure notices never reached the
// rancher, and the one-shot dunning escalation was swallowed forever.
// Guard-truth fix 2026-07-01.
const MONEY_PATH_DIRECT_SENDS = [
  'sendOrderRequestToRancher', // /api/orders/request — the paying store lead itself
  'sendOrderRequestConfirmation', // /api/orders/request — buyer's "request delivered" confirm
  'sendThreadMessageNotification', // /api/threads/[id]/message — 1:1 buyer<->rancher mirror
  'sendPayoutFailed', // stripe-connect payout.failed — rancher must fix bank to get paid
  'sendDunningEscalation', // final-invoice-dunning — one-shot-per-deal rancher escalation
];

for (const template of MONEY_PATH_DIRECT_SENDS) {
  test(`TRANSACTIONAL_WHITELIST includes money-path direct send: ${template}`, () => {
    assert.equal(
      TRANSACTIONAL_WHITELIST.has(template),
      true,
      `${template} must be transactional-whitelisted so it can never be frequency-capped`
    );
  });
}

// Operator-facing 1:1 internal notices — every booking + alert routes to the
// same operator inbox, so Ben trivially exceeds 3 sends/week. These are
// once-per-event internal notices that cannot create volume; capping them
// blinds him on a live sales call.
const OPERATOR_INTERNAL_NOTICES = [
  'sendOperatorPreCallBrief', // pre-call brief the moment a buyer books a sales call
];

for (const template of OPERATOR_INTERNAL_NOTICES) {
  test(`TRANSACTIONAL_WHITELIST includes operator internal notice: ${template}`, () => {
    assert.equal(
      TRANSACTIONAL_WHITELIST.has(template),
      true,
      `${template} must be transactional-whitelisted so it can never be frequency-capped`
    );
  });
}

// ── countSendsByEmail (pure — batch cap-prime helper, scale audit 2026-07-22) ─
// primeFrequencyCapCache replaces one Email Sends count read PER RECIPIENT
// with a single read for the whole cron run; this is its counting core.

import { countSendsByEmail } from './emailFrequencyGuard';

test('countSendsByEmail counts rows per recipient, case/whitespace-normalized', () => {
  const counts = countSendsByEmail([
    { 'Recipient Email': 'a@x.com' },
    { 'Recipient Email': 'A@X.com ' },
    { 'Recipient Email': ' b@x.com' },
  ]);
  assert.equal(counts.get('a@x.com'), 2);
  assert.equal(counts.get('b@x.com'), 1);
});

test('countSendsByEmail skips rows with missing/blank recipient', () => {
  const counts = countSendsByEmail([
    {},
    { 'Recipient Email': '' },
    { 'Recipient Email': '   ' },
    { 'Recipient Email': 'c@x.com' },
  ]);
  assert.equal(counts.size, 1);
  assert.equal(counts.get('c@x.com'), 1);
});

test('countSendsByEmail on empty input returns an empty map (0-send recipients prime as 0)', () => {
  assert.equal(countSendsByEmail([]).size, 0);
});
