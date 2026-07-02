// lib/depositRequest.emailOutcome.test.ts
//
// GO-LIVE MONEY HARDENING finding 3 (2026-07-02) — request-deposit must not
// report ok:true as if the buyer was emailed when the send failed.
//
// THE BUG: the route awaited sendBuyerDepositInvoice in a 'Non-fatal'
// try/catch and IGNORED its return value. guardedSend returns
// { success:false, suppressed:true } WITHOUT throwing for bounced/
// unsubscribed recipients — so a suppressed buyer produced ok:true and the
// rancher believed the buyer got the deposit link. First downstream net is
// the 14-day SLA chase… which pings the RANCHER, not the buyer.
//
// depositEmailOutcome is the pure decision: collapse a guardedSend-shaped
// result (or the absence of one, when the send threw) into the honest
// { emailSent, suppressed, reason } the route response + rancher UI surface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depositEmailOutcome } from './depositRequest';

test('send success → emailSent true', () => {
  const o = depositEmailOutcome({ success: true });
  assert.equal(o.emailSent, true);
  assert.equal(o.suppressed, false);
});

test('suppressed recipient (bounced/unsubscribed) → emailSent false + suppressed true + reason kept', () => {
  const o = depositEmailOutcome({
    success: false,
    suppressed: true,
    reason: 'unsubscribed-bounced-or-complained',
  });
  assert.equal(o.emailSent, false);
  assert.equal(o.suppressed, true);
  assert.equal(o.reason, 'unsubscribed-bounced-or-complained');
});

test('non-suppression failure → emailSent false, suppressed false', () => {
  const o = depositEmailOutcome({ success: false, reason: 'resend-500' });
  assert.equal(o.emailSent, false);
  assert.equal(o.suppressed, false);
  assert.equal(o.reason, 'resend-500');
});

test('null/undefined result (send threw before returning) → emailSent false', () => {
  assert.deepEqual(depositEmailOutcome(null), { emailSent: false, suppressed: false, reason: undefined });
  assert.deepEqual(depositEmailOutcome(undefined), { emailSent: false, suppressed: false, reason: undefined });
});

test('success must be EXACTLY true — truthy junk never counts as sent', () => {
  assert.equal(depositEmailOutcome({ success: 1 as any }).emailSent, false);
  assert.equal(depositEmailOutcome({} as any).emailSent, false);
  // suppressed likewise strict — a stringy flag must not soften the alert copy.
  assert.equal(depositEmailOutcome({ success: false, suppressed: 'yes' as any }).suppressed, false);
});
