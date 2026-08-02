// lib/cronReportGate.ts
//
// ALERT HYGIENE (Wave 1C, GTM perfection plan) — pure decision helpers for
// "should this cron ping the operator at all?" and "what dedupe key should a
// high-frequency alert ride?".
//
// The problem these encode: ~55% of operator Telegram traffic was zero-work
// reports ("sent 0", "no pending", "nothing written") and repeated identical
// cards (deploy-drift every 30 min, one Cal reschedule fanning 3-4 cards).
// Real money alerts drowned under them. The rule is one sentence:
//
//   A cron reports in realtime ONLY when it did work or something failed.
//   Zero-work runs still write their Cron Runs row — silence is only for
//   Telegram. Env-dark / dry-run rails log + note only; failures surface via
//   withCronRun's error/partial alert.
//
// Pure on purpose: no I/O, no Date.now() — the seams are unit-tested in
// lib/cronReportGate.test.ts and every cron gate imports from here instead of
// re-inventing the condition inline.

/**
 * Realtime-report gate for a cron run summary.
 * True only when the run actually did something or something went wrong.
 * `workDone` is the cron's own "n" (invoices sent, referrals flipped, …);
 * `failures` is its error count. Warnings that require operator action
 * (e.g. a missing schema field) count as failures for gating purposes.
 */
export function shouldSendCronReport(input: { workDone: number; failures: number }): boolean {
  const work = Number(input?.workDone) || 0;
  const fails = Number(input?.failures) || 0;
  return work > 0 || fails > 0;
}

/** One Cal.com user action (reschedule = CANCELLED + CREATED + RESCHEDULED
 *  webhooks, sometimes across two booking uids) must land as ONE operator
 *  card. Booking uids differ across the burst, so the collapse key is the
 *  attendee: every lifecycle card for the same attendee inside the window
 *  dedupes to the first. No-show and error cards use their own keys — a
 *  booking card must never swallow a no-show alert. */
export const CAL_CARD_WINDOW_MS = 5 * 60 * 1000;

export function calBookingCardDedupe(attendeeEmail: string): {
  dedupeKey: string;
  dedupeWindowMs: number;
} {
  const email = String(attendeeEmail || '').trim().toLowerCase() || 'unknown';
  return { dedupeKey: `cal-booking:${email}`, dedupeWindowMs: CAL_CARD_WINDOW_MS };
}

/** deploy-drift runs every 30 min with no dedupe — one stale deploy used to
 *  mean 48 identical sirens/day. Key on the stale prod SHA: the same drift
 *  alerts at most every DEPLOY_DRIFT_WINDOW_MS, while a *different* stale SHA
 *  (partial promote) alerts immediately. */
export const DEPLOY_DRIFT_WINDOW_MS = 6 * 60 * 60 * 1000;

export function deployDriftDedupe(prodSha: string): {
  dedupeKey: string;
  dedupeWindowMs: number;
} {
  const sha = String(prodSha || '').trim().slice(0, 7) || 'unknown';
  return { dedupeKey: `deploy-drift:${sha}`, dedupeWindowMs: DEPLOY_DRIFT_WINDOW_MS };
}
