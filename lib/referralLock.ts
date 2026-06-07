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
// WHY THESE THREE STATUSES
// ------------------------
// - Rancher Contacted: rancher has reached out to the buyer. They're investing
//   their time. Auto-moving the lead destroys that effort.
// - Negotiation: deal is in active discussion. Auto-moving creates buyer
//   confusion and rancher resentment.
// - Awaiting Payment: deposit is incoming or already paid. Auto-moving here
//   risks a chargeback or worse.
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
