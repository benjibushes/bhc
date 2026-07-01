// lib/routingPriority.ts
//
// Retainer routing priority — the code behind the paid-tier "priority routing"
// promise (lib/tiers.ts copy). Pure + side-effect-free + independently
// unit-tested, so app/api/matching/suggest can use it without dragging in tiers'
// secrets dependency (a `type`-only tiers import erases at runtime).

import type { TierSlug } from './tiers';

// Higher weight = matched FIRST among equally-eligible, equally-loaded ranchers
// whose PRIMARY state is the buyer's state. ranch (TIERS.ranch feature:
// "Priority routing — you get the match before any other rancher") and operator
// (inherits everything below it) are the paid tiers that SELL priority → weight
// 3. pasture (entry paid tier, no priority perk), legacy_connect ("same buyer
// routing as paid tiers" = in the pool, not ahead of it), and no-tier ranchers
// stay at the baseline 1.
//
// To give a specific rancher priority, put them on Ranch/Operator. Legacy
// Connect (e.g. Champion Valley) is intentionally NOT prioritized here — flip
// its weight below only if the Legacy "same as paid" promise is meant to include
// priority (a business decision, not a code default).
export const ROUTING_WEIGHT: Record<TierSlug, number> = {
  operator: 3,
  ranch: 3,
  pasture: 1,
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
