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

// ── Ad attribution on the Connect reserve rail (2026-08-17) ─────────────────
// SCOPE, HONESTLY: this builder is NOT reached in production today. Its only
// non-test caller sits below the unconditional quiz-gate 409 at
// app/api/checkout/reserve/route.ts:246 (the create is marked `// (unreachable)`
// there), so Connect direct-reserve never mints a Consumer — new emails go to
// /access, which has persisted these columns all along. The rail that actually
// lost its match key is broker self-serve, pinned in
// app/api/checkout/broker-reserve/route.test.ts.
// These tests exist so the field set is already correct the day that gate is
// lifted, and so the shared mapper's guarantees hold at every call site.

const ATTRIBUTION_BASE = {
  slug: 'renick-valley',
  cut: 'half' as const,
  buyerName: 'Jo Buyer',
  buyerEmail: 'jo@example.com',
  buyerPhone: '+12705550182',
  smsOptIn: false,
};

test('reserve CREATE carries the ad attribution through to Consumers columns', () => {
  const fields = buildReserveConsumerFields({
    ...ATTRIBUTION_BASE,
    attribution: {
      utm_source: 'facebook',
      utm_medium: 'paid',
      utm_campaign: 'az-half-cow',
      fbclid: 'IwAR0testclickid',
      fbclid_ts: '1755300000000',
    },
  });
  assert.equal(fields['utm_source'], 'facebook');
  assert.equal(fields['utm_medium'], 'paid');
  assert.equal(fields['utm_campaign'], 'az-half-cow');
  // The PAIR that reconstructFbc needs — losing either one costs the match.
  assert.equal(fields['fbclid'], 'IwAR0testclickid');
  assert.equal(fields['fbclid_ts'], '1755300000000');
  // Keys with no value are never written (can't blank an existing column).
  assert.equal('gclid' in fields, false);
  assert.equal('utm_term' in fields, false);
});

test('an OVERSIZED attribution value is dropped, not written to Airtable', () => {
  // createRecord (lib/airtable) only self-heals unknown-field and bad-select
  // 422s — any other 422 rethrows and fails the whole consumer create. A buyer
  // with a garbage localStorage value must still be able to reserve.
  const huge = 'x'.repeat(1000);
  const fields = buildReserveConsumerFields({
    ...ATTRIBUTION_BASE,
    attribution: { utm_source: huge, utm_medium: 'paid', fbclid: huge, fbclid_ts: '1755300000000' },
  });
  assert.equal('utm_source' in fields, false);
  assert.equal('fbclid' in fields, false);
  assert.equal('fbclid_ts' in fields, false, 'the pair goes together');
  assert.equal(fields['utm_medium'], 'paid', 'a sane sibling still lands');
  assert.equal(fields['Email'], 'jo@example.com', 'the reserve is unaffected');
});

test('NON-STRING attribution values never reach the record', () => {
  const fields = buildReserveConsumerFields({
    ...ATTRIBUTION_BASE,
    attribution: {
      utm_source: 12345,
      utm_medium: null,
      utm_campaign: { nested: true },
      utm_content: ['a'],
      utm_term: true,
      fbclid: 'IwAR0abc',
      fbclid_ts: 1755300000000, // number, not the stored string
    },
  });
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    assert.equal(k in fields, false, `${k} must not be written`);
  }
  // A numeric fbclid_ts is not the stored shape — the pair drops rather than
  // persisting an fbclid whose timestamp we can't vouch for.
  assert.equal('fbclid' in fields, false);
  assert.equal('fbclid_ts' in fields, false);
});

test('a lone fbclid never reaches the record through the reserve builder', () => {
  const fields = buildReserveConsumerFields({
    ...ATTRIBUTION_BASE,
    attribution: { fbclid: 'IwAR0abc', utm_source: 'facebook' },
  });
  assert.equal('fbclid' in fields, false);
  assert.equal('fbclid_ts' in fields, false);
  assert.equal(fields['utm_source'], 'facebook');
});

test('no / malformed attribution never adds keys and never throws', () => {
  // localStorage blocked, wiped, or corrupt must not change the field set —
  // attribution is measurement, never a gate on the money path.
  for (const attribution of [undefined, null, '', 'fbclid=abc', [], 0, { fbclid: 42 }]) {
    const fields = buildReserveConsumerFields({ ...ATTRIBUTION_BASE, attribution });
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'fbclid_ts', 'gclid']) {
      assert.equal(k in fields, false, `${k} must be absent for attribution=${JSON.stringify(attribution)}`);
    }
    // …and the rest of the record is untouched.
    assert.equal(fields['Email'], 'jo@example.com');
    assert.equal(fields['Status'], 'Approved');
  }
});
