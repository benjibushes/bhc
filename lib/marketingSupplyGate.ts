// lib/marketingSupplyGate.ts
//
// P2′ — supply gates for the two actually-ungated marketing senders
// (MARKETING-REVAMP-2026-08 §5, Track 1). Panel finding: every other
// marketing sender is already supply-gated; these two were not:
//
//   1. nurture-drip cron — full Consumers scan, fetched NO Ranchers, applied
//      no lane awareness (~220 sends/wk of share-pressure nurture, a large
//      share of it to buyers no rancher can serve).
//   2. matching/suggest GUARD-2b — the still_looking_reconfirm email asks a
//      buyer to re-commit to a purchase; sending it to a buyer in a state
//      with zero operational ranchers is a promise the machine can't keep.
//
// Pure selectors only. Callers fetch Ranchers ONCE per request/run and pass
// getServedStates(ranchers) — the shared P1′ helper, capacity-OUT default
// (an at-capacity rancher still counts as coverage; states never lane-flap
// when one rancher fills).
//
// Lane policy for the drip (plan v2):
//   share-ready → send (behavior byte-identical to pre-gate)
//   national    → SKIP (counted; digest/product flows serve them in later
//                 phases — no interim content is invented here)
//   customer    → SKIP (replenishment rail owns them)

import { laneForSegment } from './routingSegment';
import { normalizeState } from './states';

/** Airtable single-selects read as strings OR {name} objects — accept both. */
function readSegment(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

export type NurtureLaneDecision =
  | { send: true }
  | { send: false; reason: 'national' | 'customer' };

/**
 * Lane gate for the nurture-drip cron.
 *
 * When the stored 'Routing Segment' is present it is the single source of
 * truth (laneForSegment projection — nightly reclassify-buyers owns segment
 * freshness; the drip never second-guesses it with a live state check).
 * When the segment is blank (buyer not yet classified), fall back to the
 * stranded test: a KNOWN state absent from servedStates is national; an
 * unknown/blank state fails open to the pre-P2′ behavior (send).
 */
export function nurtureLaneGate(input: {
  /** Raw Consumers['Routing Segment'] (string | {name} | empty). */
  routingSegment: unknown;
  /** Raw Consumers['State']. */
  state: unknown;
  /** getServedStates(ranchers) — capacity-OUT default. */
  servedStates: Set<string>;
}): NurtureLaneDecision {
  const segment = readSegment(input.routingSegment);
  if (segment) {
    const lane = laneForSegment(segment);
    if (lane === 'national') return { send: false, reason: 'national' };
    if (lane === 'customer') return { send: false, reason: 'customer' };
    return { send: true };
  }
  const st = normalizeState(input.state);
  if (st !== '' && !input.servedStates.has(st)) {
    return { send: false, reason: 'national' };
  }
  return { send: true };
}

/**
 * GUARD-2b supply gate: may the still_looking_reconfirm email be sent to a
 * buyer in this state? False ONLY for a known state with zero operational
 * ranchers (capacity-OUT — an at-capacity rancher still counts). Unknown or
 * blank state fails open: the gate must never block behavior it cannot prove
 * wrong, and pre-P2′ behavior was always-send.
 */
export function reconfirmAllowedForState(
  state: unknown,
  servedStates: Set<string>,
): boolean {
  const st = normalizeState(state);
  if (st === '') return true;
  return servedStates.has(st);
}
