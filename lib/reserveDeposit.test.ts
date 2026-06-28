import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReserveEligible, buildReserveReferralFields, depositPathFor } from './reserveDeposit';

const activeRancher = {
  id: 'recRanch',
  'Ranch Name': 'Renick Valley',
  'Operator Name': 'Renick',
  'Pricing Model': 'tier_v2',
  'Stripe Connect Status': 'active',
  'Active Status': 'Active',
  'Agreement Signed': true,
  'Tier': 'Pasture',
  'Quarter Price': 1250,
  'Half Price': 2400,
  'Whole Price': 4600,
};

test('eligible: tier_v2 active rancher with a priced cut', () => {
  assert.deepEqual(assertReserveEligible(activeRancher, 'half'), { ok: true });
});

test('legacy rancher → 409 fallback', () => {
  const r = { ...activeRancher, 'Pricing Model': 'legacy' };
  const res = assertReserveEligible(r, 'half');
  assert.equal(res.ok, false);
  if (!res.ok) { assert.equal(res.status, 409); assert.equal(res.fallback, true); }
});

test('connect not active → 409', () => {
  const r = { ...activeRancher, 'Stripe Connect Status': 'onboarding' };
  const res = assertReserveEligible(r, 'half');
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 409);
});

test('connect-active but Tier unset → 409 fallback (deposit would dead-end)', () => {
  const r: any = { ...activeRancher };
  delete r.Tier;
  const res = assertReserveEligible(r, 'half');
  assert.equal(res.ok, false);
  if (!res.ok) { assert.equal(res.status, 409); assert.equal(res.fallback, true); }
});

test('cut not priced / below MIN_TIER_PRICE → 409', () => {
  const r = { ...activeRancher, 'Half Price': 7.4 }; // per-lb mis-entry
  const res = assertReserveEligible(r, 'half');
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 409);
});

test('unpriced cut (missing field) → 409', () => {
  const r = { ...activeRancher, 'Whole Price': 0 };
  const res = assertReserveEligible(r, 'whole');
  assert.equal(res.ok, false);
});

test('buildReserveReferralFields pins Rancher + Buyer, no lead Approval Status', () => {
  const f = buildReserveReferralFields({
    rancher: activeRancher,
    consumerId: 'recBuyer',
    buyerName: '',
    buyerEmail: 'jane@example.com',
    cut: 'half',
  });
  assert.deepEqual(f.Rancher, ['recRanch']);
  assert.deepEqual(f.Buyer, ['recBuyer']);
  assert.equal(f.Status, 'Pending');
  assert.equal(f['Match Type'], 'Direct (Rancher Page) — Deposit');
  assert.equal(f['Order Type'], 'Half Cow');
  assert.equal(f['Approval Status'], undefined); // NOT a lead
  assert.match(String(f.Name), /jane@example\.com/);
});

test('depositPathFor builds the cut-prefilled deposit url', () => {
  assert.equal(depositPathFor('recRef', 'half'), '/checkout/recRef/deposit?cut=half');
});
