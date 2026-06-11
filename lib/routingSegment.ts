// Buyer routing-segment classifier.
//
// Every Consumer is mapped to one of 8 segments. Drives the email-sequences
// cron's branching decision tree: who gets which email, with what cadence.
//
// Hierarchy of consent:
//   - Ready to Buy (clicked "buying in 1-2 months")  -> ROUTE TO RANCHER
//   - Warmup Engaged (clicked YES on warmup email)   -> KEEP NURTURING
//   - Qualified profile + state covered              -> SEND WARMUP
//   - High-intent + state uncovered                  -> FOUNDER PITCH
//   - Anything weaker                                -> PASSIVE NURTURE
//
// Rancher time is the scarce resource. Only buyers who EXPLICITLY signaled
// purchase intent (R2B=true) get an intro. This protects the close rate
// + prevents the Ashcraft-pattern low-quality leads that burned ranchers
// in the 2026-05-20 incident.

import {
  isRancherOperationalForBuyers,
  getOperationalServedStates,
  type RancherFields,
} from './rancherEligibility';
import { normalizeState } from './states';

export type RoutingSegment =
  | 'MATCH_NOW'
  | 'WARM_LEAD'
  | 'NUDGE_TO_ENGAGE'
  | 'NO_BUDGET_FOUNDER_PITCH'
  | 'STATE_WAITLIST'
  | 'COMMUNITY_NURTURE'
  | 'INCOMPLETE_PROFILE'
  | 'UNQUALIFIED_NURTURE'
  | 'TERMINAL';

function readEnumOrString(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

/**
 * Returns the set of 2-letter state codes covered by at least one operational
 * rancher with available capacity. Used by the classifier to decide between
 * MATCH_NOW + NUDGE_TO_ENGAGE (covered) vs OUT_OF_STATE_FOUNDER_PITCH (not).
 *
 * Capacity check: if `Current Active Referrals` >= `Max Active Referalls`,
 * the rancher is treated as out-of-stock for new buyers — but we still
 * count the state as covered if ANOTHER rancher in the same state has
 * capacity. State coverage is union across ranchers.
 */
export function getCoveredStates(ranchers: RancherFields[]): Set<string> {
  const set = new Set<string>();
  for (const r of ranchers) {
    if (!isRancherOperationalForBuyers(r)) continue;
    const current = Number((r as any)['Current Active Referrals'] || 0);
    const max = Number((r as any)['Max Active Referalls'] || 0);
    // Cap check: skip if at-or-over capacity AND max > 0.
    // max=0 or undefined means uncapped (legacy behavior).
    if (max > 0 && current >= max) continue;
    for (const s of getOperationalServedStates(r)) set.add(s);
  }
  return set;
}

/**
 * Classify a single buyer into one of 8 routing segments.
 *
 * Order matters: terminal/disqualified checks first, then incomplete profile,
 * then the main funnel (intent + state coverage).
 */
export function classifyBuyer(
  buyer: Record<string, unknown>,
  ranchers: RancherFields[]
): RoutingSegment {
  // Terminal states — short-circuit immediately.
  const stage = readEnumOrString(buyer['Buyer Stage']);
  if (stage === 'CLOSED') return 'TERMINAL';
  // Actively transacting with a rancher (matched / deposit in flight / slot
  // locked / won) → the rancher + operator are handling them directly. Never
  // put them in a marketing-nurture segment. Mirrors the CLOSED sink. If a
  // deal dies, Closed Lost restores Buyer Stage to READY (auto-restore), which
  // re-admits the buyer to nurture on the next nightly reclassify.
  if (stage === 'MATCHED') return 'TERMINAL';
  const refStatusNow = readEnumOrString(buyer['Referral Status']);
  if (refStatusNow === 'Awaiting Payment' || refStatusNow === 'Slot Locked' || refStatusNow === 'Closed Won') {
    return 'TERMINAL';
  }
  if (buyer['Unsubscribed'] === true) return 'UNQUALIFIED_NURTURE';
  if (readEnumOrString(buyer['Buyer Health']) === 'Non-Responsive') {
    return 'UNQUALIFIED_NURTURE';
  }
  if (buyer['Bounced'] === true || buyer['Complained'] === true) {
    return 'UNQUALIFIED_NURTURE';
  }

  // Incomplete profile — can't classify funnel position without these signals.
  const orderType = readEnumOrString(buyer['Order Type']);
  const budget = readEnumOrString(buyer['Budget']);
  const orderMissing = !orderType || orderType === 'Not Sure';
  const budgetMissing = !budget || budget === 'Unsure' || budget === '';
  if (orderMissing || budgetMissing) return 'INCOMPLETE_PROFILE';

  // "Just exploring" = explicit not-buying-yet signal → passive nurture
  // (monthly founder letter only, no pitch). Keep them warm without
  // burning them out.
  if (budget === 'Just exploring') return 'COMMUNITY_NURTURE';

  // Below-share-cost budget anywhere → Founder Herd pitch (mission backing
  // for buyers who care about regen-ag but can't drop $1k on beef this
  // year). Budget-driven, not state-driven — works in any state. Rancher
  // Quarter pricing starts ~$650 so <$500 = can't afford beef.
  if (budget === '<$500' || budget === '>$500') return 'NO_BUDGET_FOUNDER_PITCH';

  const state = normalizeState(buyer['State']);
  const covered = getCoveredStates(ranchers);
  const inCoveredState = state ? covered.has(state) : false;

  const readyToBuy = buyer['Ready to Buy'] === true;
  const engaged = !!buyer['Warmup Engaged At'];

  // Covered state + explicit purchase intent → intro to rancher.
  if (inCoveredState && readyToBuy) return 'MATCH_NOW';

  // Covered state + soft engagement (clicked warmup YES) → bi-weekly
  // "ready yet?" nudge until they hit the R2B button.
  if (inCoveredState && engaged) return 'WARM_LEAD';

  // Covered state, qualified profile, no engagement signal → first
  // re-warmup. They got an initial warmup, never clicked.
  if (inCoveredState) return 'NUDGE_TO_ENGAGE';

  // Uncovered state w/ valid budget + Order Type — they CAN afford it,
  // they want it, we just don't have a rancher in their state yet. Goes
  // on the waitlist + monthly "we're scouting [state]" letter. NOT a
  // founder pitch — that's reserved for the no-budget audience above.
  return 'STATE_WAITLIST';
}
