import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyConnectStatus, canResumeConnectOnboarding } from './connectStatusClassify';

// ─── classifyConnectStatus: the deposit-gate truth ────────────────────────
// 'active' is the ONLY status that opens the deposit gate / lets a tier_v2
// rancher display as Live. Everything else (onboarding / restricted) must keep
// money gated. These tests pin the mapping so a charges-disabled-but-flagged
// account is classified 'restricted' (an accurate, actionable signal) instead
// of the softer 'onboarding' that made a blocked account look like a fresh one.

test("active = card payments active AND onboarding complete", () => {
  const { status, onboardingComplete } = classifyConnectStatus({
    cardPaymentsActive: true,
    requirementsStatus: null,
  });
  assert.equal(status, 'active');
  assert.equal(onboardingComplete, true);
});

test("NOT active when card payments active but requirements currently_due", () => {
  // Charges flagged active but Stripe still wants info → not done onboarding.
  const { status } = classifyConnectStatus({
    cardPaymentsActive: true,
    requirementsStatus: 'currently_due',
  });
  assert.notEqual(status, 'active');
});

test("past_due requirements with charges disabled → restricted (legacy case)", () => {
  const { status } = classifyConnectStatus({
    cardPaymentsActive: false,
    requirementsStatus: 'past_due',
  });
  assert.equal(status, 'restricted');
});

test("REGRESSION: charges disabled + disabled_reason (not past_due) → restricted, not onboarding", () => {
  // Pre-fix this fell through to 'onboarding' because reqStatus !== 'past_due'.
  // A disabled_reason means Stripe actively blocked the account — restricted.
  const { status } = classifyConnectStatus({
    cardPaymentsActive: false,
    requirementsStatus: null,
    disabledReason: 'requirements.past_due',
    chargesEnabled: false,
  });
  assert.equal(status, 'restricted');
});

test("REGRESSION: charges disabled + non-empty currently_due → restricted, not onboarding", () => {
  const { status } = classifyConnectStatus({
    cardPaymentsActive: false,
    requirementsStatus: 'currently_due',
    currentlyDueCount: 2,
    chargesEnabled: false,
  });
  assert.equal(status, 'restricted');
});

test("brand-new account: charges disabled, no reason, nothing due → onboarding", () => {
  // No disabled_reason, no currently_due, not past_due → genuinely still
  // setting up, not blocked. Stays the softer 'onboarding'.
  const { status } = classifyConnectStatus({
    cardPaymentsActive: false,
    requirementsStatus: null,
    disabledReason: null,
    currentlyDueCount: 0,
    chargesEnabled: false,
  });
  assert.equal(status, 'onboarding');
});

test("disabled_reason ignored once charges are enabled (no false restricted)", () => {
  // If charges are actually enabled we never want 'restricted' from a stale
  // disabled_reason; with onboarding complete this is 'active'.
  const { status } = classifyConnectStatus({
    cardPaymentsActive: true,
    requirementsStatus: null,
    disabledReason: 'something.stale',
    chargesEnabled: true,
  });
  assert.equal(status, 'active');
});

test("empty-string disabled_reason does not trigger restricted", () => {
  const { status } = classifyConnectStatus({
    cardPaymentsActive: false,
    requirementsStatus: null,
    disabledReason: '   ',
    currentlyDueCount: 0,
    chargesEnabled: false,
  });
  assert.equal(status, 'onboarding');
});

// ─── canResumeConnectOnboarding: the resume-routing truth ─────────────────
// Decides whether the dashboard banner / billing page sends a stuck rancher
// BACK into the Stripe onboarding link (clears bank/identity/TOS) vs the
// subscription portal. The 4 ranchers stuck mid-KYC (no bank / unaccepted TOS)
// MUST be resumable so they never dead-end in the wrong portal.

test("resume: active account is NOT resumable (nothing to finish)", () => {
  assert.equal(
    canResumeConnectOnboarding('active', { requirementsStatus: null, currentlyDueCount: 0 }),
    false,
  );
});

test("resume: not_connected is NOT resumable here (handled by first-start path)", () => {
  assert.equal(
    canResumeConnectOnboarding('not_connected', { requirementsStatus: null, currentlyDueCount: 0 }),
    false,
  );
});

test("resume: plain onboarding account IS resumable", () => {
  assert.equal(
    canResumeConnectOnboarding('onboarding', { requirementsStatus: null, currentlyDueCount: 0 }),
    true,
  );
});

test("resume: restricted w/ currently_due IS resumable (stuck-KYC: no bank / TOS)", () => {
  assert.equal(
    canResumeConnectOnboarding('restricted', { requirementsStatus: 'currently_due', currentlyDueCount: 2 }),
    true,
  );
});

test("resume: restricted w/ past_due IS resumable", () => {
  assert.equal(
    canResumeConnectOnboarding('restricted', { requirementsStatus: 'past_due', currentlyDueCount: 0 }),
    true,
  );
});

test("resume: restricted by count alone (no reqStatus) IS resumable", () => {
  assert.equal(
    canResumeConnectOnboarding('restricted', { requirementsStatus: null, currentlyDueCount: 3 }),
    true,
  );
});

test("resume: restricted with NO outstanding requirements is NOT resumable (→ portal/support)", () => {
  // e.g. a Stripe-side hold an onboarding link can't clear. Don't loop the
  // rancher pointlessly — route them to the portal/support instead.
  assert.equal(
    canResumeConnectOnboarding('restricted', { requirementsStatus: null, currentlyDueCount: 0 }),
    false,
  );
});

test("anything != active keeps deposit gate closed (sweep)", () => {
  // The deposit gate opens ONLY on 'active'. Confirm every non-active branch
  // produces a status that is not 'active'.
  const nonActiveInputs: Parameters<typeof classifyConnectStatus>[0][] = [
    { cardPaymentsActive: false, requirementsStatus: null },
    { cardPaymentsActive: false, requirementsStatus: 'currently_due' },
    { cardPaymentsActive: false, requirementsStatus: 'past_due' },
    { cardPaymentsActive: true, requirementsStatus: 'currently_due' },
    { cardPaymentsActive: false, requirementsStatus: null, disabledReason: 'x', chargesEnabled: false },
  ];
  for (const input of nonActiveInputs) {
    assert.notEqual(classifyConnectStatus(input).status, 'active');
  }
});
