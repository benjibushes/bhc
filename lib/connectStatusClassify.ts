// lib/connectStatusClassify.ts
//
// Pure status-classification for a Stripe Connect (V2) account, split out of
// lib/stripeConnect.ts so it has ZERO imports (no Stripe client, no secrets
// chain) and can be unit-tested under the repo's standard `npm test` harness
// (which sets only JWT_SECRET). lib/stripeConnect.ts re-exports these.

export type ConnectAccountStatus = 'not_connected' | 'onboarding' | 'active' | 'restricted';

/**
 * Inputs to the status classifier, pulled straight off a V2 account retrieve.
 * Kept as a flat shape (not the raw Stripe object) so the mapping is pure and
 * unit-testable in isolation — no Stripe client, no network.
 */
export interface ConnectStatusSignals {
  /** configuration.merchant.capabilities.card_payments.status === 'active' */
  cardPaymentsActive: boolean;
  /** requirements.summary.minimum_deadline.status (or null) */
  requirementsStatus: string | null;
  /** requirements.summary.disabled_reason (or null) — set when Stripe has
   *  disabled charges/payouts for an account that needs attention. */
  disabledReason?: string | null;
  /** Whether the account can currently accept charges. On V2 this is reflected
   *  by the card_payments capability; we accept an explicit flag too so a
   *  charges_enabled-style signal can drive the classification. */
  chargesEnabled?: boolean;
  /** requirements.summary.currently_due length (or count) — non-empty means
   *  Stripe is still actively blocking on missing info. */
  currentlyDueCount?: number;
}

/**
 * Pure status mapping for a Stripe Connect (V2) account.
 *
 * Rules:
 *   - 'active'     = card payments active AND onboarding complete (no
 *                    currently_due / past_due requirements).
 *   - 'restricted' = charges are NOT enabled AND Stripe is signalling a
 *                    problem — either a disabled_reason is present, the
 *                    requirements are past_due, or there are still
 *                    currently_due items. This is the "can't take money,
 *                    needs the rancher to act" state.
 *   - 'onboarding' = everything else (account exists, no hard block yet —
 *                    e.g. brand-new account still being set up).
 *
 * IMPORTANT for callers: anything != 'active' must continue to close the
 * deposit gate. Reclassifying more states as 'restricted' (vs 'onboarding')
 * is therefore safe for money — it only sharpens the display/state signal.
 */
export function classifyConnectStatus(signals: ConnectStatusSignals): {
  status: ConnectAccountStatus;
  onboardingComplete: boolean;
} {
  const reqStatus = signals.requirementsStatus ?? null;
  const onboardingComplete = reqStatus !== 'currently_due' && reqStatus !== 'past_due';

  // chargesEnabled defaults to the card_payments capability when not given,
  // so V2 accounts (which expose card_payments) classify correctly even
  // without an explicit charges_enabled flag.
  const chargesEnabled =
    typeof signals.chargesEnabled === 'boolean'
      ? signals.chargesEnabled
      : signals.cardPaymentsActive;

  if (signals.cardPaymentsActive && onboardingComplete) {
    return { status: 'active', onboardingComplete };
  }

  // Charges can't run AND Stripe is flagging a reason / outstanding work →
  // restricted (rather than the softer 'onboarding'). Previously only an
  // exactly-past_due requirements status produced 'restricted', so a
  // charges-disabled account with a disabled_reason or lingering
  // currently_due items mislabeled itself 'onboarding' and looked like a
  // fresh signup instead of a blocked one.
  const hasDisabledReason = !!(signals.disabledReason && String(signals.disabledReason).trim());
  const hasCurrentlyDue =
    (typeof signals.currentlyDueCount === 'number' && signals.currentlyDueCount > 0) ||
    reqStatus === 'currently_due';
  if (!chargesEnabled && (hasDisabledReason || reqStatus === 'past_due' || hasCurrentlyDue)) {
    return { status: 'restricted', onboardingComplete };
  }

  return { status: 'onboarding', onboardingComplete };
}

/**
 * Routing hint: can this non-active account be resumed with a fresh Stripe
 * onboarding account-link? True when Stripe still has outstanding KYC
 * requirements (currently_due / past_due / any currently_due count) OR the
 * account is simply mid-onboarding — all cases a hosted onboarding link
 * resolves. This is the self-serve fix for ranchers stuck mid-KYC (missing
 * bank / unaccepted TOS).
 *
 * False for an 'active' account (nothing to resume) and for a 'restricted'
 * account whose block is NOT requirements-driven (e.g. a Stripe-side hold) —
 * those need the portal / support, not another onboarding loop.
 *
 * Pure + zero-import so the dashboard banner and billing page can rely on a
 * unit-tested routing decision. Does NOT affect the deposit gate (status alone
 * drives that).
 */
export function canResumeConnectOnboarding(
  status: ConnectAccountStatus,
  signals: Pick<ConnectStatusSignals, 'requirementsStatus' | 'currentlyDueCount'>,
): boolean {
  if (status === 'active' || status === 'not_connected') return false;
  if (status === 'onboarding') return true;
  // status === 'restricted' → only resumable if the block is requirements-driven.
  const reqStatus = signals.requirementsStatus ?? null;
  const dueCount =
    typeof signals.currentlyDueCount === 'number' ? signals.currentlyDueCount : 0;
  return reqStatus === 'currently_due' || reqStatus === 'past_due' || dueCount > 0;
}
