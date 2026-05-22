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
  | 'OUT_OF_STATE_FOUNDER_PITCH'
  | 'COMMUNITY_NURTURE'
  | 'INCOMPLETE_PROFILE'
  | 'UNQUALIFIED_NURTURE'
  | 'TERMINAL';

const HIGH_BUDGET_PATTERNS = [
  '$1000',
  '$1500',
  '$2000',
  '$2500',
  '$4000',
  '$5000',
];

function hasHighBudget(budget: string): boolean {
  return HIGH_BUDGET_PATTERNS.some((p) => budget.includes(p));
}

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
  const budgetMissing =
    !budget || budget === 'Unsure' || budget === 'Just exploring' || budget === '';
  if (orderMissing || budgetMissing) return 'INCOMPLETE_PROFILE';

  // Reject `<$500` as below-share-cost — push to nurture instead of pretending
  // they can afford a Quarter. Rancher Quarter pricing starts ~$650.
  if (budget === '<$500' || budget === '>$500') return 'COMMUNITY_NURTURE';

  const state = normalizeState(buyer['State']);
  const covered = getCoveredStates(ranchers);
  const inCoveredState = state ? covered.has(state) : false;

  const readyToBuy = buyer['Ready to Buy'] === true;
  const engaged = !!buyer['Warmup Engaged At'];

  // Covered state + explicit purchase intent -> intro to rancher.
  if (inCoveredState && readyToBuy) return 'MATCH_NOW';

  // Covered state + soft engagement (clicked warmup YES) -> bi-weekly
  // "ready yet?" nudge until they hit the R2B button. Don't burn rancher
  // time on a "maybe."
  if (inCoveredState && engaged) return 'WARM_LEAD';

  // Covered state, qualified profile, no engagement signal -> first
  // re-warmup. They got an initial warmup, never clicked.
  if (inCoveredState) return 'NUDGE_TO_ENGAGE';

  // Uncovered state — branch on intent strength.
  const highIntent = readyToBuy || engaged || hasHighBudget(budget);
  if (highIntent) return 'OUT_OF_STATE_FOUNDER_PITCH';

  return 'COMMUNITY_NURTURE';
}
