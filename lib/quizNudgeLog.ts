// lib/quizNudgeLog.ts
//
// Pure stage-tracking for the abandoned-quiz-nudge drip
// (app/api/cron/abandoned-quiz-nudge/route.ts).
//
// Email-hygiene 2026-08-02 — THE TRUNCATION RESET BUG: the drip used to track
// its 4 touches ONLY as `[quiz-nudge YYYY-MM-DD tN]` markers inside Consumers
// Notes, and every write re-sliced Notes to 2000 chars. On a chatty record the
// slice eventually deleted the oldest markers — the drip "forgot" its touches
// and RESTARTED from t1, forever. Stage truth now lives in the dedicated
// Consumers field `Quiz Nudge Log` (singleLineText, format `t1:2026-08-02;
// t2:2026-08-04`), which nothing truncates.
//
// Transition rule: READ the union of both sources (a buyer with a surviving
// Notes marker but an empty log must NOT restart), WRITE the new field going
// forward. The Notes marker keeps being written too — as human-readable
// history only; dedup never depends on it again.
//
// Legacy `[abandoned-quiz-nudge YYYY-MM-DD]` stamps from the old single-shot
// cron also contain "quiz-nudge <date>", so those buyers continue mid-drip —
// same back-compat the inline logic had.
//
// P5′ CADENCE (2026-08-08, MARKETING-REVAMP-2026-08 §5): the drip now rides
// lib/intentWindows' 'quiz' policy — 7-day sprint window anchored on the
// FIRST touch (the moment the drip first saw the buyer, which preserves the
// 2026-07-22 reactivated-WAITING behavior: record age never matters, drip age
// does), max 3 touches ~48h apart (days 0/2/4), then ONE decay touch in the
// following 7 days (buildEmail variant 4, the "last call" copy), then done.
// EQUIVALENCE CHECK (the brief demanded it): the old cadence was 4 touches at
// days 0/2/6/13 over 21 days — NOT equal to the 7d/3-touch panel policy, so
// the wiring below is a real behavior change, not churn. The claim/stamp
// discipline is untouched: `Quiz Nudge Log` + the Notes marker stay the touch
// truth, one-touch-per-day stays, and legacy 4-touch buyers read as exhausted.

import { sprintPlanFor, INTENT_WINDOW_POLICIES } from './intentWindows';

/** Sprint touches + the one decay touch — buildEmail has exactly 4 variants. */
export const QUIZ_NUDGE_MAX_TOUCHES = INTENT_WINDOW_POLICIES.quiz.maxTouches + 1;

/** Exact Airtable field name on Consumers (created 2026-08-02, exists in prod). */
export const QUIZ_NUDGE_LOG_FIELD = 'Quiz Nudge Log';

/**
 * Merge prior drip-touch dates from BOTH the legacy Notes markers and the
 * durable log field. Returns YYYY-MM-DD strings, deduped, ascending.
 */
export function parseQuizNudgeDates(notes: unknown, log: unknown): string[] {
  const dates = new Set<string>();
  for (const m of String(notes || '').matchAll(/quiz-nudge (\d{4}-\d{2}-\d{2})/g)) {
    dates.add(m[1]);
  }
  for (const m of String(log || '').matchAll(/t\d+:(\d{4}-\d{2}-\d{2})/g)) {
    dates.add(m[1]);
  }
  return [...dates].sort();
}

export type QuizNudgeDecision =
  | { action: 'skip'; reason: 'sent-today' | 'exhausted' | 'spacing' }
  | { action: 'send'; touchNum: number };

/**
 * Should this buyer get a drip touch today — and which one? One touch/day max
 * (sent-today guard), then lib/intentWindows' 'quiz' policy decides
 * due/exhausted. Touch counts come from the merged durable state (log field +
 * surviving Notes markers) — the planner never invents state.
 */
export function decideQuizNudge(opts: {
  notes?: unknown;
  log?: unknown;
  /** Today as YYYY-MM-DD (UTC — matches the cron's stamp format). */
  today: string;
}): QuizNudgeDecision {
  const dates = parseQuizNudgeDates(opts.notes, opts.log);
  if (dates.includes(opts.today)) return { action: 'skip', reason: 'sent-today' };
  const touchesSent = dates.length;
  // First sight = intent moment: touch 1 fires immediately (offset 0), and
  // the 7d+decay clock starts at THAT touch — never at record creation, so
  // reactivated buyers created long ago still get a full drip.
  if (touchesSent === 0) return { action: 'send', touchNum: 1 };
  const plan = sprintPlanFor('quiz', Date.parse(dates[0]), touchesSent, Date.parse(opts.today), {
    lastTouchAt: Date.parse(dates[dates.length - 1]),
  });
  if (!plan.due) {
    return { action: 'skip', reason: plan.exhausted ? 'exhausted' : 'spacing' };
  }
  return { action: 'send', touchNum: Math.min(touchesSent + 1, QUIZ_NUDGE_MAX_TOUCHES) };
}

/**
 * Next value for the `Quiz Nudge Log` field after sending `touchNum` on
 * `date`. Append-only, `;`-separated: `t1:2026-08-02;t2:2026-08-04`.
 * A full 4-touch drip is ~55 chars; the slice is a belt against a corrupted
 * field ever growing unbounded (singleLineText caps well above this).
 */
export function appendQuizNudgeLog(log: unknown, touchNum: number, date: string): string {
  const existing = String(log || '').trim();
  const entry = `t${touchNum}:${date}`;
  if (!existing) return entry;
  return `${existing};${entry}`.slice(0, 500);
}
