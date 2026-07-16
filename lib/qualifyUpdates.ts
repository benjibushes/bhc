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
    // Every completed funnel gets the completion stamp — hold or route.
    'Funnel Completed At': input.completedAt,
  };

  // Route-eligible ONLY: `Qualified At` is the routing gate's ready signal.
  if (!isExplicitlyNotReady(input.tier, input.timing)) {
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
