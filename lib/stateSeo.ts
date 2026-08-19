// lib/stateSeo.ts — pure helpers for the programmatic /half-a-cow/[state]
// SEO pages (competitive-report gap #1: "half a cow near me / half a cow
// [state]" searches have zero BHC landing surface; Half a Cow Club owns them).
//
// Everything in here is PURE — no Airtable, no env reads — so the route's
// generateStaticParams / generateMetadata can call it at build time for all
// 50 states without touching the network (the known transient-Airtable-
// prerender-timeout build killer). Live counts are fetched per-page inside
// the route component with a try/catch fallback, never here.
//
// Slugs are full lowercase state names ('texas', 'new-york') — the actual
// search phrase — distinct from /access/[state] which owns the 2-letter-code
// slug space ('/access/tx').

import { US_STATES, type StateCode } from './states';
import { deriveLadder, DEPOSIT_PCT, MIN_TIER_PRICE } from './pricing';

export interface SeoState {
  slug: string; // 'texas', 'new-york' — lowercase full name, hyphenated
  name: string; // 'Texas', 'New York'
  code: StateCode; // 'TX', 'NY'
}

/** 'New York' -> 'new-york'. Lowercase, spaces -> hyphens. */
export function stateNameToSlug(name: string): string {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, '-');
}

// The 50 states. DC is excluded on purpose: it isn't in the "half a cow
// [state]" keyword set and the page copy ("ranches in {State}") reads wrong
// for a city-district. /access/dc still exists for routing purposes.
export const SEO_STATES: SeoState[] = US_STATES.filter((s) => s.code !== 'DC').map(
  (s) => ({ slug: stateNameToSlug(s.name), name: s.name, code: s.code }),
);

const BY_SLUG: Map<string, SeoState> = new Map(SEO_STATES.map((s) => [s.slug, s]));

/**
 * Resolve a URL slug to its state. Full-name slugs only — '/half-a-cow/tx'
 * returns null (404): the code-slug space belongs to /access/[state] and
 * serving both here would split the indexed URL set.
 */
export function stateBySlug(slug: string): SeoState | null {
  if (!slug) return null;
  return BY_SLUG.get(String(slug).trim().toLowerCase()) ?? null;
}

// ── Typical share pricing (truth-coupled to lib/pricing.ts) ────────────────
// The page publishes dollar ranges. They are DERIVED from the same ladder
// math the platform prices with (HALF_MULT / QUARTER_MULT / roundTo50), off
// the typical whole-beef band ranchers actually publish — so if Ben retunes
// pricing.ts, every state page's copy follows automatically.

// Retuned 2026-07-15 (funnel truth PR): the old 2000/3500 band published
// half ≈ $1,100–$1,950 — 40–70% under live supply (halves $3,299–3,650,
// wholes $6,500–6,800), so SEO entrants hit sticker shock inside one session.
export const TYPICAL_WHOLE_LOW = 6000;
export const TYPICAL_WHOLE_HIGH = 7000;

export interface TierRange {
  low: number;
  high: number;
}

export interface ShareRanges {
  whole: TierRange;
  half: TierRange;
  quarter: TierRange;
  /** e.g. 25 — deposit percent as a whole number for copy. */
  depositPercent: number;
}

export function typicalShareRanges(): ShareRanges {
  const lo = deriveLadder(TYPICAL_WHOLE_LOW);
  const hi = deriveLadder(TYPICAL_WHOLE_HIGH);
  return {
    whole: { low: lo.whole, high: hi.whole },
    half: { low: lo.half, high: hi.half },
    quarter: { low: lo.quarter, high: hi.quarter },
    depositPercent: Math.round(DEPOSIT_PCT * 100),
  };
}

/** 1950 -> '$1,950'. Whole dollars only (all BHC share money is whole-dollar). */
export function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/**
 * '$1,100–$1,950' for a tier range. A market with ONE price collapses to that
 * single figure — once these ranges are derived from live supply (below), a
 * state with a single ranch would otherwise publish the absurd '$2,600–$2,600'.
 * Compared after rounding, because that is what the reader sees.
 */
export function fmtRange(r: TierRange): string {
  const low = fmtUsd(r.low);
  const high = fmtUsd(r.high);
  return low === high ? low : `${low}–${high}`;
}

// ── Live-supply pricing (2026-08-18) ───────────────────────────────────────
// THE BUG: /half-a-cow/arizona published half beef at $3,300–$3,850 while the
// only live Arizona supply sells a half at $2,025–$2,363. The band above is a
// NETWORK ASSUMPTION (a whole-cow guess run through the ladder), not a
// measurement, so every state page anchored its buyers against a number no
// ranch on the page charges — in Arizona's case ~60% high.
//
// The band is now the FALLBACK. When a state has live ranchers we can price
// from, the page publishes what those ranchers actually charge, and the caller
// can tell (per tier) which of the two it is holding.

export type ShareTier = 'whole' | 'half' | 'quarter';

/** The Airtable price columns, per tier. `Max` is set only on weight-priced
 *  (hanging-weight) cuts, where `Price` is the range FLOOR — see lib/brokerRail. */
const TIER_PRICE_FIELDS: Record<ShareTier, { price: string; max: string }> = {
  whole: { price: 'Whole Price', max: 'Whole Price Max' },
  half: { price: 'Half Price', max: 'Half Price Max' },
  quarter: { price: 'Quarter Price', max: 'Quarter Price Max' },
};

/** A live Ranchers row, projected to the price columns. */
export type SupplyRancherRow = Record<string, unknown>;

export interface ResolvedShareRanges {
  /** What to publish. Supply-derived per tier where possible, network band elsewhere. */
  ranges: ShareRanges;
  /** Per tier: did this range come from ranchers who are actually live in the state? */
  fromSupply: Record<ShareTier, boolean>;
  /** True when ANY tier is real live supply — i.e. the page is quoting the market. */
  hasSupplyPricing: boolean;
}

/**
 * A published share price, or null. Rejects the per-lb mis-entry class of bug
 * (DD Ranch's $7.40 "whole cow") with the platform's own floor, so a typo can
 * never become the headline price on a state landing page.
 */
function usablePrice(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < MIN_TIER_PRICE) return null;
  return n;
}

/**
 * Per-tier price ranges across the live ranchers in one state. Only tiers some
 * ranch actually sells appear. Weight-priced cuts contribute floor→max; every
 * other cut contributes its exact price on both ends.
 */
export function supplyShareRanges(
  rows: SupplyRancherRow[] | null | undefined,
): Partial<Record<ShareTier, TierRange>> {
  const out: Partial<Record<ShareTier, TierRange>> = {};
  if (!Array.isArray(rows) || rows.length === 0) return out;
  for (const tier of Object.keys(TIER_PRICE_FIELDS) as ShareTier[]) {
    const fields = TIER_PRICE_FIELDS[tier];
    let low = Infinity;
    let high = -Infinity;
    for (const row of rows) {
      const price = usablePrice(row?.[fields.price]);
      if (price === null) continue;
      // Max counts only when it is a real ceiling ABOVE the floor — the same
      // rule lib/brokerRail applies before calling a cut weight-priced.
      const max = usablePrice(row?.[fields.max]);
      const ceiling = max !== null && max > price ? max : price;
      if (price < low) low = price;
      if (ceiling > high) high = ceiling;
    }
    if (low !== Infinity) out[tier] = { low, high };
  }
  return out;
}

/**
 * What a state page should publish. `rows` is the live-rancher set for that
 * state, or null when Airtable could not answer — and null must fall back, not
 * invent: an unknown market is not an empty one.
 */
export function resolveShareRanges(
  rows: SupplyRancherRow[] | null | undefined,
): ResolvedShareRanges {
  const network = typicalShareRanges();
  const supply = supplyShareRanges(rows);
  const fromSupply: Record<ShareTier, boolean> = {
    whole: Boolean(supply.whole),
    half: Boolean(supply.half),
    quarter: Boolean(supply.quarter),
  };
  return {
    ranges: {
      whole: supply.whole ?? network.whole,
      half: supply.half ?? network.half,
      quarter: supply.quarter ?? network.quarter,
      depositPercent: network.depositPercent,
    },
    fromSupply,
    hasSupplyPricing: fromSupply.whole || fromSupply.half || fromSupply.quarter,
  };
}

// ── Social-proof copy (honest; null when there is nothing true to say) ─────

/**
 * Waitlist social-proof line. Returns null unless the count is a real
 * positive number — the caller renders nothing rather than a fabricated
 * claim. count===null means "Airtable unreachable / unknown", which must
 * NOT render as zero (the no-ranchers-lie failure mode).
 */
export function waitlistLine(stateName: string, count: number | null): string | null {
  if (count === null || !Number.isFinite(count) || count < 1) return null;
  const n = Math.floor(count);
  return n === 1
    ? `1 ${stateName} family is already on the list.`
    : `${n.toLocaleString('en-US')} ${stateName} families are already on the list.`;
}

// ── FAQs (visible section + FAQPage JSON-LD share the same source) ─────────

export interface FaqItem {
  q: string;
  a: string;
}

/**
 * The 4 honest FAQs for a state page. Same list drives the on-page section
 * and the FAQPage JSON-LD so rich results can never diverge from what the
 * page actually says.
 */
export function stateFaqs(stateName: string, resolved?: ResolvedShareRanges): FaqItem[] {
  // Default = the network band, i.e. exactly the old behaviour for any caller
  // that has no live-supply read to hand.
  const res = resolved ?? resolveShareRanges(null);
  const r = res.ranges;
  // The visible FAQ and the FAQPage JSON-LD share this source, so a state with
  // live supply must not be able to publish the network band as rich-result
  // structured data about that state.
  // NOTE the per-lb figure: '$8–$11/lb hanging weight' is derived from the same
  // network whole-cow assumption as the fallback band, so it is only asserted
  // when the band itself is what we are quoting. A state priced off real supply
  // gets the mechanism (hanging weight sets the exact figure) without a made-up
  // rate — the live Arizona half works out nowhere near $8–$11/lb.
  const halfSentence = res.fromSupply.half
    ? `At the ranches serving ${stateName} today, a half-beef share runs ${fmtRange(r.half)} all-in (animal + processing) — the exact figure depends on the ranch and the animal's hanging weight.`
    : `A typical half-beef share runs ${fmtRange(r.half)} all-in (animal + processing), depending on the ranch and final weight — about $8–$11 per pound of hanging weight.`;
  return [
    {
      q: `How much does half a cow cost in ${stateName}?`,
      a:
        `${halfSentence} Boxed-delivery services work out to roughly $13–$17 per pound for comparable cuts. A quarter share runs ${fmtRange(r.quarter)}, a whole ${fmtRange(r.whole)}.`,
    },
    {
      q: 'How much freezer space do I need?',
      a:
        'Plan on roughly 8–10 cubic feet for a half beef — a dedicated chest freezer. A $200–$300 chest freezer typically pays for itself in the first fill. A quarter share fits in about 4–5 cubic feet.',
    },
    {
      // NO PERCENTAGE HERE (2026-08-18). This answer used to promise "a deposit
      // of about 25% of the share price". Under the current money model the
      // buyer's card is charged the deposit PLUS the platform fee on the FULL
      // price, so the real charge is closer to 35% at a 10% tier — the bare
      // deposit percent understates what the buyer actually pays and anchors
      // them low. The page BODY was corrected on 2026-08-13 (the price table
      // prints "deposit to reserve → refundable until the rancher accepts");
      // this answer was missed, so the same page rendered both versions and the
      // false one fed the FAQPage JSON-LD. The mechanism still gets explained —
      // refundable, balance at final weight, nothing paid up front — and the
      // exact total is shown on the deposit page, where it is computed.
      q: 'How does the deposit work?',
      a:
        'You reserve your share with a deposit rather than the full price up front. It is fully refundable until the rancher accepts your reservation, and the balance is due at final weight. Your exact deposit total is shown before you pay.',
    },
    {
      q: `What if there's no ranch near me in ${stateName}?`,
      a:
        `Join the list. We are actively recruiting family ranches in ${stateName}, and the moment one goes live we route waiting families first — in the order they signed up.`,
    },
  ];
}
