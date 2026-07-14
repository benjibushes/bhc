import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRancherFinalPaidContent, notifyRancherFinalPaid } from './rancherNotify';

// ── buildRancherFinalPaidContent — pure copy builder ─────────────────────────

test('final-paid content carries buyer first name + both amounts', () => {
  const c = buildRancherFinalPaidContent({
    buyerFirstName: 'Amie',
    finalAmount: 1250,
    totalSaleAmount: 2000,
  });
  assert.equal(c.pushTitle, '🎯 Amie paid in full — $1250.00');
  assert.equal(c.pushBody, 'total sale $2000.00. payout lands in your bank in ~2 business days.');
  assert.equal(c.emailSubject, 'Amie paid their final balance — $1250.00');
});

test('final-paid content falls back to "Your buyer" when name is missing', () => {
  const c = buildRancherFinalPaidContent({
    buyerFirstName: '',
    finalAmount: 750.5,
    totalSaleAmount: 750.5,
  });
  assert.equal(c.pushTitle, '🎯 Your buyer paid in full — $750.50');
  assert.equal(c.emailSubject, 'Your buyer paid their final balance — $750.50');
});

// ── notifyRancherFinalPaid — channel gating ──────────────────────────────────
// A rancher with no email must never fake emailSent; push is still attempted
// (sendRancherPush no-ops safely without VAPID env — dark-safe in tests).

test('notifyRancherFinalPaid without a rancher email reports skipped, not sent', async () => {
  const referral = { 'Buyer Name': 'Amie Jones' };
  const rancher = { id: 'recTESTRANCHER', 'Ranch Name': 'Test Ranch', Phone: '' };
  const r = await notifyRancherFinalPaid(referral, rancher, {
    finalAmount: 1250,
    totalSaleAmount: 2000,
  });
  assert.equal(r.emailSent, false);
  assert.equal(r.hadEmail, false);
  assert.equal(r.skipped, 'rancher has no email');
});
