// lib/onboardingFlow.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STEP_FLOW,
  nextStep,
  prevStep,
  remapSavedStep,
  flowIndexOf,
  shouldAutoSelectFreeTier,
} from './onboardingFlow';

// ── STEP_FLOW — the canonical order ─────────────────────────────────────────

test('STEP_FLOW is the unified order: intro, contact, brand, sell, fulfillment, bank, sign, done', () => {
  assert.deepEqual(STEP_FLOW, [0, 1, 2, 3, 8, 9, 5, 6]);
});

test('STEP_FLOW no longer contains the call step (4) or the plan step (7)', () => {
  assert.equal(STEP_FLOW.includes(4 as any), false);
  assert.equal(STEP_FLOW.includes(7 as any), false);
});

// ── nextStep / prevStep ─────────────────────────────────────────────────────

test('nextStep walks the flow in order for every member', () => {
  assert.equal(nextStep(0), 1);
  assert.equal(nextStep(1), 2);
  assert.equal(nextStep(2), 3);
  assert.equal(nextStep(3), 8);
  assert.equal(nextStep(8), 9);
  assert.equal(nextStep(9), 5);
  assert.equal(nextStep(5), 6);
  assert.equal(nextStep(6), 6); // terminal — never walks off the end
});

test('nextStep from the off-flow steps rejoins the road', () => {
  assert.equal(nextStep(4), 1); // call step continues into contact (today's behavior)
  assert.equal(nextStep(7), 9); // plan deep-link continues into Connect (today's behavior)
});

test('prevStep walks backward and never leaves the flow', () => {
  assert.equal(prevStep(6), 5);
  assert.equal(prevStep(5), 8); // back from sign SKIPS Connect — a legacy rancher
  // sent back to 9 would bounce forward off the auto-advance (ping-pong trap)
  assert.equal(prevStep(9), 8);
  assert.equal(prevStep(8), 3);
  assert.equal(prevStep(3), 2);
  assert.equal(prevStep(1), 0);
  assert.equal(prevStep(0), 0);
});

// ── remapSavedStep — resume safety for mid-flight ranchers ──────────────────

test('remapSavedStep keeps EVERY in-flow step as-is, 9 included', () => {
  for (const s of STEP_FLOW) {
    assert.equal(remapSavedStep(s), s);
  }
});

test('remapSavedStep: a rancher parked at the removed plan step resumes at pricing', () => {
  assert.equal(remapSavedStep(7), 3);
});

test('remapSavedStep: the optional call step survives (still reachable)', () => {
  assert.equal(remapSavedStep(4), 4);
});

// ── step 9 resume — the Connect-abandonment trap ────────────────────────────
//
// Stripe Connect (9) is the likeliest place in the whole flow for a rancher to
// stop and come back. Under the CURRENT road (…3 → 8 → 9 → 5) a saved 9 means
// fulfillment is already behind them, so the old blanket 9→8 remap demoted
// every returning rancher a step. These pin both directions.

test('CURRENT-flow rancher who abandoned at Connect resumes AT Connect, never backward', () => {
  assert.equal(remapSavedStep(9), 9);
  assert.equal(remapSavedStep(9, {}), 9);
  assert.equal(remapSavedStep(9, { fulfillmentDone: true }), 9);
});

test('LEGACY-flow rancher (saved 9, fulfillment never done) is routed through 8 first', () => {
  // Old order was …3 → 7 → 9 → 8 → 5, so a saved 9 there meant the rancher had
  // NOT done fulfillment. Resuming at 9 would skip it and buyers would see an
  // empty Fulfillment section. Only a POSITIVE "fulfillment is missing" signal
  // triggers this — step 8 refuses to continue without a fulfillment type, so a
  // current-road rancher at 9 can never look like this.
  assert.equal(remapSavedStep(9, { fulfillmentDone: false }), 8);
});

test('legacy saved values still migrate: 7 → 3, 4 → 4, and 8 stays 8', () => {
  assert.equal(remapSavedStep(7), 3);
  assert.equal(remapSavedStep(4), 4);
  assert.equal(remapSavedStep(8), 8);
  // The fulfillment hint is scoped to step 9 — it must not perturb anything else.
  assert.equal(remapSavedStep(7, { fulfillmentDone: false }), 3);
  assert.equal(remapSavedStep(8, { fulfillmentDone: false }), 8);
  assert.equal(remapSavedStep(5, { fulfillmentDone: false }), 5);
});

test('remapSavedStep: garbage restores to the start', () => {
  assert.equal(remapSavedStep(99), 0);
  assert.equal(remapSavedStep(-1), 0);
  assert.equal(remapSavedStep(NaN), 0);
});

// ── flowIndexOf — progress display ──────────────────────────────────────────

test('flowIndexOf gives the display position; off-flow steps borrow a neighbor', () => {
  assert.equal(flowIndexOf(0), 0);
  assert.equal(flowIndexOf(3), 3);
  assert.equal(flowIndexOf(6), 7);
  assert.equal(flowIndexOf(4), 0); // call shows as part of the intro stage
  assert.equal(flowIndexOf(7), 4); // plan deep-link shows at the bank stage boundary
});

// ── shouldAutoSelectFreeTier — the silent-conversion guard ──────────────────
//
// The free plan flips 'Pricing Model' to tier_v2 server-side. That flip must
// ONLY happen for a rancher still setting up — a LIVE legacy rancher who
// merely opens their 60-day setup link must never be silently converted and
// dropped from the routing pool (this exact bug shipped before — see
// RancherSetupWizard tier auto-select landmine).

const freshApplicant = () => ({
  'Pricing Model': 'legacy',
  'Active Status': '',
  'Page Live': false,
  'Agreement Signed': false,
}) as any;

test('fresh applicant (legacy default, nothing live) → auto-select', () => {
  assert.equal(shouldAutoSelectFreeTier(freshApplicant()), true);
});

test('already tier_v2 → no-op (nothing to select)', () => {
  assert.equal(shouldAutoSelectFreeTier({ ...freshApplicant(), 'Pricing Model': 'tier_v2' }), false);
});

test('LIVE legacy rancher (Active) → NEVER auto-convert', () => {
  assert.equal(shouldAutoSelectFreeTier({ ...freshApplicant(), 'Active Status': 'Active' }), false);
});

test('page-live legacy rancher → NEVER auto-convert', () => {
  assert.equal(shouldAutoSelectFreeTier({ ...freshApplicant(), 'Page Live': true }), false);
});

test('signed legacy rancher → NEVER auto-convert (their agreement locked a legacy deal)', () => {
  assert.equal(shouldAutoSelectFreeTier({ ...freshApplicant(), 'Agreement Signed': true }), false);
});

test('Active Status as a {name} object (Airtable singleSelect shape) is honored', () => {
  assert.equal(
    shouldAutoSelectFreeTier({ ...freshApplicant(), 'Active Status': { name: 'Active' } }),
    false,
  );
});

test('Paused legacy rancher who never signed → still eligible (they are mid-setup)', () => {
  assert.equal(shouldAutoSelectFreeTier({ ...freshApplicant(), 'Active Status': 'Paused' }), true);
});

test('null/undefined rancher → false (never fire on missing data)', () => {
  assert.equal(shouldAutoSelectFreeTier(null), false);
  assert.equal(shouldAutoSelectFreeTier(undefined), false);
});

// The wizard's GET /api/rancher/setup response has NO 'Active Status' and
// exposes signed/live state ONLY as camelCase agreementSigned/pageLive/
// onboardingStatus. The guard must fail closed on BOTH shapes — a live
// rancher must never look eligible just because the raw field is absent.

test('camelCase wizard shape: pageLive true → NEVER auto-convert', () => {
  assert.equal(
    shouldAutoSelectFreeTier({ 'Pricing Model': 'legacy', pageLive: true } as any),
    false,
  );
});

test('camelCase wizard shape: agreementSigned true → NEVER auto-convert', () => {
  assert.equal(
    shouldAutoSelectFreeTier({ 'Pricing Model': 'legacy', agreementSigned: true } as any),
    false,
  );
});

test('camelCase wizard shape: onboardingStatus Live → NEVER auto-convert', () => {
  assert.equal(
    shouldAutoSelectFreeTier({ 'Pricing Model': 'legacy', onboardingStatus: 'Live' } as any),
    false,
  );
});

test('camelCase wizard shape: fresh applicant (all falsy) → eligible', () => {
  assert.equal(
    shouldAutoSelectFreeTier({
      'Pricing Model': 'legacy',
      agreementSigned: false,
      pageLive: false,
      onboardingStatus: 'Docs Sent',
    } as any),
    true,
  );
});
