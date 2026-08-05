// lib/nationwideFit.ts
//
// BUYER-FIT GATE for the CONTROLLED NATIONWIDE FALLBACK (operator decision
// 2026-08-04, second half): a nationwide-approved rancher is typically a
// SPECIALTY producer — premium-priced, production-claim-driven — and "must
// NOT get every customer, only the right customer." So when the fallback in
// app/api/matching/suggest fires (no local supply, switch on, buyer opted
// in), each candidate rancher is additionally checked for BUYER FIT before
// it can win the match. A buyer who fits nobody stays waitlisted for local
// supply — exactly the pre-fallback status quo, zero regression.
//
// The gate is GENERIC by construction: every verdict derives from the
// candidate rancher's OWN attributes (its cut prices, its `Beef Types`
// text), never from a hardcoded ranch. Add a second nationwide rancher with
// different prices/claims and the gate evaluates them on their own terms.
//
// Fit rules (all pure, unit-tested, no Airtable/network):
//   1. BUDGET — parse the buyer's `Budget` singleSelect with the SAME
//      semantics the route's price filter uses (parseBudgetCeiling lives
//      here now; the route re-imports it — one parser, never two). A
//      parsable ceiling ≥ the rancher's CHEAPEST offered cut → fit.
//   2. HARD FLOOR — a parsable ceiling BELOW the cheapest cut → NOT fit,
//      even when the preference rule matches. Never route a buyer into
//      sticker shock because they typed "grass-fed" once.
//   3. PREFERENCE — no parsable budget, but the buyer's `Interest Beef`
//      free text expresses one of the rancher's own `Beef Types` signals
//      (grass-fed / grass-finished / regenerative / organic / breed terms,
//      via the token normalizer below) → fit. An expressed specialty
//      seeker is the right customer even if they skipped the budget
//      question.
//   4. NEITHER — no parsable budget AND no expressed preference → NOT fit
//      (conservative). The buyer waits for local supply.

// ── Airtable field readers ───────────────────────────────────────────────────

/**
 * Read a buyer/rancher text-ish field. Airtable singleSelects arrive as a
 * plain string OR an {id, name, color} object depending on read path (same
 * dual-shape handling as normalizeNationwidePreference / tierFor). Free-text
 * fields are plain strings. Anything else → ''.
 */
function readFieldText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && typeof (raw as any).name === 'string') {
    return String((raw as any).name);
  }
  return '';
}

// ── Budget parsing (moved verbatim from app/api/matching/suggest) ────────────

/**
 * Parse a buyer budget range into a numeric ceiling.
 * Current brackets: $1000-$1500, $2000-$2500, $4000-$5000, $5000+, "Just exploring".
 * Legacy brackets still accepted for buyers stored before the form rework:
 * "<$500", "$500-$1000", "$1000-$2000", "$2000+", "Unsure", "Not Sure".
 *
 * Returns 0 for "Just exploring" (no rancher should match — these aren't
 * real buyers yet). Returns Infinity for "Unsure" (legacy permissive).
 *
 * Moved here from app/api/matching/suggest/route.ts (2026-08-04) so the
 * nationwide fit gate and the route's isPriceFit share ONE parser. Semantics
 * unchanged — the route re-imports this.
 */
export const parseBudgetCeiling = (range: string): number => {
  if (!range) return Infinity;
  const r = range.trim().toLowerCase();
  if (r === '') return Infinity;
  // Hard reject: "just exploring" buyers shouldn't match any rancher.
  // Returning 0 makes isPriceFit reject every priced rancher. They'll
  // stay in nurture until they pick a real budget.
  if (r === 'just exploring') return 0;
  if (r === 'unsure' || r === 'not sure') return Infinity;
  if (r.startsWith('<')) {
    const n = parseInt(r.replace(/[^0-9]/g, ''), 10);
    return isFinite(n) ? n : Infinity;
  }
  if (r.endsWith('+')) return Infinity; // e.g. "$2000+", "$5000+"
  // Range like "$1000-$1500" — take the upper bound.
  const parts = r.split('-');
  if (parts.length === 2) {
    const upper = parseInt(parts[1].replace(/[^0-9]/g, ''), 10);
    if (isFinite(upper)) return upper;
  }
  const single = parseInt(r.replace(/[^0-9]/g, ''), 10);
  return isFinite(single) ? single : Infinity;
};

/**
 * Classify a raw `Budget` field for the FIT gate, on TOP of parseBudgetCeiling
 * (which the route's isPriceFit keeps using unchanged).
 *
 * The distinction parseBudgetCeiling deliberately collapses — Infinity for
 * BOTH "$5000+" (an expressed top bracket) and ""/"Unsure" (never answered) —
 * matters here: an expressed "$5000+" buyer is budget-qualified for anything,
 * while a buyer who never answered must NOT be treated as unbounded (that
 * would wave EVERY silent buyer through a premium gate). So:
 *   known=false → empty / Unsure / Not Sure / digit-free garbage — the buyer
 *                 never expressed a budget; only the preference rule can fit.
 *   known=true  → an expressed bracket; ceiling = parseBudgetCeiling(text)
 *                 ("Just exploring" is an EXPRESSED 0 — hard floor applies).
 */
export function classifyBudget(raw: unknown): { known: boolean; ceiling: number } {
  const text = readFieldText(raw).trim();
  const r = text.toLowerCase();
  if (r === '' || r === 'unsure' || r === 'not sure') return { known: false, ceiling: Infinity };
  // "Just exploring" is an expressed choice (ceiling 0). Anything else with
  // no digit at all ("idk", "call me") parses to nothing — treat as unknown
  // rather than letting parseInt fall through to Infinity-permissive.
  if (r !== 'just exploring' && !/[0-9]/.test(r)) return { known: false, ceiling: Infinity };
  return { known: true, ceiling: parseBudgetCeiling(text) };
}

// ── Beef-type signal normalizer ──────────────────────────────────────────────

/**
 * Canonical specialty signals recognized in free text — production claims
 * plus common specialty breed terms. Compound phrases are matched via the
 * adjacent-bigram join below, so "grass-fed", "Grass Fed", "grassfed" and
 * "100% grass-finished" all land on the same token. This is a VOCABULARY of
 * beef-specialty language, not one ranch's word list — a signal only ever
 * counts when it appears on BOTH sides (buyer interest AND rancher's own
 * `Beef Types`), so an unused entry is inert.
 */
const BEEF_SIGNALS = [
  // Production / finishing claims
  'grassfed', 'grassfinished', 'pastureraised', 'pasturefinished',
  'regenerative', 'organic', 'nongmo', 'hormonefree', 'antibioticfree',
  'grainfree', 'cornfree', 'soyfree', 'dryaged', 'halal',
  // Specialty breed terms
  'wagyu', 'akaushi', 'angus', 'hereford', 'highland', 'longhorn',
  'galloway', 'charolais', 'brangus', 'shorthorn', 'devon', 'dexter',
] as const;

/**
 * Extract the canonical specialty signals a free-text field expresses.
 * Tokenizes on non-alphanumerics, then matches signals against every word
 * AND every ADJACENT word pair joined ("grass fed" → "grassfed"). Pair-only
 * joining (not whole-string collapse) keeps cross-word false positives out:
 * "…organ I couldn't…" never manufactures "organic".
 *
 * One industry-standard implication: grass-FINISHED cattle are grass-fed by
 * definition, so a grassfinished text also emits grassfed (a "grass fed"
 * seeker matches a "grass-finished" producer). No other inference.
 */
export function extractBeefSignals(raw: unknown): Set<string> {
  const words = readFieldText(raw).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    grams.add(words[i]);
    if (i + 1 < words.length) grams.add(words[i] + words[i + 1]);
  }
  const signals = new Set<string>();
  for (const s of BEEF_SIGNALS) if (grams.has(s)) signals.add(s);
  if (signals.has('grassfinished')) signals.add('grassfed');
  return signals;
}

// ── The verdict ──────────────────────────────────────────────────────────────

export interface NationwideFitVerdict {
  fit: boolean;
  /** Human-readable why — surfaced in the route's skip log line. */
  reason: string;
}

/** Cheapest cut the rancher has actually priced, or null when unpriced. */
function cheapestOfferedCut(rancher: Record<string, unknown>): number | null {
  const priced = [rancher['Quarter Price'], rancher['Half Price'], rancher['Whole Price']]
    .map((p) => Number(p) || 0)
    .filter((p) => p > 0);
  return priced.length > 0 ? Math.min(...priced) : null;
}

/**
 * Is this buyer the RIGHT customer for this nationwide candidate?
 * Pure — reads only the fields passed in. See the rule table at the top of
 * this file. Reads buyer `Budget` + `Interest Beef`, rancher `Beef Types` +
 * `Quarter/Half/Whole Price` — all verified live field names.
 */
export function nationwideFitVerdict(
  buyer: Record<string, unknown>,
  rancher: Record<string, unknown>,
): NationwideFitVerdict {
  const budget = classifyBudget(buyer?.['Budget']);
  const cheapest = cheapestOfferedCut(rancher || {});
  const buyerSignals = extractBeefSignals(buyer?.['Interest Beef']);
  const rancherSignals = extractBeefSignals(rancher?.['Beef Types']);
  const shared = [...buyerSignals].filter((s) => rancherSignals.has(s));

  // Rule 2 — HARD FLOOR first: an expressed ceiling below the rancher's
  // cheapest cut is a sticker-shock route; preference cannot override it.
  if (budget.known && cheapest !== null && budget.ceiling < cheapest) {
    return {
      fit: false,
      reason: `budget ceiling $${budget.ceiling} below cheapest cut $${cheapest}`,
    };
  }

  // Rule 1 — expressed budget covers the cheapest offered cut. When the
  // rancher is unpriced (cheapest null) only an UNBOUNDED expressed bracket
  // ("$5000+") clears on budget grounds — a finite ceiling can't be verified
  // against nothing and falls through to the preference rule.
  if (budget.known && budget.ceiling >= (cheapest ?? Infinity)) {
    return {
      fit: true,
      reason: cheapest !== null
        ? `budget ceiling covers cheapest cut ($${cheapest})`
        : 'unbounded budget bracket',
    };
  }

  // Rule 3 — the buyer's own words express what this rancher raises.
  if (shared.length > 0) {
    return { fit: true, reason: `interest matches rancher specialty (${shared.join(', ')})` };
  }

  // Rule 4 — nothing established fit. Conservative default: stay waitlisted
  // for local supply (status quo before the fallback existed).
  return {
    fit: false,
    reason: budget.known
      ? 'rancher has no priced cut to verify budget against and no specialty interest expressed'
      : 'no parsable budget and no specialty interest expressed',
  };
}
