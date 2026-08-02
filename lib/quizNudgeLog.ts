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

/** Days to wait BEFORE each touch, indexed by touches-already-sent.
 *  [0,2,4,7] → touch1 immediately, touch2 +2d after touch1, etc. */
export const QUIZ_NUDGE_CADENCE_SPACING_DAYS = [0, 2, 4, 7] as const;
export const QUIZ_NUDGE_MAX_TOUCHES = QUIZ_NUDGE_CADENCE_SPACING_DAYS.length;

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
 * Should this buyer get a drip touch today — and which one? Mirrors the
 * cron's original inline logic exactly (one touch/day max, 4 touches
 * lifetime, [0,2,4,7]-day spacing), but counts touches from the merged
 * durable state instead of Notes alone.
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
  if (touchesSent >= QUIZ_NUDGE_MAX_TOUCHES) return { action: 'skip', reason: 'exhausted' };
  if (touchesSent > 0) {
    const lastDate = dates[dates.length - 1];
    const daysSinceLast = Math.floor((Date.parse(opts.today) - Date.parse(lastDate)) / 86_400_000);
    if (daysSinceLast < QUIZ_NUDGE_CADENCE_SPACING_DAYS[touchesSent]) {
      return { action: 'skip', reason: 'spacing' };
    }
  }
  return { action: 'send', touchNum: touchesSent + 1 };
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
