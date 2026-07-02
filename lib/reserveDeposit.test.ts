import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertReserveEligible,
  buildReserveConsumerFields,
  buildReserveReferralFields,
  depositPathFor,
  normalizeReservePhone,
  reserveConsumerStatusPatch,
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

// ── Reserve-rail consumer status (buyer-trust tail #2) ──────────────────────
// The member auth gates (login + verify) only admit Status in
// ['approved','active','waitlisted']. A reserve-created consumer with a blank
// Status could pay a deposit yet NEVER log in — the magic link 302'd them to
// /access?reason=not-approved. A reserving buyer must ALWAYS be able to log in.

const MEMBER_LOGIN_ALLOWED = ['approved', 'active', 'waitlisted'];

test('reserve-created consumer gets a login-allowed Status at create', () => {
  const fields = buildReserveConsumerFields({
    slug: 'renick-valley',
    cut: 'half',
    buyerName: 'Jane Doe',
    buyerEmail: 'jane@example.com',
    buyerPhone: '+12705550182',
    buyerState: 'KY',
    smsOptIn: true,
  });
  assert.ok(
    MEMBER_LOGIN_ALLOWED.includes(String(fields['Status']).toLowerCase()),
    `Status "${fields['Status']}" must be login-allowed`,
  );
  assert.ok(fields['Approved At'], 'Approved At must be stamped');
});

test('reserve consumer fields mirror the route field set', () => {
  const fields = buildReserveConsumerFields({
    slug: 'renick-valley',
    cut: 'quarter',
    buyerName: '',
    buyerEmail: 'jane@example.com',
    buyerPhone: '+12705550182',
    buyerState: '',
    smsOptIn: false,
  });
  assert.equal(fields['Segment'], 'Beef Buyer');
  assert.equal(fields['Source'], 'rancher-page-deposit:renick-valley');
  assert.equal(fields['Order Type'], 'Quarter Cow');
  assert.deepEqual(fields['Interests'], ['Beef']);
  assert.equal(fields['SMS Opt-In'], false);
  assert.equal('SMS Opt-In At' in fields, false);
  assert.equal('State' in fields, false);
});

test('statusPatch promotes blank/pending existing consumers to Approved', () => {
  assert.equal(reserveConsumerStatusPatch('')['Status'], 'Approved');
  assert.ok(reserveConsumerStatusPatch('')['Approved At']);
  assert.equal(reserveConsumerStatusPatch(undefined)['Status'], 'Approved');
  assert.equal(reserveConsumerStatusPatch('Pending')['Status'], 'Approved');
});

test('statusPatch never touches login-allowed or rejected statuses', () => {
  assert.deepEqual(reserveConsumerStatusPatch('Approved'), {});
  assert.deepEqual(reserveConsumerStatusPatch('Active'), {});
  assert.deepEqual(reserveConsumerStatusPatch('Waitlisted'), {});
  // Rejected is a deliberate admin decision — reserve must not undo it.
  assert.deepEqual(reserveConsumerStatusPatch('Rejected'), {});
});

// ── T2.2: Referred By attribution on the reserve rail ───────────────────────

test('buildReserveConsumerFields stamps Referred By only when a validated code is passed', () => {
  const base = {
    slug: 'renick-valley',
    cut: 'half' as const,
    buyerName: 'Jo Buyer',
    buyerEmail: 'jo@example.com',
    buyerPhone: '',
    smsOptIn: false,
  };
  const withRef = buildReserveConsumerFields({ ...base, referredBy: 'benji4f2k' });
  assert.equal(withRef['Referred By'], 'benji4f2k');
  const withoutRef = buildReserveConsumerFields(base);
  assert.equal('Referred By' in withoutRef, false);
  const emptyRef = buildReserveConsumerFields({ ...base, referredBy: '' });
  assert.equal('Referred By' in emptyRef, false);
});
