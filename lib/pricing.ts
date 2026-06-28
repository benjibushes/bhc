// lib/pricing.ts — single source of truth for BHC tier price + deposit derivation.
//
// Used by:
//   - the rancher setup wizard (auto-derive the half/quarter ladder + deposits
//     from one Whole-price input; live $/lb sanity helper)
//   - app/api/rancher/setup/route.ts (server-side per-lb mis-entry floor)
//   - app/api/checkout/deposit/route.ts (charge-time plausibility guard)
//
// All money in WHOLE DOLLARS. Change the constants below to retune the whole
// platform in one place (Ben's call: deposit %, multipliers, floors).
//
// Model (2026-06-20 research): rancher enters ONE number — the whole-cow total —
// and the system derives Half (~0.55×) + Quarter (~0.28×) and each tier's
// reserve deposit (25% of that tier's price). Half is NOT naive ½: fixed
// processing/packaging spread over less meat means small shares carry a ~10–20%
// per-lb premium, so naive division would under-price the cuts that make up most
// orders. See docs/superpowers/specs/2026-06-20-pricing-onboarding-design.md.

// ── Tunable constants ──────────────────────────────────────────────────────
export const DEPOSIT_PCT = 0.25;     // deposit = 25% of each tier's price
export const DEPOSIT_MIN = 100;      // never derive a deposit below $100
export const HALF_MULT = 0.55;       // half    ≈ 55% of whole
export const QUARTER_MULT = 0.28;    // quarter ≈ 28% of whole
export const EIGHTH_MULT = 0.15;     // eighth  ≈ 15% of whole (only if offered)

// Any positive tier price below this is almost certainly a per-pound value typed
// into a total field (real cow shares start ~$200+). DD Ranch published a $7.40
// "whole cow" exactly this way. The wizard, save route, and charge path all gate
// on this so a per-lb mis-entry can never publish or be charged.
export const MIN_TIER_PRICE = 100;
export const MIN_WHOLE_PRICE = 300;  // softer whole-specific floor for the warning copy

// Plausible per-lb (hanging weight) band for the soft sanity warning.
export const PLAUSIBLE_PER_LB_MIN = 3;
export const PLAUSIBLE_PER_LB_MAX = 15;

// ── Helpers ────────────────────────────────────────────────────────────────
/** Round to the nearest $50 — clean, confident numbers for a premium brand. */
export function roundTo50(x: number): number {
  return Math.round(x / 50) * 50;
}

export interface PriceLadder {
  whole: number;
  half: number;
  quarter: number;
  eighth?: number;
}

/**
 * Derive the half/quarter (and optional eighth) ladder from a single whole price.
 * Returns rounded-to-$50 totals. Whole is echoed (rounded) for consistency.
 */
export function deriveLadder(wholePrice: number, opts?: { eighth?: boolean }): PriceLadder {
  const w = Number(wholePrice);
  if (!Number.isFinite(w) || w <= 0) {
    return { whole: 0, half: 0, quarter: 0, ...(opts?.eighth ? { eighth: 0 } : {}) };
  }
  const ladder: PriceLadder = {
    whole: roundTo50(w),
    half: roundTo50(w * HALF_MULT),
    quarter: roundTo50(w * QUARTER_MULT),
  };
  if (opts?.eighth) ladder.eighth = roundTo50(w * EIGHTH_MULT);
  return ladder;
}

/**
 * Derive a tier's reserve deposit from its OWN price. Always strictly less than
 * the price (so the buyer never pays 100% upfront), floored at DEPOSIT_MIN.
 * Returns 0 for a missing/invalid price.
 */
export function deriveDeposit(tierPrice: number, pct = DEPOSIT_PCT, min = DEPOSIT_MIN): number {
  const p = Number(tierPrice);
  if (!Number.isFinite(p) || p <= 0) return 0;
  const raw = roundTo50(p * pct);
  const floored = Math.max(raw, min);
  // Cap at price minus one rounding step ($50) so the deposit is STRICTLY less
  // than the price — a deposit EQUAL to the price defeats the reserve model
  // (balance due would be $0, the "<price" invariant breaks). At the boundary
  // p==100 the floor (100) would otherwise collapse the deposit to the full
  // price; capping at p-50 keeps a real partial. Tiny prices at/below
  // MIN_TIER_PRICE (=100) are blocked upstream, so on any chargeable price
  // p-50 stays >= 50 and the deposit never goes non-positive.
  return Math.min(floored, p - 50);
}

/** Implied $/lb for a total price given hanging weight (0 if no weight given). */
export function impliedPerLb(totalPrice: number, hangingLbs: number): number {
  const lbs = Number(hangingLbs);
  if (!Number.isFinite(lbs) || lbs <= 0) return 0;
  return Number(totalPrice) / lbs;
}

export interface Plausibility {
  ok: boolean;
  reason?: 'empty' | 'too_low';
  message?: string;
}

/**
 * Is this WHOLE-cow TOTAL price plausible? Catches per-lb values typed into a
 * total field (the DD Ranch $7.40-whole-cow class of bug).
 */
export function checkWholePrice(wholePrice: number): Plausibility {
  const w = Number(wholePrice);
  if (!Number.isFinite(w) || w <= 0) {
    return { ok: false, reason: 'empty', message: 'Enter a whole-cow price.' };
  }
  if (w < MIN_WHOLE_PRICE) {
    return {
      ok: false,
      reason: 'too_low',
      message: `$${w} looks like a per-pound price, not a whole-cow total. Whole cows are usually $2,000–$3,500. Use the "$ / lb" option if you meant per pound.`,
    };
  }
  return { ok: true };
}

/**
 * Floor guard for ANY tier price (quarter/half/whole). 0 (= not set) passes;
 * a positive value below MIN_TIER_PRICE fails (per-lb mis-entry).
 */
export function isTierPricePlausible(price: number): boolean {
  const p = Number(price);
  if (!Number.isFinite(p)) return false;
  return p === 0 || p >= MIN_TIER_PRICE;
}
