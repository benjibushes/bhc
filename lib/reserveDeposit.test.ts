import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertReserveEligible,
  buildReserveReferralFields,
  depositPathFor,
  normalizeReservePhone,
  resolveBuyerContact,
} from './reserveDeposit';

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

test('normalizeReservePhone coerces US numbers to E.164, rejects junk', () => {
  assert.equal(normalizeReservePhone('(270) 555-0182'), '+12705550182');
  assert.equal(normalizeReservePhone('270.555.0182'), '+12705550182');
  assert.equal(normalizeReservePhone('1 270 555 0182'), '+12705550182');
  assert.equal(normalizeReservePhone(''), '');
  assert.equal(normalizeReservePhone('555-1234'), ''); // too short
  assert.equal(normalizeReservePhone(undefined), '');
});

test('buildReserveReferralFields writes Buyer Phone + State when present', () => {
  const f = buildReserveReferralFields({
    rancher: activeRancher,
    consumerId: 'recBuyer',
    buyerName: 'Jane',
    buyerEmail: 'jane@example.com',
    buyerPhone: '+12705550182',
    buyerState: 'KY',
    cut: 'half',
  });
  assert.equal(f['Buyer Phone'], '+12705550182');
  assert.equal(f['Buyer State'], 'KY');
});

test('buildReserveReferralFields omits Phone/State keys when blank (no blanking on re-create)', () => {
  const f = buildReserveReferralFields({
    rancher: activeRancher,
    consumerId: 'recBuyer',
    buyerName: 'Jane',
    buyerEmail: 'jane@example.com',
    cut: 'half',
  });
  assert.equal('Buyer Phone' in f, false);
  assert.equal('Buyer State' in f, false);
});

test('resolveBuyerContact prefers referral values', () => {
  const got = resolveBuyerContact(
    { 'Buyer Phone': '+12705550182', 'Buyer State': 'KY' },
    { Phone: '+19999999999', State: 'TX' },
  );
  assert.deepEqual(got, { phone: '+12705550182', state: 'KY' });
});

test('resolveBuyerContact falls back to consumer when referral lacks them', () => {
  const got = resolveBuyerContact(
    { 'Buyer Phone': '', 'Buyer State': '' },
    { Phone: '+19999999999', State: 'TX' },
  );
  assert.deepEqual(got, { phone: '+19999999999', state: 'TX' });
});

test('resolveBuyerContact tolerates a missing consumer', () => {
  const got = resolveBuyerContact({ 'Buyer Phone': '+12705550182' });
  assert.deepEqual(got, { phone: '+12705550182', state: '' });
});
