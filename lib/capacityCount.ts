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
