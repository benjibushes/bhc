// lib/sourceQuality.ts
//
// SOURCE QUALITY (2026-07-06, conversion slice 4): per-source funnel rates so
// Ben can see WHICH source sends ready-to-buy leads that actually PAY — the
// feedback loop that keeps lead quality high once ad spend turns on.
//
// The admin analytics route already buckets each Consumer Source through
// signups → matches → closes → ROAS. This adds the two missing quality
// dimensions:
//   - qualifiedRate = qualified / signups  (top-of-funnel: does this source
//     send people who pass the quiz at all?)
//   - depositsPaid              (bottom-of-funnel TRUTH: real tier_v2 money,
//     not just legacy Closed-Won — the number that says "this source pays")
//   - payRate = depositsPaid / signups     (end-to-end: signup → real money)
//
// A source with high qualifiedRate but low payRate leaks in the MIDDLE
// (routing/connect); one with low qualifiedRate leaks at the TOP (bad
// targeting). Same spend, different fix — that's why the split matters before
// scaling ads.
//
// Pure + dependency-free. The route does the Airtable walking; this only does
// the rate math (div-by-zero → null so the UI renders "—", never NaN).

export interface SourceCounts {
  signups: number;
  qualified: number;
  matches: number;
  depositsPaid: number;
  closes: number;
}

export interface SourceQualityRates {
  /** qualified / signups — top-of-funnel quality. null when no signups. */
  qualifiedRate: number | null;
  /** depositsPaid / signups — signup → real money. null when no signups. */
  payRate: number | null;
  /** depositsPaid / qualified — of quiz-passers, how many actually paid. */
  qualifiedToPaidRate: number | null;
}

/** A safe ratio in [0,1]; null when the denominator is 0/invalid. */
function rate(numer: number, denom: number): number | null {
  if (!Number.isFinite(numer) || !Number.isFinite(denom) || denom <= 0) return null;
  return numer / denom;
}

export function sourceQualityRates(c: SourceCounts): SourceQualityRates {
  return {
    qualifiedRate: rate(c.qualified, c.signups),
    payRate: rate(c.depositsPaid, c.signups),
    qualifiedToPaidRate: rate(c.depositsPaid, c.qualified),
  };
}
