// /map PIN BUCKETING + PUBLIC COUNTS — the single source of truth for how a
// Ranchers row becomes a pin status on the public Discover Map, and for every
// number the map states out loud (app/map/page.tsx).
//
// Extracted from the page (2026-08-18) because the inline version predated the
// broker self-serve carve-out and mislabeled the carve-out's flagship supply:
// a REPRESENTED ranch (Broker Rail + `Broker Self Serve`, e.g. Gila River
// Cattle, AZ) never runs the wizard and never signs anything, so its
// Verification Status, Onboarding Status, and Self-Submitted At are ALL empty
// — and the old fallthrough dumped it in 'prospect', painting a deposit-ready,
// routable ranch as "○ On our radar (unclaimed)" on the PR's headline surface.
//
// Status priority — most-progressed wins:
//   live        → Onboarding Status = Live (canonical terminal state), OR
//                 Verification Status = Verified. Connect-rail truth,
//                 unchanged in MEMBERSHIP from the original inline logic.
//                 RENAMED from 'verified' 2026-08-18 — see THE NAME below.
//   represented → isBrokerSelfServe: a ranch BuyHalfCow represents that Ben
//                 explicitly opted into public promotion (#628/#630). It is
//                 deposit-ready TODAY via the broker rail, so it outranks the
//                 pipeline buckets below — a represented ranch structurally
//                 has none of those fields anyway, but if one ever carries a
//                 stray Onboarding Status mid-conversion, "you can reserve
//                 now" is the truer public label than "being onboarded".
//                 Sits BELOW live: a ranch that graduates to the Connect
//                 rail reads as the more-progressed thing it became.
//                 Token-only broker ranches (no `Broker Self Serve`) never
//                 reach this code at all — mapPinsFormula's carve-out excludes
//                 them at fetch time (pinned by lib/brokerDiscoverySurfaces
//                 .test.ts) — and isBrokerSelfServe fails closed for them
//                 anyway, so even a formula regression could not label one
//                 "represented".
//   onboarding  → Onboarding Status in ONBOARDING_STAGES (visible, not yet
//                 routable; stageLabel carries the sub-stage).
//   self-submitted → Self-Submitted At set (raised hand / fan-flagged).
//   prospect    → cold-discovered, no progress.
//
// FAIL CLOSED: anything unrecognized falls through to 'prospect', the least
// promising label — never the other direction.
//
// ── THE NAME (2026-08-18 /map truth pass) ───────────────────────────────────
// The terminal bucket used to be called 'verified', and four public surfaces
// printed that word straight off the bucket: the below-the-fold legend
// sentence, the MapLegend row, the SSR list badge, and the pin popup. On the
// live map that bucket held 13 ranches of which only 6 carried a
// `Verification Status = 'Verified'` stamp — so seven ranches were publicly
// called verified by code that had never read the verification field. PR #647
// deleted the identical defect from the ranchers' own pages; this is the same
// bug one surface over, and it is why the map and the pages contradicted each
// other the moment #647 landed.
//
// The fix keeps the BUCKET (a pin colour is a progress signal, and Live really
// is the terminal onboarding state — repainting seven live, routable ranches
// as "being onboarded" would be a fresh lie in the opposite direction, and
// would bury real supply on an ad-bound surface). What changed is that the
// bucket no longer carries a trust word in its NAME, so no surface can print
// one by accident, and the word itself now comes from isVerifiedRancher below
// — the same strict predicate the rancher page's pill uses. Map and page can
// no longer disagree about a single ranch.

import { isBrokerSelfServe, isBrokerRoutable } from './brokerRail';
import { isRancherOnConnect } from './rancherEligibility';

export const ONBOARDING_STAGES = [
  'Call Scheduled',
  'Call Complete',
  'Docs Sent',
  'Agreement Signed',
  'Verification Pending',
  'Verification Complete',
];

export type MapPinStatus =
  | 'live'
  | 'represented'
  | 'onboarding'
  | 'self-submitted'
  | 'prospect';

/** Airtable single-selects arrive as a string, or sometimes as `{ name }`. */
function readEnumOrString(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

export function derivePinStatus(r: any): { status: MapPinStatus; stageLabel: string } {
  const verification = (r?.['Verification Status'] || '').toString();
  const onboarding = (r?.['Onboarding Status'] || '').toString();
  const selfSubmittedAt = (r?.['Self-Submitted At'] || '').toString();

  // Onboarding="Live" is the canonical terminal state — by the time a rancher
  // reaches Live, they've cleared agreement + verification and are routable.
  // Verification Status is a legacy/duplicate gate; some ranchers reach Live
  // without it ever being flipped to "Verified" (Self-Submit drip path skips
  // that field). Treat Live as terminal regardless of Verification Status
  // (Removed is already excluded at fetch time via mapPinsFormula) — but note
  // that this bucket is about PROGRESS, not trust. The word "verified" comes
  // from isVerifiedRancher, never from landing here.
  if (onboarding === 'Live') return { status: 'live', stageLabel: '' };
  if (verification === 'Verified') return { status: 'live', stageLabel: '' };
  if (isBrokerSelfServe(r)) return { status: 'represented', stageLabel: '' };
  if (ONBOARDING_STAGES.includes(onboarding)) {
    return { status: 'onboarding', stageLabel: onboarding };
  }
  if (selfSubmittedAt) return { status: 'self-submitted', stageLabel: '' };
  return { status: 'prospect', stageLabel: '' };
}

/**
 * Has this ranch actually EARNED the word "verified"?
 *
 * Exactly `Verification Status = 'Verified'`, nothing else. Deliberately the
 * same rule as the rancher page's hero pill (PR #647's heroTrustPill), so the
 * map and the ranch's own page can never make different claims about the same
 * record. A blank field, 'Not Started', or 'Verification Complete' all mean
 * NO — a missing verdict is not a verdict.
 *
 * A represented (broker self-serve) ranch is structurally false here: it never
 * ran verification, so the field is empty. The #636 terminology ruling —
 * represented ranches are NEVER called verified — therefore holds by
 * construction rather than by remembering to write an else-branch, which is
 * precisely the shape of the bug this replaces.
 */
export function isVerifiedRancher(r: any): boolean {
  return readEnumOrString(r?.['Verification Status']) === 'Verified';
}

/**
 * Canonical Fulfillment Types (multi-select), matching the setup wizard,
 * /api/checkout/deposit and app/ranchers/[slug]/FulfillmentSection: 'Local
 * Pickup', 'Local Delivery', 'Cold-Chain Shipping'. Airtable usually hands
 * back string[]; some legacy rows hand back [{name}].
 */
export function normalizeFulfillmentTypes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t: any) => (t && typeof t === 'object' && 'name' in t ? String(t.name) : String(t ?? '')))
    .filter(Boolean);
}

/**
 * Can this ranch actually put a box of beef in a carrier's hands?
 *
 * THE BUG (live until 2026-08-18): /map's headline read "14 ranchers shipping
 * beef today", derived from the pin bucket — i.e. from onboarding progress,
 * which has nothing to do with logistics. Of those 14, four had Cold-Chain
 * Shipping in their Fulfillment Types. The other ten do local pickup and/or
 * delivery, or have never filled the field in at all.
 *
 * FAILS CLOSED: a blank Fulfillment Types is NOT a shipper. Half the live
 * ranches have that field empty, and inventing a shipping capability for them
 * is the exact defect being removed.
 */
export function shipsColdChain(r: any): boolean {
  return normalizeFulfillmentTypes(r?.['Fulfillment Types']).some(
    (t) => t.toLowerCase() === 'cold-chain shipping',
  );
}

/**
 * Will this rancher's public page actually render a deposit form?
 *
 * The map's "Reserve →" CTA must never promise a checkout the slug page can't
 * deliver (dead-ends the buyer), and must never undersell one it can. Two
 * rails can take a deposit, and they are mutually exclusive by construction:
 *
 *   - Connect rail: tier_v2 + ACTIVE Stripe Connect (isRancherOnConnect —
 *     the exact gate the storefront deposit form uses).
 *   - Broker rail:  isBrokerRoutable — self-serve opt-in + not Removed/hidden
 *     + a real slug + at least one cut assertBrokerEligible accepts (the
 *     exact gate /api/checkout/broker-reserve runs). A represented ranch
 *     with no eligible cut stays FALSE and its pin card reads "View ranch".
 *
 * (isBrokerRoutable is false for any Connect-footprint rancher, and
 * isRancherOnConnect is false for broker ranches, so the OR never double-
 * claims.)
 *
 * This is ALSO the predicate behind every "taking reservations" claim on the
 * map. Five of the fourteen green pins are live, real and browsable but have
 * no deposit rail — their own pin card already says "View ranch →", and since
 * 2026-08-18 the headline, the stat row and the filter chip agree with it.
 */
export function isPinDepositReady(r: any): boolean {
  return isRancherOnConnect(r) || isBrokerRoutable(r);
}

// ── the public counts ───────────────────────────────────────────────────────

/**
 * The already-derived facts a pin carries. Every public number on /map is a
 * count over these — derived per-ranch from that ranch's own fields, never
 * from the bucket a pin happens to sit in.
 */
export interface MapStatsInput {
  status: MapPinStatus;
  state: string;
  /** `Verification Status = 'Verified'` — the only thing that earns the word. */
  verified: boolean;
  /** The ranch's page renders a deposit form (Connect or broker rail). */
  depositReady: boolean;
  /** Cold-Chain Shipping is in the ranch's Fulfillment Types. */
  shipsColdChain: boolean;
  /** Request-only specialty supply (lib/requestOnlyRanchers). */
  requestOnly: boolean;
}

export interface MapStats {
  /** Green pins: on the platform (terminal onboarding state). */
  live: number;
  /** Green pins with a tallow center: ranches BuyHalfCow represents. */
  represented: number;
  /** Of the green pins, how many carry a real verification stamp. */
  verifiedPartners: number;
  /**
   * The headline number. A green pin whose page will actually take a deposit
   * right now — the literal meaning of "taking reservations", and exactly the
   * set the map's own "Taking reservations" filter chip shows.
   */
  reservable: number;
  /**
   * Green pins that can ship a box, EXCLUDING request-only supply.
   *
   * Request-only ranches (lib/requestOnlyRanchers) are reachable by asking —
   * their page and their pinned link stay open, and their pin stays on the
   * map. What they must never be is the generic answer to "will someone ship
   * to me?", which is precisely what an aggregate shipping number on the
   * highest-traffic ad-bound surface promises. Their reservable count is not
   * affected: that is a statement about the network's live inventory, not an
   * offer to source for a particular buyer.
   */
  coldChainShippers: number;
  onboarding: number;
  selfSubmitted: number;
  prospects: number;
  statesCovered: number;
}

const isGreen = (p: MapStatsInput) => p.status === 'live' || p.status === 'represented';

export function deriveMapStats(pins: MapStatsInput[]): MapStats {
  const states = new Set(pins.map((p) => p.state).filter(Boolean));
  return {
    live: pins.filter((p) => p.status === 'live').length,
    represented: pins.filter((p) => p.status === 'represented').length,
    verifiedPartners: pins.filter((p) => p.verified).length,
    reservable: pins.filter((p) => isGreen(p) && p.depositReady).length,
    coldChainShippers: pins.filter((p) => isGreen(p) && p.shipsColdChain && !p.requestOnly).length,
    onboarding: pins.filter((p) => p.status === 'onboarding').length,
    selfSubmitted: pins.filter((p) => p.status === 'self-submitted').length,
    prospects: pins.filter((p) => p.status === 'prospect').length,
    statesCovered: states.size,
  };
}
