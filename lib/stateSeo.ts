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
import { deriveLadder, DEPOSIT_PCT } from './pricing';

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

/** '$1,100–$1,950' for a tier range. */
export function fmtRange(r: TierRange): string {
  return `${fmtUsd(r.low)}–${fmtUsd(r.high)}`;
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
export function stateFaqs(stateName: string): FaqItem[] {
  const r = typicalShareRanges();
  return [
    {
      q: `How much does half a cow cost in ${stateName}?`,
      a:
        `A typical half-beef share runs ${fmtRange(r.half)} all-in (animal + processing), depending on the ranch and final weight — about $8–$11 per pound of hanging weight. Boxed-delivery services work out to roughly $13–$17 per pound for comparable cuts. A quarter share typically runs ${fmtRange(r.quarter)}, a whole ${fmtRange(r.whole)}.`,
    },
    {
      q: 'How much freezer space do I need?',
      a:
        'Plan on roughly 8–10 cubic feet for a half beef — a dedicated chest freezer. A $200–$300 chest freezer typically pays for itself in the first fill. A quarter share fits in about 4–5 cubic feet.',
    },
    {
      q: 'How does the deposit work?',
      a:
        `You reserve your share with a deposit of about ${r.depositPercent}% of the share price. It is fully refundable until the rancher accepts your reservation, and the balance is due at final weight — you never pay everything up front.`,
    },
    {
      q: `What if there's no ranch near me in ${stateName}?`,
      a:
        `Join the list. We are actively recruiting family ranches in ${stateName}, and the moment one goes live we route waiting families first — in the order they signed up.`,
    },
  ];
}
