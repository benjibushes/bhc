// lib/confirmPaymentGuard.ts
//
// Pure guard for the rancher "Confirm payment received" action
// (app/api/rancher/referrals/[id]/confirm-payment).
//
// WHY: the 'Awaiting Payment' status is OVERLOADED. It marks BOTH:
//   (a) a deal the rancher is closing OFF-PLATFORM (buyer paid cash / venmo /
//       check) — the legitimate target of the confirm-payment endpoint; and
//   (b) a deal with an OUTSTANDING Stripe deposit link — the rancher clicked
//       "Request Deposit" (request-deposit stamps Deposit Requested At + flips
//       Status to Awaiting Payment) and the buyer simply hasn't paid yet.
//
// Confirming (b) would close the deal — and, for legacy ranchers, fire a
// commission invoice — BEFORE the buyer paid a cent, and risks a double-charge
// if the buyer later clicks the still-live deposit link. A pending Stripe
// deposit is uniquely identifiable: Deposit Requested At set AND Deposit Paid
// At still empty (the Connect webhook stamps Deposit Paid At on settlement).

export interface ConfirmPaymentGuardFields {
  'Deposit Requested At'?: unknown;
  'Deposit Paid At'?: unknown;
}

/**
 * True when the referral has an outstanding (requested-but-unpaid) Stripe
 * deposit — in which case the manual "confirm payment received" action must be
 * rejected (the deposit confirms itself via the webhook when the buyer pays).
 */
export function hasPendingStripeDeposit(ref: ConfirmPaymentGuardFields): boolean {
  const requested = String(ref?.['Deposit Requested At'] ?? '').trim();
  const paid = String(ref?.['Deposit Paid At'] ?? '').trim();
  return requested !== '' && paid === '';
}
