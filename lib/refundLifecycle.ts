// lib/refundLifecycle.ts
//
// Pure refund-lifecycle decisions (M3 / audit C2). Side-effect-free +
// import-clean (NO imports at all) so lib/refundLifecycle.test.ts can run
// under `tsx --test` without dragging in lib/secrets — mirrors the
// lib/routingPriority.ts pattern.
//
// Two decisions live here:
//   1. refundReferralClearFields — the exact Referral update object a full
//      refund writes (lib/contracts/payments.ts restoreReferralAfterRefund).
//   2. canSendFinalInvoice — the send gate for the rancher final-invoice
//      route (app/api/rancher/referrals/[id]/send-final-invoice).
//
// The C2 bug both sides share: a refund left `Deposit Paid At` +
// `Rancher Accepted At` stamped, and the send gate ONLY checked
// `Deposit Paid At` — so a refunded buyer could still be emailed a
// `total − deposit` balance invoice for beef they never owed on.

/**
 * The Referral field updates for a full-refund restore. Airtable field names
 * are load-bearing — do not rename. All cleared fields are explicit `null`
 * (Airtable clears on null; nulling an already-null field is a safe no-op,
 * so webhook retries stay idempotent).
 */
export function refundReferralClearFields(
  refundedAtISO: string,
): Record<string, string | null> {
  return {
    'Status': 'Refunded',
    'Closed At': null,
    'Sale Amount': null,
    'Commission Due': null,
    'Commission Status': null,
    // C2 fix: a refund must fully reset the deposit/accept lifecycle. Leaving
    // these stamped let the send-final-invoice gate (!!Deposit Paid At) pass
    // for a refunded buyer, and blocked a clean re-deposit (NRD lock).
    'Deposit Paid At': null,
    'Rancher Accepted At': null,
    'Refunded At': refundedAtISO,
  };
}

/** Statuses in which a final invoice must NEVER be sent — the buyer owes nothing. */
export const FINAL_INVOICE_BLOCKED_STATUSES = ['Refunded', 'Closed Lost'] as const;

export type FinalInvoiceGate =
  | { ok: true }
  | { ok: false; reason: 'blocked-status' | 'deposit-unpaid'; message: string };

/**
 * Pure send gate for the rancher final-invoice route. Decides from Referral
 * `Status` + `Deposit Paid At` alone — no network, no Stripe. The route must
 * consult this BEFORE creating any Stripe session.
 */
export function canSendFinalInvoice(
  status: unknown,
  depositPaidAt: unknown,
): FinalInvoiceGate {
  // C2 status guard FIRST: a refunded (or closed-lost) referral may still
  // carry a stale `Deposit Paid At` stamp from before the refund landed —
  // the deposit gate alone would happily bill the full balance to a buyer
  // who owes nothing.
  const s = String(status ?? '');
  if ((FINAL_INVOICE_BLOCKED_STATUSES as readonly string[]).includes(s)) {
    return {
      ok: false,
      reason: 'blocked-status',
      message:
        s === 'Refunded'
          ? 'This referral was refunded — the buyer owes nothing, so a final invoice cannot be sent. If the buyer is coming back, have them place a new deposit first.'
          : 'This referral is Closed Lost — a final invoice cannot be sent on a dead deal.',
    };
  }

  // U18 deposit gate: Deposit Paid At is the only field stamped by actual
  // settlement — Status alone was unsafe (request-deposit flips it pre-payment).
  if (!depositPaidAt) {
    return {
      ok: false,
      reason: 'deposit-unpaid',
      message:
        'The deposit has to land before you can send the final invoice. Once the buyer completes their deposit, this unlocks automatically.',
    };
  }
  return { ok: true };
}
