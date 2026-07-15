// lib/referralLock.ts
//
// WORKING-LEAD LOCK (LOCK-1 2026-06-06)
//
// Defines the canonical set of Referral statuses that mean "the rancher is
// actively working this lead" — and therefore no auto-path is allowed to
// move, close, or re-route it.
//
// THE RULE
// --------
// If a Referral.Status ∈ LOCKED_STATUSES, then:
//   - Chasup cron MUST NOT auto-close it (alert operator instead)
//   - Stuck-buyer-recovery MUST NOT fire matching/suggest for the buyer
//   - Email-sequences MATCH_NOW MUST NOT route the buyer
//   - bulkRoute MUST NOT pick the buyer
//   - Quick-action "pass" MUST refuse w/ 409 (rancher was working — close
//     as Lost requires explicit reason)
//   - Admin reassign MUST require unlockOverride=true + unlockReason
//
// The pause workflow uses this same rule: pausing a rancher (Active Status
// = Paused / Disabled) blocks new matching/suggest picks but DOES NOT touch
// existing locked referrals. The rancher finishes what they started.
//
// HOW TO BREAK THE LOCK
// ---------------------
// Two paths, both audit-logged:
//   1. Buyer or rancher closes naturally (Closed Won / Closed Lost)
//   2. Operator explicit override via admin endpoint with unlockOverride=true
//      and an unlockReason ≥6 chars. Logged to Notes + Telegram.
//
// WHY THESE FOUR STATUSES
// -----------------------
// - Rancher Contacted: rancher has reached out to the buyer. They're investing
//   their time. Auto-moving the lead destroys that effort.
// - Negotiation: deal is in active discussion. Auto-moving creates buyer
//   confusion and rancher resentment.
// - Awaiting Payment: deposit is incoming or already paid. Auto-moving here
//   risks a chargeback or worse.
// - Slot Locked (Blocker-3 2026-07-01): the deposit has PAID and the slot is
//   held. This was missing from the set, so a 30-day-old quick-action Pass
//   link — or a corporate mail scanner prefetching it — could close a PAID
//   deal Lost, free the slot, and re-route the paying buyer toward a second
//   deposit. The strongest lock of all: money is in.
//
// Status='Intro Sent' is NOT locked — rancher hasn't engaged yet, fair game
// to reassign if buyer hasn't heard back from a real human.
// Status='Pending Approval' is NOT locked — that's a pre-route gate, not
// rancher engagement.
//
// COMPANION FIELDS
// ----------------
// `Last Rancher Activity At` (stamped by resend-inbound webhook on reply) is
// an additional signal but NOT the lock primitive. The status itself is the
// lock — easier to reason about, harder to drift.

export const LOCKED_STATUSES: ReadonlySet<string> = new Set([
  'Rancher Contacted',
  'Negotiation',
  'Awaiting Payment',
  'Slot Locked',
]);

/**
 * True if the given Referral status represents an active rancher engagement
 * that should be locked against auto-paths.
 *
 * Accepts the raw status string OR a Referral fields object. Falsy/unknown
 * input returns false — never default to "locked" so we don't accidentally
 * block valid operations.
 */
export function isReferralLocked(
  statusOrReferral: string | { Status?: string | null } | null | undefined,
): boolean {
  if (!statusOrReferral) return false;
  if (typeof statusOrReferral === 'string') {
    return LOCKED_STATUSES.has(statusOrReferral);
  }
  const status = String(statusOrReferral['Status'] || '');
  return LOCKED_STATUSES.has(status);
}

/**
 * Filter helper: given a list of Airtable Referral records, return the ones
 * whose Status is currently locked. Used by recovery crons + matching paths
 * to detect "this buyer already has a working lead — leave it alone".
 *
 * Records expected in Airtable shape: `{ id, fields: { Status, ... } }`
 * OR plain field-flattened shape (fields at top level). Handles both.
 */
export function findLockedReferrals<T extends Record<string, any>>(
  records: T[],
): T[] {
  return records.filter((r) => {
    const fields = (r as any)['fields'] || r;
    return isReferralLocked(fields);
  });
}

/**
 * MONEY LOCK (Blocker-3 2026-07-01): once a deposit has actually settled
 * (`Deposit Paid At` stamped by the Stripe webhook), one-click email links
 * (quick-action pass / in_talks / won / lost) must NEVER mutate the referral.
 * A stale Pass link — or a mail scanner's GET prefetch — was enough to close
 * a PAID deal Lost, free the slot, and re-route the paying buyer toward a
 * second deposit. Money in ⇒ changes go through the dashboard's explicit
 * flows only. Pure: decides from the stamp alone, pinned in
 * lib/referralLock.test.ts.
 */
export function isDepositLocked(depositPaidAt: unknown): boolean {
  if (depositPaidAt == null) return false;
  return String(depositPaidAt).trim().length > 0;
}

/**
 * The friendly refusal every quick-action mutation renders when the money
 * lock is on. Rendered as the headline of the quick-action HTML response
 * page (which already carries an "Open dashboard" CTA button).
 */
export const DEPOSIT_LOCKED_MESSAGE =
  "This deal has a paid deposit on it, so quick links from email are locked to protect it. Everything's safe — use your dashboard to make any changes.";

/**
 * MONEY LOCK — dashboard flavor (Wave A 2026-07-14, parity with the
 * quick-action lock above). The dashboard PATCH must not let a rancher
 * pass, close Lost, or regress a referral once the deposit is paid: the
 * buyer's money is sitting in the rancher's Stripe, and pre-fix the pass
 * path freed the slot and re-routed the paying buyer toward a SECOND
 * deposit. Forward progress stays open (Closed Won / Awaiting Payment),
 * as do sale-amount/notes-only updates (no status in the PATCH body).
 * Pure: decides from the stamp + requested mutation alone; pinned in
 * lib/referralLock.test.ts.
 */
export function isDashboardExitBlocked(
  depositPaidAt: unknown,
  mutation: { action?: string | null; status?: string | null },
): boolean {
  if (!isDepositLocked(depositPaidAt)) return false;
  if (mutation.action === 'pass') return true;
  const s = String(mutation.status || '');
  if (!s) return false; // sale-amount / notes-only update — allowed
  return s !== 'Closed Won' && s !== 'Awaiting Payment';
}

/**
 * Tiny audit-log helper: format a one-line reason describing what was
 * blocked and why. Use in Notes append + Telegram detail strings so the
 * lock surfaces consistently across surfaces.
 */
export function lockNotice(
  status: string | undefined,
  context: 'pass' | 'reassign' | 'auto-route' | 'auto-close' | 'bulk',
): string {
  return `[LOCK ${new Date().toISOString().slice(0, 16)}] ${context} blocked — status="${status || '?'}". Rancher is working this lead. Operator override required.`;
}
