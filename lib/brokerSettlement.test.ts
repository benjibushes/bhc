// BROKER RAIL settlement + link-token tests.
//
// readBrokerMoney is the pure money read from a settled PaymentIntent. The
// settle function itself is I/O (Airtable + Resend + Telegram) and is covered
// by the guardrails around it: markDepositSucceeded is the idempotency anchor
// and every notification sits strictly behind it.

import test from 'node:test';
import assert from 'node:assert/strict';
// Imported from lib/brokerRail (hermetic) rather than lib/brokerSettlement,
// which pulls lib/email → lib/secrets and cannot load in a bare test env.
// brokerSettlement re-exports the same function.
import { readBrokerMoney } from './brokerRail';
import {
  mintBrokerReserveToken,
  verifyBrokerReserveToken,
  mintCampaignReserveToken,
  verifyCampaignReserveToken,
  brokerDepositPathFor,
} from './campaignReserve';

// ---------------------------------------------------------------------------
// readBrokerMoney — pi.amount is authoritative for what was CHARGED
// ---------------------------------------------------------------------------

test('readBrokerMoney: reads the deposit + price and derives the balance', () => {
  const m = readBrokerMoney({
    amount: 40000,
    metadata: { depositCents: '40000', priceCents: '180000' },
  });
  assert.equal(m.depositCents, 40000);
  assert.equal(m.priceCents, 180000);
  assert.equal(m.balanceCents, 140000);
});

test('readBrokerMoney: CLAMPS a metadata deposit larger than the real charge', () => {
  // Never record more collected than Stripe actually took.
  const m = readBrokerMoney({
    amount: 40000,
    metadata: { depositCents: '999999', priceCents: '180000' },
  });
  assert.equal(m.depositCents, 40000);
});

test('readBrokerMoney: falls back to the charged amount when depositCents is absent', () => {
  const m = readBrokerMoney({ amount: 40000, metadata: { priceCents: '180000' } });
  assert.equal(m.depositCents, 40000);
  assert.equal(m.balanceCents, 140000);
});

test('readBrokerMoney: a missing/implausible price collapses the balance to zero, never negative', () => {
  // Better to tell a rancher "$0 to collect" (visibly wrong, he calls us) than
  // to print a negative balance or invent a price nobody set.
  assert.equal(readBrokerMoney({ amount: 40000, metadata: {} }).balanceCents, 0);
  assert.equal(
    readBrokerMoney({ amount: 40000, metadata: { priceCents: '100' } }).balanceCents,
    0,
  );
});

test('readBrokerMoney: accepts a Checkout Session shape (amount_total)', () => {
  // The checkout.session.completed branch normalizes into the PI shape, but the
  // reader tolerates amount_total directly as well.
  const m = readBrokerMoney({
    amount_total: 40000,
    metadata: { depositCents: '40000', priceCents: '180000' },
  });
  assert.equal(m.depositCents, 40000);
  assert.equal(m.balanceCents, 140000);
});

test('readBrokerMoney: the money identity holds — deposit + balance == price', () => {
  const m = readBrokerMoney({
    amount: 62500,
    metadata: { depositCents: '62500', priceCents: '295000' },
  });
  assert.equal(m.depositCents + m.balanceCents, m.priceCents);
});

// ---------------------------------------------------------------------------
// LINK TOKENS — the two rails must never cross
// ---------------------------------------------------------------------------

test('broker token: round-trips consumerId + rancherId + cut', () => {
  const token = mintBrokerReserveToken({
    consumerId: 'recCONSUMER00001',
    rancherId: 'recBROKER0000001',
    cut: 'half',
  });
  const v = verifyBrokerReserveToken(token);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.payload.consumerId, 'recCONSUMER00001');
  assert.equal(v.payload.rancherId, 'recBROKER0000001');
  assert.equal(v.payload.cut, 'half');
});

test('RAIL CROSSOVER: a CONNECT campaign token is REJECTED by the broker verifier', () => {
  const connectToken = mintCampaignReserveToken({
    consumerId: 'recCONSUMER00001',
    rancherSlug: 'cedar-draw-beef',
    cut: 'half',
  });
  const v = verifyBrokerReserveToken(connectToken);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'wrong-purpose');
});

test('RAIL CROSSOVER: a BROKER token is REJECTED by the connect campaign verifier', () => {
  // Without this, a broker link could redeem on /r/d and charge the buyer under
  // Connect economics (deposit + fee on top) for a rancher with no Connect
  // account — the exact confused-deputy bug the split purposes prevent.
  const brokerToken = mintBrokerReserveToken({
    consumerId: 'recCONSUMER00001',
    rancherId: 'recBROKER0000001',
    cut: 'half',
  });
  const v = verifyCampaignReserveToken(brokerToken);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'wrong-purpose');
});

test('broker token: refuses to mint without a rancherId (a slug is not accepted)', () => {
  assert.throws(
    () => mintBrokerReserveToken({ consumerId: 'recX', rancherId: '', cut: 'half' }),
    /rancherId required/,
  );
});

test('broker token: refuses to mint an invalid cut', () => {
  assert.throws(
    () => mintBrokerReserveToken({ consumerId: 'recX', rancherId: 'recY', cut: 'eighth' as any }),
    /quarter\|half\|whole/,
  );
});

test('broker token verify: garbage, empty, and oversized inputs fail closed (never throw)', () => {
  assert.equal(verifyBrokerReserveToken('').ok, false);
  assert.equal(verifyBrokerReserveToken(null).ok, false);
  assert.equal(verifyBrokerReserveToken('not.a.jwt').ok, false);
  assert.equal(verifyBrokerReserveToken('x'.repeat(5000)).ok, false);
});

test('brokerDepositPathFor: lands on the BROKER checkout page, not the Connect one', () => {
  const path = brokerDepositPathFor('recREF0000000001', 'half');
  assert.equal(path, '/checkout/recREF0000000001/broker?cut=half');
  assert.ok(!path.includes('/deposit'));
});
