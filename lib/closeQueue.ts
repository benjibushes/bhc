// lib/closeQueue.ts
//
// THE CALL QUEUE — "who do I ring RIGHT NOW to make money today?"
//
// /admin/desk already answers "what is stale" by bucketing referrals into
// urgency lanes. It does NOT answer the only question that matters on a
// selling day: of the open deals, which ONE is worth the next phone call.
// This module is that answer, and it is deliberately DUMB: a weighted sum of
// five signals that already exist on the referral row. No model, no learning,
// no config UI — tune the constants below and the whole desk re-ranks.
//
// Every input is verified against the live Airtable `Referrals` schema:
//   Sale Amount · Budget Range · Intent Score · Status · Intro Sent At ·
//   Last Chased At · Created At.  `rancherCanCapture` is derived by the caller
//   from lib/rancherEligibility.isRancherOnConnect — it is NOT a stored field.
//
// PURE: no I/O, no Date.now() (the caller passes `now`), no mutation of input.

// ─── TUNING CONSTANTS — the whole scoring model lives here ─────────────────

/**
 * Weights sum to 100, so a score reads as "% of a perfect deal".
 *
 * Why this order:
 *   dealValue 30 — BHC earns a flat 10% of the deal, so deal size IS revenue.
 *   stage     25 — a deal at Awaiting Payment converts far more often per call
 *                  than one at Intro Sent. Proximity to money beats everything
 *                  except the size of the money.
 *   capture   20 — a lead routed to a rancher who cannot take a Connect deposit
 *                  earns BHC nothing automatically even when it closes. It is
 *                  still worth calling (relationship, manual invoice), just
 *                  never ahead of a deal that pays the platform on close.
 *   staleness 15 — deals rot. This is the "call it before it dies" pressure.
 *   intent    10 — deliberately LOW. In live data most rows sit at 85-100
 *                  including everything that later closed lost, so it is a
 *                  weak discriminator; it breaks ties rather than driving.
 */
export const WEIGHTS = {
  dealValue: 30,
  stage: 25,
  capture: 20,
  staleness: 15,
  intent: 10,
} as const;

export type ReasonKey = keyof typeof WEIGHTS;

/** Platform average deal (22 closes / $35,627 gross as of 2026-07-25). */
export const DEFAULT_DEAL_VALUE = 1619;

/** Deal value saturates here so one whole-cow whale cannot swamp the queue. */
export const DEAL_VALUE_CEILING = 3000;

/** BHC takes 10%, added on top of the buyer's price (docs/BUSINESS-MODEL.md). */
export const BHC_FEE_RATE = 0.1;

/**
 * STALENESS — ONE treatment, chosen and documented on purpose.
 *
 * Urgency rises linearly with days since the last touch and saturates at
 * STALENESS_FULL_DAYS. Freshness is NOT rewarded: a deal touched an hour ago
 * needs no call, and the desk's existing buckets already surface new arrivals.
 * The queue's job is to stop money rotting, so "untouched longest" is the only
 * direction this signal ever pushes. A row with no usable date at all reads as
 * fully stale — an un-dated open deal is a deal nobody is working.
 */
export const STALENESS_FULL_DAYS = 14;

/** Stage → 0..1 proximity to money. Anything unknown lands mid-table. */
const STAGE_WEIGHT: Record<string, number> = {
  'Awaiting Payment': 1.0,
  Negotiation: 0.9,
  'Rancher Contacted': 0.6,
  'Intro Sent': 0.45,
  'Pending Approval': 0.35,
};
const STAGE_WEIGHT_DEFAULT = 0.3;

/** Statuses that are not live deals — never in the call queue. */
const CLOSED_STATUSES = new Set(['Closed Won', 'Closed Lost', 'Dormant', 'Waitlisted']);

/** Default queue depth. Ten calls is a morning. */
export const DEFAULT_QUEUE_LIMIT = 10;

// ─── Types ─────────────────────────────────────────────────────────────────

/** The subset of GET /api/referrals this module needs. */
export interface CloseQueueRow {
  id: string;
  status: string;
  buyerName: string;
  buyerState: string;
  buyerEmail: string;
  buyerPhone: string;
  rancherName: string;
  hasRancher: boolean;
  /** From isRancherOnConnect(rancher) — can this rancher take a deposit? */
  rancherCanCapture: boolean;
  intentScore: number;
  saleAmount: number;
  budgetRange: string;
  createdAt: string;
  introSentAt: string;
  lastChasedAt: string;
}

export interface CloseQueueScore {
  score: number;
  /** Each signal normalised to 0..1, for display + debugging. */
  signals: Record<ReasonKey, number>;
  /** Weighted points contributed by each signal. */
  points: Record<ReasonKey, number>;
  topReason: ReasonKey;
  why: string;
  estValue: number;
  estFee: number;
  daysSinceTouch: number;
}

export type RankedCloseQueueRow = CloseQueueRow & CloseQueueScore;

// ─── Helpers ───────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

function toNum(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Midpoint of a `Budget Range` bucket, or null when the bucket carries no
 * number ("Unsure", "Just exploring", empty).
 *
 * Live values look like: "<$500", "$500-$1000", "$1000-$2000", "$1000-$1500",
 * "$1,500–$2,500" (note: en dash and thousands separators both occur).
 */
export function budgetRangeMidpoint(raw: string | undefined | null): number | null {
  if (!raw) return null;
  // Strip currency + thousands separators, then pull every number out.
  const nums = String(raw)
    .replace(/[$,]/g, '')
    .match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length === 0) return null;
  const parsed = nums.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (parsed.length === 0) return null;
  if (parsed.length === 1) return parsed[0];
  const lo = Math.min(...parsed);
  const hi = Math.max(...parsed);
  return round2((lo + hi) / 2);
}

/**
 * Best-available dollar estimate for a deal:
 *   1. a real `Sale Amount` (the founder has quoted it)
 *   2. the midpoint of the buyer's stated `Budget Range`
 *   3. the platform average
 */
export function estimateDealValue(row: CloseQueueRow): number {
  const sale = toNum(row.saleAmount);
  if (sale > 0) return round2(sale);
  const mid = budgetRangeMidpoint(row.budgetRange);
  if (mid && mid > 0) return round2(mid);
  return DEFAULT_DEAL_VALUE;
}

/** BHC's cut of a deal — a flat 10% added on top of the buyer's price. */
export function estimateBhcFee(dealValue: number): number {
  return round2(toNum(dealValue) * BHC_FEE_RATE);
}

/**
 * Whole days since anyone last touched this deal. Uses the most recent of
 * Last Chased At / Intro Sent At / Created At. No usable date ⇒ fully stale.
 */
export function daysSinceTouch(row: CloseQueueRow, now: number): number {
  const stamps = [row.lastChasedAt, row.introSentAt, row.createdAt]
    .map((s) => (s ? Date.parse(s) : Number.NaN))
    .filter((t) => Number.isFinite(t));
  if (stamps.length === 0) return STALENESS_FULL_DAYS;
  const latest = Math.max(...stamps);
  const days = Math.floor((now - latest) / 86_400_000);
  return days > 0 ? days : 0;
}

/** Plain-English one-liner for the signal that contributed the most points. */
function reasonSentence(
  key: ReasonKey,
  row: CloseQueueRow,
  estValue: number,
  estFee: number,
  stale: number,
): string {
  const money = (n: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(n);

  switch (key) {
    case 'dealValue':
      return `Biggest cheque on the board — ${money(estValue)} deal, ${money(estFee)} to BHC.`;
    case 'stage':
      if (row.status === 'Awaiting Payment') return 'Balance is due — collect it.';
      if (row.status === 'Negotiation') return 'In negotiation — closest to a yes.';
      return `Furthest along of the open deals (${row.status}).`;
    case 'capture':
      return `${row.rancherName || 'Matched rancher'} can take the deposit — this one pays BHC on close.`;
    case 'staleness':
      return `Going cold — ${stale} days with no contact.`;
    case 'intent':
      return `Buyer intent ${Math.round(toNum(row.intentScore))} — one of the hottest leads open.`;
  }
}

// ─── Scoring ───────────────────────────────────────────────────────────────

/**
 * Score one open referral 0..100. Higher = call this one sooner.
 * Pure: same row + same `now` always yields the same score.
 */
export function scoreCloseQueueRow(row: CloseQueueRow, now: number): CloseQueueScore {
  const estValue = estimateDealValue(row);
  const estFee = estimateBhcFee(estValue);
  const stale = daysSinceTouch(row, now);

  const signals: Record<ReasonKey, number> = {
    dealValue: clamp01(estValue / DEAL_VALUE_CEILING),
    stage: STAGE_WEIGHT[row.status] ?? STAGE_WEIGHT_DEFAULT,
    // An unmatched referral has no rancher, so it cannot capture either.
    capture: row.hasRancher && row.rancherCanCapture ? 1 : 0,
    staleness: clamp01(stale / STALENESS_FULL_DAYS),
    intent: clamp01(toNum(row.intentScore) / 100),
  };

  const points = {
    dealValue: signals.dealValue * WEIGHTS.dealValue,
    stage: signals.stage * WEIGHTS.stage,
    capture: signals.capture * WEIGHTS.capture,
    staleness: signals.staleness * WEIGHTS.staleness,
    intent: signals.intent * WEIGHTS.intent,
  };

  const score = round2(
    points.dealValue + points.stage + points.capture + points.staleness + points.intent,
  );

  // Top contributor. Iteration order is the WEIGHTS declaration order, which
  // doubles as the tie-break priority — deal size wins a dead heat.
  let topReason: ReasonKey = 'dealValue';
  for (const key of Object.keys(WEIGHTS) as ReasonKey[]) {
    if (points[key] > points[topReason]) topReason = key;
  }

  return {
    score,
    signals,
    points,
    topReason,
    why: reasonSentence(topReason, row, estValue, estFee, stale),
    estValue,
    estFee,
    daysSinceTouch: stale,
  };
}

export interface RankOptions {
  now: number;
  limit?: number;
}

/**
 * Rank the OPEN referrals into a call queue, hottest first.
 * Closed / lost / dormant / waitlisted rows are dropped entirely.
 * Ties break on id so the list never reshuffles between renders.
 */
export function rankCloseQueue(
  rows: CloseQueueRow[],
  { now, limit = DEFAULT_QUEUE_LIMIT }: RankOptions,
): RankedCloseQueueRow[] {
  return rows
    .filter((r) => !CLOSED_STATUSES.has(r.status))
    .map((r) => ({ ...r, ...scoreCloseQueueRow(r, now) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}
