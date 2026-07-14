// lib/depositPaidState.ts
//
// THE re-pay guard truth for the buyer deposit page (GET + POST
// /api/checkout/deposit). Pure + unit-tested (lib/depositPaidState.test.ts).
//
// WHY THIS EXISTS (2026-07-14 — the bricked-buyer bug): 'Awaiting Payment' is
// OVERLOADED (see lib/confirmPaymentGuard.ts). The settle webhook stamps
// {Status:'Awaiting Payment', Deposit Paid At} on payment — but the rancher
// "Request Deposit" flow ALSO stamps Status:'Awaiting Payment' at REQUEST
// time, before the buyer has paid a cent. The old guard treated bare
// Status==='Awaiting Payment' as paid, so the moment a rancher requested a
// deposit, the on-domain deposit page 409'd "already paid" for a buyer who
// had paid NOTHING — and since the emailed Stripe-hosted link expires in 24h,
// every payment path was dead. 8 requested deposits, 0 paid.
//
// The disambiguator is confirmPaymentGuard's: a REQUESTED-but-UNPAID deposit
// is uniquely {Deposit Requested At set, Deposit Paid At empty} → payable.
//
// Decision table:
//   Deposit Paid At set                → paid (authoritative date field,
//                                        immune to select-option stripping)
//   Status 'Slot Locked'               → paid (post-accept state; accept gates
//                                        on Deposit Paid At — U18)
//   Status 'Awaiting Payment' +
//     pending request (req'd, unpaid)  → NOT paid — the buyer must be able to
//                                        pay through the durable page
//   Status 'Awaiting Payment', no
//     request stamp                    → paid (legacy settle rows whose
//                                        Deposit Paid At was hand-stripped;
//                                        preserves the old redundancy)
//   anything else                      → not paid

import { hasPendingStripeDeposit } from './confirmPaymentGuard';

export interface DepositPaidStateFields {
  Status?: unknown;
  'Deposit Paid At'?: unknown;
  'Deposit Requested At'?: unknown;
}

export function isDepositAlreadyPaid(ref: DepositPaidStateFields | null | undefined): boolean {
  if (!ref) return false;
  const paidAt = String(ref['Deposit Paid At'] ?? '').trim();
  if (paidAt !== '') return true;
  const status = String(ref.Status ?? '').trim();
  if (status === 'Slot Locked') return true;
  if (status === 'Awaiting Payment') {
    // Requested-but-unpaid = an outstanding deposit link → payable, not paid.
    return !hasPendingStripeDeposit(ref as { 'Deposit Requested At'?: unknown; 'Deposit Paid At'?: unknown });
  }
  return false;
}
