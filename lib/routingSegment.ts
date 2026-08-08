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

/** The 3 marketing lanes (MARKETING-REVAMP-2026-08 §3). */
export type BuyerLane = 'share-ready' | 'national' | 'customer';

function readEnumOrString(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

export interface ServedStatesOptions {
  /**
   * Capacity-IN variant (legacy getCoveredStates semantics): skip ranchers
   * whose `Current Active Referrals` >= `Max Active Referalls` (sic —
   * single-L Airtable field typo; read BOTH spellings nowhere else). Only
   * classifyBuyer's MATCH_NOW/WARM_LEAD/NUDGE funnel uses this, so buyers
   * are never routed intros at a full rancher. Everything answering "is
   * this state served at all?" must use the default (capacity-OUT).
   */
  excludeAtCapacity?: boolean;
}

/**
 * THE one shared served-states helper (P1′, MARKETING-REVAMP-2026-08 §5).
 *
 * Returns the set of 2-letter state codes served by at least one operational
 * rancher. State coverage is a union across ranchers.
 *
 * Default definition is capacity-OUT: an at-capacity rancher STILL counts as
 * coverage. Capacity is transient (a single fill would otherwise flap the
 * whole state between lanes overnight), so the default path deliberately
 * never reads `Max Active Referalls` / `Current Active Referrals` at all.
 * Callers that intentionally need capacity-IN (the classifier's intro
 * funnel) opt in via `{ excludeAtCapacity: true }`.
 *
 * Replaces four copy-pasted loops (abandoned-quiz-nudge, waiting-activation,
 * state-coverage-notify, getCoveredStates) plus the dead hasRancherAvailable
 * in email-sequences.
 */
export function getServedStates(
  ranchers: RancherFields[],
  opts?: ServedStatesOptions,
): Set<string> {
  const excludeAtCapacity = !!opts?.excludeAtCapacity;
  const set = new Set<string>();
  for (const r of ranchers) {
    if (!isRancherOperationalForBuyers(r)) continue;
    if (excludeAtCapacity) {
      const current = Number((r as any)['Current Active Referrals'] || 0);
      const max = Number((r as any)['Max Active Referalls'] || 0);
      // Cap check: skip if at-or-over capacity AND max > 0.
      // max=0 or undefined means uncapped (legacy behavior).
      if (max > 0 && current >= max) continue;
    }
    for (const s of getOperationalServedStates(r)) set.add(s);
  }
  return set;
}

/**
 * Returns the set of 2-letter state codes covered by at least one operational
 * rancher with available capacity. Used by the classifier to decide between
 * MATCH_NOW + NUDGE_TO_ENGAGE (covered) vs the waitlist fallthrough.
 *
 * Back-compat wrapper: capacity-IN view of getServedStates. New callers
 * should use getServedStates directly and only pass excludeAtCapacity when
 * they are about to route a buyer at a specific rancher.
 */
export function getCoveredStates(ranchers: RancherFields[]): Set<string> {
  return getServedStates(ranchers, { excludeAtCapacity: true });
}

/**
 * Project a stored Routing Segment onto the 3-lane architecture
 * (MARKETING-REVAMP-2026-08 §3). Pure; accepts the raw stored string (which
 * may be stale, unknown, or empty) and fails safe to 'national' — the
 * lowest-pressure lane (digest + ships-nationwide only, no share pressure).
 *
 *   customer     TERMINAL — closed/matched/actively transacting; Lane 3
 *                (replenishment/review flows, never re-acquisition).
 *   share-ready  MATCH_NOW / WARM_LEAD / NUDGE_TO_ENGAGE — only assigned
 *                when the buyer's state is covered; INCOMPLETE_PROFILE —
 *                post-ordering-fix it implies a served (or unknown) state,
 *                and the profile ask is the ledger's RESCOPE-to-Lane-1 item.
 *   national     STATE_WAITLIST — unserved state by definition;
 *                NO_BUDGET_FOUNDER_PITCH — budget-driven, can't buy a share
 *                at any state's price, so ships-nationwide product marketing
 *                is the honest offer; COMMUNITY_NURTURE — explicit
 *                not-buying-yet signal, digest-only cadence;
 *                UNQUALIFIED_NURTURE — suppressed/non-responsive, parked in
 *                the no-pressure lane (send layer suppresses regardless).
 */
export function laneForSegment(segment: string): BuyerLane {
  switch (segment) {
    case 'TERMINAL':
      return 'customer';
    case 'MATCH_NOW':
    case 'WARM_LEAD':
    case 'NUDGE_TO_ENGAGE':
    case 'INCOMPLETE_PROFILE':
      return 'share-ready';
    default:
      return 'national';
  }
}

// reclassify-buyers calls classifyBuyer once per consumer (~2,700) with the
// SAME ranchers array — memoize both state sets per array identity so the
// nightly run computes them once, not 2× per buyer. WeakMap: no leak, and a
// fresh Airtable read (new array) naturally invalidates. Assumes the array
// is not mutated between calls within a run (it never is).
const stateSetCache = new WeakMap<
  RancherFields[],
  { served: Set<string>; covered: Set<string> }
>();
function cachedStateSets(ranchers: RancherFields[]) {
  let entry = stateSetCache.get(ranchers);
  if (!entry) {
    entry = {
      served: getServedStates(ranchers),
      covered: getCoveredStates(ranchers),
    };
    stateSetCache.set(ranchers, entry);
  }
  return entry;
}

/**
 * Classify a single buyer into one of 8 routing segments.
 *
 * Order matters: terminal/disqualified checks first, then STATE COVERAGE for
 * stranded buyers (P1′ ordering fix), then incomplete profile, then the main
 * funnel (intent + state coverage).
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

  const { served, covered } = cachedStateSets(ranchers);
  const state = normalizeState(buyer['State']);
  // Stranded = a KNOWN state with no operational rancher at all. Deliberately
  // capacity-OUT (getServedStates default): a state whose only rancher is
  // temporarily full is still served — using the capacity-IN set here would
  // flap these buyers between segments every time one rancher fills.
  const stranded = state !== '' && !served.has(state);

  // Incomplete profile — can't classify funnel position without these signals.
  const orderType = readEnumOrString(buyer['Order Type']);
  const budget = readEnumOrString(buyer['Budget']);
  const orderMissing = !orderType || orderType === 'Not Sure';
  const budgetMissing = !budget || budget === 'Unsure' || budget === '';
  if (orderMissing || budgetMissing) {
    // P1′ ORDERING FIX (2026-08-08 money audit): state coverage is evaluated
    // BEFORE profile completeness. A stranded buyer with an incomplete
    // profile used to classify INCOMPLETE_PROFILE and get profile-ask emails
    // (179/wk) for a product they cannot buy at any price — they belong on
    // the state waitlist. A buyer with NO state at all is not stranded: the
    // profile ask is exactly what collects their state.
    if (stranded) return 'STATE_WAITLIST';
    return 'INCOMPLETE_PROFILE';
  }

  // "Just exploring" = explicit not-buying-yet signal → passive nurture
  // (monthly founder letter only, no pitch). Keep them warm without
  // burning them out.
  if (budget === 'Just exploring') return 'COMMUNITY_NURTURE';

  // Below-share-cost budget anywhere → Founder Herd pitch (mission backing
  // for buyers who care about regen-ag but can't drop $1k on beef this
  // year). Budget-driven, not state-driven — works in any state. Rancher
  // Quarter pricing starts ~$650 so <$500 = can't afford beef.
  if (budget === '<$500' || budget === '>$500') return 'NO_BUDGET_FOUNDER_PITCH';

  // Funnel coverage stays capacity-IN (getCoveredStates): MATCH_NOW routes a
  // buyer intro at a specific rancher, and a full rancher must never receive
  // one. This is the behavior-preservation flag from the P1′ brief — only the
  // stranded check above moved to the capacity-OUT definition.
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
