// lib/qualifyUpdates.ts
//
// Pure decision layer for what /api/qualify writes onto the Consumer record
// (2026-07-15, funnel truth PR). Extracted so the two invariants that were
// silently violated in production are pinned by unit tests:
//
//   1. NEVER auto-stamp `Response Ack At`. The old funnel hard-coded
//      answers.ack=true for every completer, and the rancher lead email then
//      claimed the buyer "acknowledged commitment to respond within 24 hours"
//      — fabricated. The stamp now requires ackConfirmedAt (the ISO timestamp
//      the client mints ONLY when the buyer taps the real commitment button).
//
//   2. The explicitly-not-ready hold branch NEVER stamps `Qualified At`.
//      It used to — 234 buyers carried the stamp while explicitly not ready,
//      and every routing gate treats the stamp as "ready". The hold branch
//      stamps `Funnel Completed At` only; the route-eligible path stamps BOTH.

export interface QualifyUpdatesInput {
  tier: string; // validated quiz tier ('Quarter'|'Half'|'Whole'|'Not Sure')
  timing: string; // validated quiz timing
  answersJson: string; // JSON.stringify of the validated answers
  score: number;
  completedAt: string; // server ISO timestamp for this submission
  // Raw body.ackConfirmedAt — unknown until validated here. Present + parseable
  // ⇔ the buyer tapped the commitment button.
  ackConfirmedAt?: unknown;
  // True when the value is a resume-mode hydration DEFAULT ('Not Sure' /
  // 'Just exploring' coerced from an empty POST + no usable stored answer),
  // NOT something the buyer actually chose. A hold that rests solely on
  // defaults must not stamp Funnel Completed At — that stamp would fabricate
  // a "not ready" self-ID and permanently drop the buyer from the
  // abandoned-quiz-nudge drip ({Funnel Completed At}="" clause).
  tierDefaulted?: boolean;
  timingDefaulted?: boolean;
}

// Legacy /access form vocab (pre-2026-06-18) → quiz Timing vocab. The legacy
// form never used the quiz's values, so an unmapped hydration coerced every
// legacy-created WAITING buyer to 'Just exploring' — an auto-hold they never
// chose. Unknown values pass through (the caller's VALID_TIMINGS check still
// gates what's accepted).
const LEGACY_TIMING_MAP: Record<string, string> = {
  '1-3 months': 'Within 60 days',
  '3-6 months': 'Within 90 days',
};

export function normalizeLegacyTiming(raw: string): string {
  const v = String(raw || '').trim();
  return LEGACY_TIMING_MAP[v] || v;
}

// Pre-06-18 signups stored timing in Notes ('[Timing: 1-3 months]'), not the
// Timing field (app/api/consumers/route.ts legacy branch). Parse it back out
// so resume-mode hydration can score legacy buyers on their real answer.
export function timingFromNotes(notes: string): string {
  const m = /\[Timing:\s*([^\]]+)\]/.exec(String(notes || ''));
  return m ? m[1].trim() : '';
}

// Buyer explicitly self-identified as not ready — held in nurture, not routed.
export function isExplicitlyNotReady(tier: string, timing: string): boolean {
  return tier === 'Not Sure' || timing === 'Just exploring';
}

// True only for a real, parseable ISO datetime string (the tap evidence).
export function isValidAckConfirmedAt(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0 && Number.isFinite(Date.parse(v));
}

export function buildQualifyConsumerUpdates(input: QualifyUpdatesInput): Record<string, any> {
  const updates: Record<string, any> = {
    'Qualification Answers': input.answersJson,
    'Qualification Score': input.score,
  };

  // Every completed funnel gets the completion stamp — hold or route — EXCEPT
  // when the hold rests SOLELY on hydration defaults (see tierDefaulted /
  // timingDefaulted above): the buyer never said "not ready", so the record
  // stays chaseable by the abandoned-quiz-nudge drip instead of dead-ending.
  const notReady = isExplicitlyNotReady(input.tier, input.timing);
  const holdFromDefaultsOnly =
    notReady &&
    !(input.tier === 'Not Sure' && !input.tierDefaulted) &&
    !(input.timing === 'Just exploring' && !input.timingDefaulted);
  if (!holdFromDefaultsOnly) {
    updates['Funnel Completed At'] = input.completedAt;
  }

  // Route-eligible ONLY: `Qualified At` is the routing gate's ready signal.
  if (!notReady) {
    updates['Qualified At'] = input.completedAt;
  }

  // Real commitment tap only. Stored as server time (the client value proves
  // the tap happened; the server clock is the stored truth).
  if (isValidAckConfirmedAt(input.ackConfirmedAt)) {
    updates['Response Ack At'] = input.completedAt;
  }

  // "Not Sure" / "Just exploring" never narrow the stored signup answers.
  if (input.tier !== 'Not Sure') {
    updates['Order Type'] = input.tier;
  }
  if (input.timing !== 'Just exploring') {
    updates['Timing'] = input.timing;
  }

  return updates;
}
