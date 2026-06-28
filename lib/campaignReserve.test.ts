import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {
  mintCampaignReserveToken,
  verifyCampaignReserveToken,
  mintDepositGrantToken,
  verifyDepositGrantToken,
  decideCampaignRedirect,
  rancherPublicPath,
  CAMPAIGN_RESERVE_PURPOSE,
  DEPOSIT_GRANT_PURPOSE,
  type VerifyResult,
  type CampaignReservePayload,
} from './campaignReserve';

// signJwt/verifyJwtWithFallback read process.env.JWT_SECRET at module load — the
// npm test script sets JWT_SECRET=test-secret-ci. Mirror that fallback so a bare
// `tsx --test` run still works.
const SECRET = process.env.JWT_SECRET || 'test-secret-ci';

// ---------------------------------------------------------------------------
// Campaign-reserve token: mint → verify roundtrip
// ---------------------------------------------------------------------------

test('campaign-reserve: mint → verify roundtrip preserves claims', () => {
  const token = mintCampaignReserveToken({
    consumerId: 'recBuyer1',
    rancherSlug: 'renick-valley',
    cut: 'half',
  });
  const res = verifyCampaignReserveToken(token);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.payload.purpose, CAMPAIGN_RESERVE_PURPOSE);
    assert.equal(res.payload.consumerId, 'recBuyer1');
    assert.equal(res.payload.rancherSlug, 'renick-valley');
    assert.equal(res.payload.cut, 'half');
  }
});

test('campaign-reserve: cut is normalized to lowercase on mint + verify', () => {
  const token = mintCampaignReserveToken({
    consumerId: 'recB',
    rancherSlug: 'foo',
    cut: 'WHOLE' as any,
  });
  const res = verifyCampaignReserveToken(token);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.payload.cut, 'whole');
});

test('campaign-reserve: mint rejects missing fields + bad cut', () => {
  assert.throws(() => mintCampaignReserveToken({ consumerId: '', rancherSlug: 'x', cut: 'half' }));
  assert.throws(() => mintCampaignReserveToken({ consumerId: 'a', rancherSlug: '', cut: 'half' }));
  assert.throws(() => mintCampaignReserveToken({ consumerId: 'a', rancherSlug: 'x', cut: 'side' as any }));
});

// ---------------------------------------------------------------------------
// Campaign-reserve token: rejection modes
// ---------------------------------------------------------------------------

test('campaign-reserve: missing / empty token → missing', () => {
  assert.deepEqual(verifyCampaignReserveToken(null), { ok: false, reason: 'missing' });
  assert.deepEqual(verifyCampaignReserveToken(''), { ok: false, reason: 'missing' });
  assert.deepEqual(verifyCampaignReserveToken(undefined), { ok: false, reason: 'missing' });
});

test('campaign-reserve: EXPIRED token → invalid', () => {
  // Sign directly with the same secret but an already-elapsed expiry.
  const expired = jwt.sign(
    { purpose: CAMPAIGN_RESERVE_PURPOSE, consumerId: 'recB', rancherSlug: 'foo', cut: 'half' },
    SECRET,
    { expiresIn: '-10s' },
  );
  assert.deepEqual(verifyCampaignReserveToken(expired), { ok: false, reason: 'invalid' });
});

test('campaign-reserve: TAMPERED token → invalid', () => {
  const token = mintCampaignReserveToken({ consumerId: 'recB', rancherSlug: 'foo', cut: 'half' });
  // Flip a character in the signature segment (3rd dot-section).
  const parts = token.split('.');
  parts[2] = parts[2][0] === 'A' ? 'B' + parts[2].slice(1) : 'A' + parts[2].slice(1);
  const tampered = parts.join('.');
  assert.deepEqual(verifyCampaignReserveToken(tampered), { ok: false, reason: 'invalid' });
});

test('campaign-reserve: token signed with a DIFFERENT secret → invalid', () => {
  const foreign = jwt.sign(
    { purpose: CAMPAIGN_RESERVE_PURPOSE, consumerId: 'recB', rancherSlug: 'foo', cut: 'half' },
    'totally-different-secret',
    { expiresIn: '30d' },
  );
  assert.deepEqual(verifyCampaignReserveToken(foreign), { ok: false, reason: 'invalid' });
});

test('campaign-reserve: WRONG-PURPOSE token (e.g. member-session) → wrong-purpose', () => {
  // A validly-signed token but with a member-session shape — must NOT be accepted
  // as a campaign-reserve credential (confused-deputy guard).
  const memberish = jwt.sign(
    { type: 'member-session', consumerId: 'recB', email: 'a@b.co' },
    SECRET,
    { expiresIn: '30d' },
  );
  assert.deepEqual(verifyCampaignReserveToken(memberish), { ok: false, reason: 'wrong-purpose' });

  // A deposit-grant token also must not pass as a campaign-reserve token.
  const grant = mintDepositGrantToken({ consumerId: 'recB', referralId: 'recRef' });
  assert.deepEqual(verifyCampaignReserveToken(grant), { ok: false, reason: 'wrong-purpose' });
});

test('campaign-reserve: over-long token rejected pre-verify', () => {
  const huge = 'x'.repeat(5000);
  assert.deepEqual(verifyCampaignReserveToken(huge), { ok: false, reason: 'invalid' });
});

// ---------------------------------------------------------------------------
// Deposit-grant token: roundtrip + referral scoping
// ---------------------------------------------------------------------------

test('deposit-grant: mint → verify roundtrip', () => {
  const token = mintDepositGrantToken({ consumerId: 'recB', referralId: 'recRef1' });
  const res = verifyDepositGrantToken(token);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.payload.purpose, DEPOSIT_GRANT_PURPOSE);
    assert.equal(res.payload.consumerId, 'recB');
    assert.equal(res.payload.referralId, 'recRef1');
  }
});

test('deposit-grant: scoped verify ACCEPTS the matching referralId', () => {
  const token = mintDepositGrantToken({ consumerId: 'recB', referralId: 'recRef1' });
  const res = verifyDepositGrantToken(token, 'recRef1');
  assert.equal(res.ok, true);
});

test('deposit-grant: scoped verify REJECTS a different referralId (cross-referral)', () => {
  const token = mintDepositGrantToken({ consumerId: 'recB', referralId: 'recRef1' });
  const res = verifyDepositGrantToken(token, 'recRefOTHER');
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'wrong-purpose');
});

test('deposit-grant: a campaign-reserve token is NOT accepted as a grant', () => {
  const campaign = mintCampaignReserveToken({ consumerId: 'recB', rancherSlug: 'foo', cut: 'half' });
  assert.deepEqual(verifyDepositGrantToken(campaign), { ok: false, reason: 'wrong-purpose' });
});

test('deposit-grant: expired grant → invalid', () => {
  const expired = jwt.sign(
    { purpose: DEPOSIT_GRANT_PURPOSE, consumerId: 'recB', referralId: 'recRef1' },
    SECRET,
    { expiresIn: '-10s' },
  );
  assert.deepEqual(verifyDepositGrantToken(expired, 'recRef1'), { ok: false, reason: 'invalid' });
});

test('deposit-grant: mint rejects missing fields', () => {
  assert.throws(() => mintDepositGrantToken({ consumerId: '', referralId: 'r' }));
  assert.throws(() => mintDepositGrantToken({ consumerId: 'c', referralId: '' }));
});

// ---------------------------------------------------------------------------
// decideCampaignRedirect — the testable core of the /r/d route
// ---------------------------------------------------------------------------

const okVerify: VerifyResult<CampaignReservePayload> = {
  ok: true,
  payload: { purpose: CAMPAIGN_RESERVE_PURPOSE, consumerId: 'recB', rancherSlug: 'renick-valley', cut: 'half' },
};

test('decide: valid token + resolved referral → deposit path with cut pre-selected', () => {
  const d = decideCampaignRedirect(okVerify, { referralId: 'recRefX' }, 'renick-valley');
  assert.equal(d.kind, 'deposit');
  if (d.kind === 'deposit') {
    assert.equal(d.path, '/checkout/recRefX/deposit?cut=half');
    assert.equal(d.referralId, 'recRefX');
    assert.equal(d.consumerId, 'recB');
  }
});

// Covers BOTH "referral I/O failed" AND "rancher ineligible" — in both cases
// findOrCreateCampaignReferral returns ok:false so the route passes resolved=null,
// and the buyer must land on the rancher's OWN public page (not a dead referral).
test('decide: valid token but referral unresolved (ineligible / I/O fail) → rancher public page', () => {
  const d = decideCampaignRedirect(okVerify, null, 'renick-valley');
  assert.equal(d.kind, 'fallback');
  if (d.kind === 'fallback') assert.equal(d.path, '/ranchers/renick-valley');
});

test('decide: invalid token → fallback to slugForFallback (generic when unknown)', () => {
  const bad: VerifyResult<CampaignReservePayload> = { ok: false, reason: 'invalid' };
  assert.deepEqual(decideCampaignRedirect(bad, null, 'some-ranch'), {
    kind: 'fallback',
    path: '/ranchers/some-ranch',
  });
  // No slug known at all → generic storefront, never a broken/empty path.
  assert.deepEqual(decideCampaignRedirect(bad, null), { kind: 'fallback', path: '/ranchers' });
});

test('rancherPublicPath: builds storefront path, generic on empty', () => {
  assert.equal(rancherPublicPath('renick-valley'), '/ranchers/renick-valley');
  assert.equal(rancherPublicPath(''), '/ranchers');
  assert.equal(rancherPublicPath('  '), '/ranchers');
});
