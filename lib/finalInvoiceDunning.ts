// lib/finalInvoiceDunning.ts
//
// Pure heal-or-skip decision for the final-invoice dunning cron (M2 / audit C3).
//
// THE MONEY-LOSER THIS GUARDS: final-invoice PaymentIntents are DIRECT charges
// on the rancher's connected account. If webhook settlement throws transiently
// at delivery time, the referral stays Status='Awaiting Payment' even though
// the buyer PAID — and the dunning cron would then email the paid buyer their
// still-live pay link AGAIN. Before any dunning touch, the cron retrieves the
// live PI on the connected account and routes through this decision:
//
//   'heal' — pi.status === 'succeeded': the buyer already paid. Settle the
//            stuck referral via settleFinalInvoice (idempotent: no-ops when
//            Status is already 'Closed Won') and NEVER send the reminder.
//   'dun'  — the PI is retrievable and definitively unpaid (requires_payment_method,
//            requires_confirmation, requires_action, canceled) — or, under the
//            Clover API's deferred-PI Checkout, the session is live with NO
//            PaymentIntent yet ('no_payment_intent': the buyer never submitted
//            payment). Only these states may email the buyer.
//   'skip' — payment state is UNKNOWN (retrieve failed, no status) OR the
//            payment is IN FLIGHT ('processing' e.g. ACH, 'requires_capture'
//            = funds already authorized). Never dun blind, never dun a buyer
//            whose money is already moving.
//
// Mirrors lib/routingPriority.ts: pure + side-effect-free + zero imports, so
// the colocated test chain never drags in lib/secrets.

export type FinalInvoiceDunningAction = 'heal' | 'dun' | 'skip';

// Sentinel piStatus the cron passes when the Checkout Session is retrievable
// and payment_status is 'unpaid' with no PaymentIntent attached — the Clover
// API defers PI creation to pay-time, so "no PI" = buyer never submitted
// payment = definitively dunnable.
export const NO_PAYMENT_INTENT: string = 'no_payment_intent';

// PI statuses where the buyer has ALREADY submitted payment but funds haven't
// settled ('processing' = ACH/delayed method in flight; 'requires_capture' =
// authorized, awaiting capture). Re-surfacing the pay link here risks a real
// double payment — treat like unknown and skip.
export const PAYMENT_IN_FLIGHT_PI_STATUSES: ReadonlySet<string> = new Set([
  'processing',
  'requires_capture',
]);

export function finalInvoiceDunningAction(input: {
  piStatus?: string | null;
}): FinalInvoiceDunningAction {
  const status = String(input.piStatus ?? '').trim();
  if (!status) return 'skip'; // unknown/error — never dun on unknown payment state
  if (status === 'succeeded') return 'heal';
  if (PAYMENT_IN_FLIGHT_PI_STATUSES.has(status)) return 'skip';
  return 'dun'; // retrievable + definitively not paid
}

/**
 * Recover the Checkout Session id from a stored `Final Invoice URL`
 * (https://checkout.stripe.com/c/pay/cs_…#fragment). Needed because under
 * apiVersion '2026-02-25.clover' the session's payment_intent is null at
 * create time, so `Final Invoice Payment Intent ID` is usually stamped empty —
 * the URL is the only durable pointer back to live Stripe payment state.
 */
export function parseCheckoutSessionIdFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  const m = url.match(/\b(cs_(?:live|test)_[A-Za-z0-9]+)/);
  return m ? m[1] : null;
}
