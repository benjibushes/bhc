// lib/depositRequestStamp.ts
//
// Mark a Referral as "a deposit is in flight" when the BUYER mints the Stripe
// Checkout Session themselves (the self-serve Connect rail), matching what the
// rancher/admin request routes already stamp when THEY ask for the deposit.
//
// THE GAP (2026-08-19). Three routes stamp `Deposit Requested At`:
//   app/api/admin/send-deposit-invoice, app/api/checkout/broker, and
//   app/api/rancher/referrals/[id]/request-deposit.
// The main self-serve rail — app/api/checkout/deposit POST — stamped nothing
// on the Referral. Money still worked (two live buyers paid through it with no
// stamp), but the deal was invisible as an outstanding ask:
//   - the strong chase query
//     AND({Status}="Awaiting Payment", NOT({Deposit Requested At}=""),
//         {Deposit Paid At}="")
//     never matched it, so it fell to a weaker fallback;
//   - owed-deposit reporting did not count it. A live $900 Whole-cow checkout
//     sat at Status 'Rancher Contacted' for two days and appeared in no
//     open-ask total.
// Across the whole payment history 4 of 5 referrals with payment activity
// carried no stamp.
//
// ⚠️ THE TWO WRITES ARE INSEPARABLE. lib/depositPaidState's decision table:
//
//   Awaiting Payment + Deposit Requested At + unpaid → NOT paid  → payable
//   Awaiting Payment + NO request stamp             → treated as PAID
//
// So writing `Status: 'Awaiting Payment'` WITHOUT `Deposit Requested At` makes
// the re-pay guard 409 the buyer "already paid" when they have paid nothing —
// exactly the 2026-07-14 bricked-buyer bug (8 deposits requested, 0 payable,
// because the emailed Stripe link dies at 24h and the durable page refused
// them). This module returns both keys or neither; never one.
//
// Pure + unit-tested. The route applies the patch best-effort AFTER the Stripe
// session and the Payments row both exist — a stamp failure must never block
// or reverse a charge.

export interface DepositStampReferral {
  Status?: unknown;
  'Deposit Requested At'?: unknown;
  'Deposit Paid At'?: unknown;
}

export interface DepositStampInput {
  cut: string;
  depositDollars: number;
  fullSaleDollars: number;
  checkoutUrl: string;
  nowISO: string;
}

/**
 * The Referral patch to write when a buyer mints their own deposit session,
 * or null when nothing should change.
 *
 * Returns null when the referral is ALREADY stamped: re-stamping would push
 * `Deposit Requested At` forward on every retry, which silently resets the
 * nudge cadence and the staleness clocks that chase the deal. The first ask is
 * the honest one.
 */
export function depositRequestStampFields(
  ref: DepositStampReferral | null | undefined,
  input: DepositStampInput,
): Record<string, unknown> | null {
  if (!ref) return null;

  // Already paid — the settle path owns the record from here.
  if (String(ref['Deposit Paid At'] ?? '').trim() !== '') return null;

  // Already marked as requested (a rancher/admin asked first, or this buyer
  // retried). Leave the original timestamp alone.
  if (String(ref['Deposit Requested At'] ?? '').trim() !== '') return null;

  const patch: Record<string, unknown> = {
    // BOTH keys, always together — see the header. Never split these.
    Status: 'Awaiting Payment',
    'Deposit Requested At': input.nowISO,
  };

  // Money fields mirror what the rancher request route writes, so the
  // downstream gates (accept, send-final-invoice) read the same shape
  // regardless of which rail asked for the deposit. Only write real numbers —
  // a 0 or NaN here would be a worse lie than an absent field.
  if (Number.isFinite(input.depositDollars) && input.depositDollars > 0) {
    patch['Deposit Amount'] = input.depositDollars;
  }
  if (Number.isFinite(input.fullSaleDollars) && input.fullSaleDollars > 0) {
    patch['Total Sale Amount'] = input.fullSaleDollars;
  }
  if (input.cut) patch['Order Type'] = input.cut;
  // The durable page the buyer can always come back to. Never a raw Stripe
  // URL — those expire at 24h.
  if (input.checkoutUrl && !/^https?:\/\/(checkout\.)?stripe\.com/i.test(input.checkoutUrl)) {
    patch['Deposit Checkout URL'] = input.checkoutUrl;
  }

  return patch;
}
