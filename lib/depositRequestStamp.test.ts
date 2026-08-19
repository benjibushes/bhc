// lib/depositRequestStamp.test.ts
//
// The self-serve Connect rail stamped NOTHING on the Referral, so a buyer who
// minted their own Stripe session was invisible to the outstanding-deposit
// chase and to owed-deposit reporting. These pins encode the fix AND the
// landmine it sits next to: Status and the request stamp are inseparable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depositRequestStampFields } from './depositRequestStamp';
// The guard this stamp has to stay compatible with — imported for real so the
// two modules can never drift apart in a way that bricks a paying buyer.
import { isDepositAlreadyPaid } from './depositPaidState';

const NOW = '2026-08-19T15:23:15.707Z';
const input = {
  cut: 'quarter',
  depositDollars: 550,
  fullSaleDollars: 2200,
  checkoutUrl: 'https://www.buyhalfcow.com/r/p/abc123',
  nowISO: NOW,
};

// ── the fix ────────────────────────────────────────────────────────────────

test('an unstamped referral gets marked as an outstanding ask', () => {
  const patch = depositRequestStampFields({ Status: 'Rancher Contacted' }, input)!;
  assert.equal(patch['Status'], 'Awaiting Payment');
  assert.equal(patch['Deposit Requested At'], NOW);
  assert.equal(patch['Deposit Amount'], 550);
  assert.equal(patch['Total Sale Amount'], 2200);
  assert.equal(patch['Order Type'], 'quarter');
  assert.equal(patch['Deposit Checkout URL'], 'https://www.buyhalfcow.com/r/p/abc123');
});

test('the stamped referral now matches the strong chase query', () => {
  // AND({Status}="Awaiting Payment", NOT({Deposit Requested At}=""), {Deposit Paid At}="")
  const patch = depositRequestStampFields({ Status: 'Rancher Contacted' }, input)!;
  assert.equal(patch['Status'], 'Awaiting Payment');
  assert.notEqual(String(patch['Deposit Requested At']), '');
  assert.equal(patch['Deposit Paid At'], undefined, 'the stamp must never claim payment');
});

// ── ⚠️ THE LANDMINE ────────────────────────────────────────────────────────
// lib/depositPaidState: 'Awaiting Payment' WITHOUT a request stamp reads as
// PAID, so the re-pay guard 409s a buyer who has paid nothing. That is the
// 2026-07-14 bricked-buyer bug — 8 deposits requested, 0 payable, because the
// emailed Stripe link dies at 24h and the durable page refused them.

test('the patch keeps the buyer PAYABLE — Status and the stamp travel together', () => {
  const patch = depositRequestStampFields({ Status: 'Rancher Contacted' }, input)!;
  const after = { ...patch } as any;
  assert.equal(
    isDepositAlreadyPaid(after),
    false,
    'a buyer who just opened checkout must still be able to pay',
  );
});

test('Status WITHOUT the request stamp would brick the buyer — proving why they are inseparable', () => {
  // Not something the module can emit; asserted so the hazard stays documented
  // and any future "just set the status" shortcut fails this file.
  assert.equal(
    isDepositAlreadyPaid({ Status: 'Awaiting Payment' }),
    true,
    'bare Awaiting Payment reads as PAID — never write it alone',
  );
  const patch = depositRequestStampFields({ Status: 'Rancher Contacted' }, input)!;
  assert.ok(
    'Status' in patch && 'Deposit Requested At' in patch,
    'the module must emit both keys or neither',
  );
});

// ── idempotency ────────────────────────────────────────────────────────────

test('an already-requested referral is left alone (retries must not reset the clock)', () => {
  const earlier = '2026-08-17T09:00:00.000Z';
  const patch = depositRequestStampFields(
    { Status: 'Awaiting Payment', 'Deposit Requested At': earlier },
    input,
  );
  assert.equal(patch, null, 're-stamping resets the nudge cadence and staleness clocks');
});

test('a paid referral is never re-opened as an outstanding ask', () => {
  const patch = depositRequestStampFields(
    { Status: 'Awaiting Payment', 'Deposit Paid At': '2026-08-18T00:00:00.000Z' },
    input,
  );
  assert.equal(patch, null);
});

test('a rancher-requested deposit keeps ITS timestamp when the buyer then pays through the page', () => {
  const rancherAsked = '2026-08-19T13:00:00.000Z';
  const patch = depositRequestStampFields(
    { Status: 'Awaiting Payment', 'Deposit Requested At': rancherAsked },
    { ...input, nowISO: '2026-08-19T15:23:15.707Z' },
  );
  assert.equal(patch, null, 'the FIRST ask is the honest one');
});

// ── money fields are only written when real ────────────────────────────────

test('zero or garbage amounts are omitted rather than written as a lie', () => {
  const patch = depositRequestStampFields(
    { Status: 'Intro Sent' },
    { ...input, depositDollars: 0, fullSaleDollars: Number.NaN },
  )!;
  assert.equal('Deposit Amount' in patch, false);
  assert.equal('Total Sale Amount' in patch, false);
  // ...but the ask itself is still recorded.
  assert.equal(patch['Status'], 'Awaiting Payment');
  assert.equal(patch['Deposit Requested At'], NOW);
});

test('a raw Stripe URL is never persisted as the durable link (it dies at 24h)', () => {
  for (const url of [
    'https://checkout.stripe.com/c/pay/cs_live_abc',
    'https://stripe.com/whatever',
  ]) {
    const patch = depositRequestStampFields({ Status: 'Intro Sent' }, { ...input, checkoutUrl: url })!;
    assert.equal('Deposit Checkout URL' in patch, false, `${url} must not be stored`);
  }
});

test('a missing referral is a no-op, never a throw on the money path', () => {
  assert.equal(depositRequestStampFields(null, input), null);
  assert.equal(depositRequestStampFields(undefined, input), null);
});
