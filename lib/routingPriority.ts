// lib/routingPriority.ts
//
// Retainer routing priority — the code behind the paid-tier "priority routing"
// promise (lib/tiers.ts copy). Pure + side-effect-free + independently
// unit-tested, so app/api/matching/suggest can use it without dragging in tiers'
// secrets dependency (a `type`-only tiers import erases at runtime).

import type { TierSlug } from './tiers';

// Higher weight = matched FIRST among equally-eligible, equally-loaded ranchers
// whose PRIMARY state is the buyer's state. The model is "a paid RETAINER earns
// local priority over free/commission-only ranchers" (the founder's rule as
// ranchers flip to monthly terms), GRADUATED by tier:
//   • operator ($500/mo) + ranch ($350/mo) = top priority (weight 3) — ranch's
//     "you get the match before any other rancher" perk, operator inherits it.
//   • pasture ($150/mo) = the entry paid retainer → priority OVER free/legacy
//     (weight 2), but yields to the higher-paid ranch/operator.
//   • legacy_connect (10%, no monthly = NOT a retainer) + no-tier = baseline 1.
// This is why a Pasture rancher (e.g. Champion Valley on the $150 term) is
// matched ahead of a free in-state rancher, but a Ranch rancher still outranks
// a Pasture one. Change a weight here to re-tune the priority ladder.
export const ROUTING_WEIGHT: Record<TierSlug, number> = {
  operator: 3,
  ranch: 3,
  pasture: 2,
  legacy_connect: 1,
};

export function routingWeightForTier(tier: TierSlug | null): number {
  return tier ? (ROUTING_WEIGHT[tier] ?? 1) : 1;
}

// Starvation floor: a higher-weight rancher keeps priority only while it is
// within this many active referrals of the lower-weight peer.
export const RETAINER_FLOOR_SLACK = 2;

// Pure priority comparator. Returns a sort compare number
// (<0 = a first, >0 = b first, 0 = tie / defer to the next rule):
//   • higher weight wins ONLY while it's not meaningfully more loaded (floor)
//   • equal weight → 0 (load-balance decides)
//   • higher-weight-but-overloaded → 0 (load-balance decides; no starvation)
// This is a TIEBREAKER only — it never touches eligibility, capacity, or the
// atomic-INCR ceiling in the matching route.
export function retainerPriorityCompare(
  aWeight: number,
  aRefs: number,
  bWeight: number,
  bRefs: number,
  floorSlack: number = RETAINER_FLOOR_SLACK,
): number {
  if (aWeight === bWeight) return 0;
  const higherRefs = aWeight > bWeight ? aRefs : bRefs;
  const lowerRefs = aWeight > bWeight ? bRefs : aRefs;
  if (higherRefs <= lowerRefs + floorSlack) return aWeight > bWeight ? -1 : 1;
  return 0;
}
