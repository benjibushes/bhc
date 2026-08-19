// lib/paymentCapture.ts
//
// THE ONE DEFINITION of "what was this buyer's card actually charged".
//
// WHY THIS MODULE EXISTS (data-layer audit P0-1, 2026-08-18). This arithmetic
// used to live inside lib/contracts/payments.ts, which imports lib/airtable,
// lib/telegram, lib/rancherCapacity and lib/auditLog. The two PURE read
// surfaces that need the same answer — lib/depositSla (documented Airtable-
// free so the SLA cron's decision logic unit-tests without a base) and
// lib/obligations (documented "PURE — no IO, no env, no Date.now()") — could
// not import it without dragging that whole graph in, so each hand-rolled its
// own `deposit + fee` and BOTH got the broker rail wrong.
//
// This module is hermetic: its only import is lib/brokerRail (itself importing
// only lib/pricing), so every reader — I/O path or pure selector — can share
// one definition. lib/contracts/payments re-exports both symbols so existing
// call sites and their pins are unchanged.
//
// THE BUG THE SHARING CLOSES. recordBrokerDeposit writes the SAME number into
// both `Amount Cents` and `Platform Fee Cents` on purpose: on the broker rail
// the deposit IS the commission — the same dollars seen from two sides. Any
// reader that sums them reads a broker charge as 2x. Downstream that means a
// refund of the entire real charge measures as merely PARTIAL, so
// isMoneyReturnedToBuyer stays false: the obligation never clears, outreach
// never pauses, and the ranch's capacity slot is held forever.

import { BROKER_PAYMENT_TYPE } from './brokerRail';

/**
 * Is this Payments row a BROKER-rail deposit?
 *
 * The discriminator is the ledger's own `Type` marker, written by
 * recordBrokerDeposit and by nothing else — recordDeposit (Connect) leaves the
 * field unset entirely, so this is exact in both directions. Preferred over
 * joining back to the rancher: the row is the thing being refunded, and the
 * rancher record can be edited (or unreadable) long after the charge.
 *
 * Tolerates Airtable's `{name}` singleSelect object form. Fails CLOSED — an
 * unreadable or absent Type is Connect, the rail whose refund path is
 * unchanged.
 */
export function isBrokerPaymentRow(payment: any): boolean {
  const raw = payment?.['Type'] ?? payment?.type ?? '';
  const value =
    raw && typeof raw === 'object' && 'name' in raw ? String((raw as any).name || '') : String(raw || '');
  return value.trim() === BROKER_PAYMENT_TYPE;
}

/**
 * What the buyer's card was ACTUALLY charged on this Payments row, in cents.
 * The ceiling every refund is capped against, and the number a "full refund"
 * is measured against.
 *
 * RAIL-AWARE, and it has to be:
 *   • CONNECT deposit — 'Amount Cents' is the deposit and 'Platform Fee Cents'
 *     is BHC's fee charged ON TOP of it. The card total is their SUM.
 *   • BROKER deposit — recordBrokerDeposit writes the SAME number into BOTH
 *     fields on purpose (the deposit IS the commission, the same dollars seen
 *     from two sides). Summing them DOUBLES the captured total, so a refund of
 *     the entire real charge reads as merely partial: no restore runs, the
 *     referral stays 'Awaiting Payment' with a stale Deposit Paid At, and the
 *     ranch's capacity slot is held forever.
 *
 * 'Total Charged Cents' — stamped at settlement on both rails — wins whenever
 * it is present. The field arithmetic is only the fallback for rows settled
 * before that field existed. Connect behaviour is byte-identical to the
 * inline chain this replaced.
 *
 * Returns 0 for a row carrying no amounts at all; callers that have a
 * non-ledger fallback (lib/obligations' Referral `Deposit Amount`) treat 0 as
 * "the ledger cannot answer" and fall back.
 */
export function capturedTotalCents(payment: any): number {
  const depositCents = Number(payment?.['Amount Cents'] || 0);
  const platformFeeCents = Number(payment?.['Platform Fee Cents'] || 0);
  const totalChargedCents = Number(payment?.['Total Charged Cents'] || 0);
  if (totalChargedCents > 0) return totalChargedCents;
  if (isBrokerPaymentRow(payment)) return depositCents;
  return (depositCents + platformFeeCents) || depositCents;
}
