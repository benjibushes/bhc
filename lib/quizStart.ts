// lib/quizStart.ts
//
// QUIZ-START INSTRUMENTATION (2026-07-28 conversion audit): the Funnel Events
// table has 'signup' (contact captured) + stage transitions + 'match_sent' —
// but NOTHING fires before contact, so pre-contact abandonment (answered a
// question, never left an email) was structurally invisible. With ads about to
// run, the top of the funnel would be blind.
//
// The event fires ONCE per browser session when the buyer answers the FIRST
// quiz question in BuyerFunnel (NOT on page view — bots and bounces would
// pollute the count; the first ANSWER is the intent signal). Delivery is a
// fire-and-forget navigator.sendBeacon to /api/funnel/quiz-start, which writes
// through the existing funnelRecord() pipeline (lib/funnelMetrics — the exact
// mechanism 'signup' uses). No new event pipeline.
//
// This module is PURE (no imports, no window/process reads) so the double-fire
// guard and the server-side payload clamp are unit-testable without a browser
// or Airtable. The component and the API route stay thin.

/** Stage name written to Funnel Events. Dashboard reads pair it with 'signup'. */
export const QUIZ_START_STAGE = 'quiz_start';

/** sessionStorage flag — one quiz_start per browser session, across remounts. */
export const QUIZ_START_SESSION_KEY = 'bhc_quiz_start_fired';

/** Beacon endpoint (app/api/funnel/quiz-start). */
export const QUIZ_START_BEACON_PATH = '/api/funnel/quiz-start';

// Metadata keys the beacon is allowed to carry — mirrors what the 'signup'
// event stores (source/state/utm) so funnel queries can join on the same
// dimensions. Anything else in the POST body is dropped server-side.
export const QUIZ_START_METADATA_KEYS = [
  'state',
  'source',
  'campaign',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

export type QuizStartMetadataKey = (typeof QUIZ_START_METADATA_KEYS)[number];
export type QuizStartPayload = Partial<Record<QuizStartMetadataKey, string>>;

const MAX_VALUE_LEN = 200;

/**
 * Double-fire guard, pure half. True only when this is a FRESH funnel entry
 * (resume-mode buyers already have a 'signup' event — counting them again
 * would corrupt the quiz_start → signup conversion rate) and nothing has
 * fired yet this session (component ref OR sessionStorage flag).
 */
export function shouldFireQuizStart(opts: {
  mode: string;
  alreadyFired: boolean;
}): boolean {
  if (opts.alreadyFired) return false;
  return opts.mode === 'fresh';
}

/**
 * Client-side payload builder — clamps every value and drops empties so the
 * beacon body stays tiny and the shape is stable.
 */
export function buildQuizStartPayload(
  input: Partial<Record<QuizStartMetadataKey, string | undefined | null>>,
): QuizStartPayload {
  const out: QuizStartPayload = {};
  for (const key of QUIZ_START_METADATA_KEYS) {
    const v = String(input[key] ?? '').trim();
    if (v) out[key] = v.slice(0, MAX_VALUE_LEN);
  }
  return out;
}

/**
 * Server-side clamp for the beacon body (public, unauthenticated endpoint):
 * only the allowlisted keys survive, values are coerced to trimmed strings and
 * length-capped. Returns null when the body isn't a plain object — the route
 * drops the event silently (a beacon is fire-and-forget by design).
 */
export function sanitizeQuizStartMetadata(
  raw: unknown,
): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const key of QUIZ_START_METADATA_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const s = String(v).trim();
    if (s) out[key] = s.slice(0, MAX_VALUE_LEN);
  }
  return out;
}
