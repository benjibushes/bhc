// Pure capacity-counting logic. ZERO runtime dependencies (no Redis, no
// Airtable) so it can be unit-tested directly and reused as the ONE canonical
// definition of "how many active referrals does a rancher hold."
//
// Before this module the "held referral" definition was duplicated across
// capacity-drift-check (5 statuses, Rancher link), batch-approve ((Rancher||
// Suggested)[0]), and admin/health (4 statuses incl. Pending Approval) — three
// different rules that computed different numbers and overwrote each other.
// Everything now derives from here.

// A referral occupies a capacity slot from the Intro Sent INCR until the
// Closed Won/Lost DECR; the statuses between hold the slot too. Pending Approval
// is pre-INCR (no slot consumed yet) → excluded. Closed Won/Lost are terminal.
export const HELD_REFERRAL_STATUSES = new Set<string>([
  'Intro Sent',
  'Rancher Contacted',
  'Negotiation',
  'Awaiting Payment',
  'Slot Locked',
]);

// "Does this referral represent a live deal that should block a NEW match?"
// The single answer for matching/suggest's already-in-a-deal guard,
// member/ready-to-buy's active-referral lookup, and the stuck-buyer-recovery
// cron. Before this predicate each caller kept its own status literal — and
// every one of them omitted 'Awaiting Payment' + 'Slot Locked', so a buyer
// mid-payment could be double-routed into a second referral (BLOCKER-4,
// 2026-07-01).
//
// Rule: any HELD status is active. 'Pending Approval' is active ONLY with a
// linked Rancher / Suggested Rancher — an orphan Pending Approval (no
// attachment) is the residue of a failed matching attempt and must stay
// recoverable (2026-05-06 bug: treating orphans as active blocked retries
// forever). Pure + synchronous.
export function isActiveDealReferral(ref: any): boolean {
  const status = ref?.['Status'];
  if (HELD_REFERRAL_STATUSES.has(status)) return true;
  if (status === 'Pending Approval') {
    return (
      (Array.isArray(ref?.['Rancher']) && ref['Rancher'].length > 0) ||
      (Array.isArray(ref?.['Suggested Rancher']) && ref['Suggested Rancher'].length > 0)
    );
  }
  return false;
}

// Count held referrals attributed to a rancher from a referrals array.
// Attribution = Status ∈ HELD_REFERRAL_STATUSES AND the `Rancher` link array
// includes the rancher id. NOT `Suggested Rancher` — a held referral always has
// `Rancher` set once introduced (the INCR fires at Intro Sent, which sets it);
// counting Suggested would double-bill a slot mid-reassign. Pure + synchronous.
export function countHeldReferrals(rancherId: string, referrals: any[]): number {
  if (!rancherId || !Array.isArray(referrals)) return 0;
  let n = 0;
  for (const ref of referrals) {
    if (!HELD_REFERRAL_STATUSES.has(ref?.['Status'])) continue;
    const link = ref?.['Rancher'];
    if (Array.isArray(link) && link.includes(rancherId)) n++;
  }
  return n;
}

// CAPACITY = CLOSED SALES, not held leads (founder rule 2026-07-08). A rancher
// with Max Active Referalls = 50 has FIFTY head to sell — they keep receiving
// qualified buyers until they've CLOSED fifty sales, not until fifty leads sit
// in their pipeline. Held leads are pipeline depth (a load-balance tiebreak),
// never the cap: "the limit is about how many closed sales are happening, not
// how many leads they get." Counts Closed Won attributed via the Rancher link
// (same attribution as countHeldReferrals). Pure + synchronous.
export function countClosedWonReferrals(rancherId: string, referrals: any[]): number {
  if (!rancherId || !Array.isArray(referrals)) return 0;
  let n = 0;
  for (const ref of referrals) {
    if (ref?.['Status'] !== 'Closed Won') continue;
    const link = ref?.['Rancher'];
    if (Array.isArray(link) && link.includes(rancherId)) n++;
  }
  return n;
}
