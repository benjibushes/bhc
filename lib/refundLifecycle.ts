// lib/refundLifecycle.ts
//
// Pure refund-lifecycle decisions (M3 / audit C2 + M4 / audit C4).
// Side-effect-free + import-clean (the ONLY import is lib/capacityCount,
// itself zero-dep) so lib/refundLifecycle.test.ts can run under `tsx --test`
// without dragging in lib/secrets — mirrors the lib/routingPriority.ts pattern.
//
// Four decisions live here:
//   1. refundReferralClearFields — the exact Referral update object a full
//      refund writes (lib/contracts/payments.ts restoreReferralAfterRefund).
//   2. canSendFinalInvoice — the send gate for the rancher final-invoice
//      route (app/api/rancher/referrals/[id]/send-final-invoice).
//   3. shouldDecrementOnRefundRestore — the capacity gate for the refund
//      restore path (C4: unconditional decrement double-freed the slot).
//   4. shouldDecrementOnClose — the capacity gate for every CLOSE path
//      (wave-2: gates were ACTIVE_REF_STATES-based or missing entirely,
//      drifting the counter both directions).
//
// The C2 bug both sides share: a refund left `Deposit Paid At` +
// `Rancher Accepted At` stamped, and the send gate ONLY checked
// `Deposit Paid At` — so a refunded buyer could still be emailed a
// `total − deposit` balance invoice for beef they never owed on.

import { HELD_REFERRAL_STATUSES } from './capacityCount';

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

/**
 * C4 capacity gate for the full-refund restore path
 * (lib/contracts/payments.ts restoreReferralAfterRefund).
 *
 * `priorStatus` is the Referral `Status` read BEFORE the flip to 'Refunded'.
 * Return true ONLY when that status still occupied a rancher slot — i.e. it
 * is in the canonical held set (HELD_REFERRAL_STATUSES, lib/capacityCount.ts:
 * Intro Sent / Rancher Contacted / Negotiation / Awaiting Payment /
 * Slot Locked). Flipping a held referral to 'Refunded' genuinely frees a
 * slot, so the counter must come down with it.
 *
 * 'Closed Won' → false. That is THE C4 bug: recordClose (lib/contracts/
 * rancher.ts) already decremented when the deal closed, so decrementing
 * again at refund time pushed the Redis-mirrored counter BELOW the true
 * held count and let the matcher over-book a genuinely-full rancher —
 * compounding on every close→refund cycle. Since the restore path today
 * only proceeds from 'Closed Won', this gate never fires on the current
 * reachable path; it exists so any future widening of the restore path
 * (e.g. refund-before-close) stays capacity-correct automatically.
 *
 * Unknown / empty / non-held statuses → false. Safe default: a wrong skip
 * self-heals on the next ground-truth reseed (liveHeldCountForRancher), while a
 * wrong decrement silently over-books a full rancher. Never drift down on
 * uncertainty.
 */
export function shouldDecrementOnRefundRestore(priorStatus: unknown): boolean {
  const s = String(priorStatus ?? '').trim();
  if (!s) return false;
  return HELD_REFERRAL_STATUSES.has(s);
}

/**
 * Wave-2 capacity gate for EVERY close-path DECR — recordClose
 * (lib/contracts/rancher.ts), the rancher dashboard PATCH + pass action
 * (app/api/rancher/referrals/[id]/route.ts), and the admin PATCH
 * (app/api/referrals/[id]/route.ts). Mirror of shouldDecrementOnRefundRestore:
 * for any prior status, shouldDecrementOnClose(prior, 'Refunded') ≡
 * shouldDecrementOnRefundRestore(prior) — one held-set, one answer.
 *
 * A slot frees exactly when the referral LEAVES the canonical held set
 * (HELD_REFERRAL_STATUSES, lib/capacityCount.ts — the same set the
 * ground-truth reseed counts):
 *
 *   prevStatus ∈ HELD  AND  nextStatus ∉ HELD  →  true (DECR)
 *
 * What that kills, per direction of drift:
 *   - prev 'Pending Approval' → false. Pre-INCR (the INCR fires at Intro
 *     Sent) — closing from it gave back a slot never taken → counter drifted
 *     DOWN → matcher over-booked full ranchers. (Old ACTIVE_REF_STATES
 *     included it.)
 *   - prev 'Awaiting Payment' / 'Slot Locked' → true. Old ACTIVE_REF_STATES
 *     excluded them, so those closes skipped the DECR → counter drifted UP →
 *     phantom-full ranchers stopped routing.
 *   - prev terminal ('Closed Won'/'Closed Lost'/'Refunded') or same-status
 *     repeat → false. Re-edits, double clicks, and webhook redelivery never
 *     double-free.
 *   - next ∈ HELD (e.g. Negotiation → Awaiting Payment) → false. The slot is
 *     STILL held per canon — an entry-DECR would drift the mirror DOWN until
 *     the next reseed clobbered it back up. Held→held reshuffles free nothing;
 *     the DECR fires once, at the real terminal close.
 *
 * Empty/unknown prev OR next → false. Same safe default as the refund gate:
 * a wrong skip self-heals on the next ground-truth reseed
 * (liveHeldCountForRancher); a wrong decrement silently over-books. Never
 * drift down on uncertainty.
 */
export function shouldDecrementOnClose(prevStatus: unknown, nextStatus: unknown): boolean {
  const prev = String(prevStatus ?? '').trim();
  if (!prev || !HELD_REFERRAL_STATUSES.has(prev)) return false;
  const next = String(nextStatus ?? '').trim();
  if (!next || HELD_REFERRAL_STATUSES.has(next)) return false;
  return true;
}
