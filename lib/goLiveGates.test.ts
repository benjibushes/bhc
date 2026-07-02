import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  goLiveGates,
  isAlreadyLive,
  isReadyToGoLive,
  goLiveBlockersView,
  GO_LIVE_FIELDS,
} from './goLiveGates';

// ─── goLiveGates: the ONE go-live gate every rail must pass ────────────────
// Pins the 2×2 half-rail fix: POST /go-live gated Connect but never Agreement;
// PATCH "Mark Live" gated NOTHING. These tests define the unified contract:
//   1. Agreement Signed truthy      — unsigned rancher can't route (matching
//      requires Agreement Signed) → "Live" with zero buyers.
//   2. tier_v2 → Connect 'active'   — otherwise Live but can't collect money.
//      Legacy ranchers are EXEMPT (off-platform Payment Links).
//   3. Onboarding not 'Verification Pending' — an in-flight verification
//      review must not be silently skipped by a Live flip.
// force=true overrides ALL gates (operator escape hatch).

test('unsigned rancher → agreement_not_signed', () => {
  const res = goLiveGates({
    'Operator Name': 'Test Ranch',
    'Agreement Signed': false,
    'Pricing Model': 'tier_v2',
    'Stripe Connect Status': 'active',
    'Onboarding Status': 'Verification Complete',
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 'agreement_not_signed');
    assert.match(res.message, /agreement/i);
  }
});

test('tier_v2 + signed + Connect onboarding → connect_not_active', () => {
  const res = goLiveGates({
    'Operator Name': 'Test Ranch',
    'Agreement Signed': true,
    'Pricing Model': 'tier_v2',
    'Stripe Connect Status': 'onboarding',
    'Onboarding Status': 'Verification Complete',
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 'connect_not_active');
    assert.match(res.message, /Stripe Connect/);
  }
});

test('tier_v2 + signed + Connect unset → connect_not_active', () => {
  const res = goLiveGates({
    'Agreement Signed': true,
    'Pricing Model': 'tier_v2',
    'Onboarding Status': 'Verification Complete',
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'connect_not_active');
});

test('legacy + unsigned → agreement_not_signed (agreement gate fires first)', () => {
  const res = goLiveGates({
    'Agreement Signed': false,
    'Pricing Model': 'legacy',
    'Onboarding Status': 'Docs Sent',
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'agreement_not_signed');
});

test('legacy + signed → ok (NO Connect gate for legacy)', () => {
  // Legacy ranchers collect off-platform via Payment Links — a missing or
  // non-active Stripe Connect Status must NOT block their go-live.
  const res = goLiveGates({
    'Agreement Signed': true,
    'Pricing Model': 'legacy',
    'Stripe Connect Status': 'onboarding',
    'Onboarding Status': 'Verification Complete',
  });
  assert.equal(res.ok, true);
});

test('unset Pricing Model treated as legacy → ok when signed', () => {
  const res = goLiveGates({
    'Agreement Signed': true,
    'Onboarding Status': 'Verification Complete',
  });
  assert.equal(res.ok, true);
});

test('tier_v2 + signed + Connect active → ok', () => {
  const res = goLiveGates({
    'Agreement Signed': true,
    'Pricing Model': 'tier_v2',
    'Stripe Connect Status': 'active',
    'Onboarding Status': 'Verification Complete',
  });
  assert.equal(res.ok, true);
});

test('signed but Verification Pending → verification_pending', () => {
  const res = goLiveGates({
    'Agreement Signed': true,
    'Pricing Model': 'legacy',
    'Onboarding Status': 'Verification Pending',
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 'verification_pending');
    assert.match(res.message, /verification/i);
  }
});

test('force=true overrides every gate', () => {
  // unsigned
  assert.equal(goLiveGates({ 'Agreement Signed': false }, true).ok, true);
  // tier_v2 + Connect not active
  assert.equal(
    goLiveGates(
      { 'Agreement Signed': true, 'Pricing Model': 'tier_v2', 'Stripe Connect Status': 'restricted' },
      true,
    ).ok,
    true,
  );
  // verification pending
  assert.equal(
    goLiveGates(
      { 'Agreement Signed': true, 'Onboarding Status': 'Verification Pending' },
      true,
    ).ok,
    true,
  );
});

test('Airtable single-select object form ({name}) is read correctly', () => {
  const res = goLiveGates({
    'Agreement Signed': true,
    'Pricing Model': 'legacy',
    'Onboarding Status': { name: 'Verification Pending' },
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'verification_pending');
});

// ─── isAlreadyLive: helper-level idempotence predicate ─────────────────────

test('isAlreadyLive: Live + Active + Page Live → true', () => {
  assert.equal(
    isAlreadyLive({
      'Onboarding Status': 'Live',
      'Active Status': 'Active',
      'Page Live': true,
    }),
    true,
  );
});

test('isAlreadyLive: Live + Active but Page Live false → false (must converge)', () => {
  assert.equal(
    isAlreadyLive({
      'Onboarding Status': 'Live',
      'Active Status': 'Active',
      'Page Live': false,
    }),
    false,
  );
});

test('isAlreadyLive: Verification Complete → false', () => {
  assert.equal(
    isAlreadyLive({
      'Onboarding Status': 'Verification Complete',
      'Active Status': 'Active',
      'Page Live': true,
    }),
    false,
  );
});

// ─── GO_LIVE_FIELDS: the canonical 4-field union write ─────────────────────
// Union of what POST /go-live and PATCH "Mark Live" wrote between them.
// matching/suggest filters on Active Status; routing eligibility reads
// Onboarding Status; the public page reads Page Live; Status='Active'
// mirrors /api/rancher/activate.

test('GO_LIVE_FIELDS is exactly the 4-field union', () => {
  assert.deepEqual(GO_LIVE_FIELDS, {
    'Page Live': true,
    'Active Status': 'Active',
    'Onboarding Status': 'Live',
    'Status': 'Active',
  });
});

// ─── isReadyToGoLive / goLiveBlockersView: admin-UI predicate ──────────────
// snake_case adapter over the same gates — the UI must only OFFER Go Live
// when the server would accept it, so the button and the 409 never disagree.

test('isReadyToGoLive: signed legacy at Verification Complete → true', () => {
  assert.equal(
    isReadyToGoLive({
      agreement_signed: true,
      pricing_model: 'legacy',
      stripe_connect_status: '',
      onboarding_status: 'Verification Complete',
    }),
    true,
  );
});

test('isReadyToGoLive: tier_v2 with Connect onboarding → false', () => {
  assert.equal(
    isReadyToGoLive({
      agreement_signed: true,
      pricing_model: 'tier_v2',
      stripe_connect_status: 'onboarding',
      onboarding_status: 'Verification Complete',
    }),
    false,
  );
});

test('isReadyToGoLive: unsigned → false; Verification Pending → false', () => {
  assert.equal(
    isReadyToGoLive({ agreement_signed: false, onboarding_status: 'Verification Complete' }),
    false,
  );
  assert.equal(
    isReadyToGoLive({ agreement_signed: true, onboarding_status: 'Verification Pending' }),
    false,
  );
});

test('goLiveBlockersView lists human-readable blockers, empty when ready', () => {
  const blockers = goLiveBlockersView({
    agreement_signed: false,
    pricing_model: 'tier_v2',
    stripe_connect_status: 'onboarding',
    onboarding_status: 'Verification Pending',
  });
  assert.equal(blockers.length, 3);
  assert.deepEqual(
    goLiveBlockersView({
      agreement_signed: true,
      pricing_model: 'legacy',
      onboarding_status: 'Verification Complete',
    }),
    [],
  );
});
