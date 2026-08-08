// ─────────────────────────────────────────────────────────────────────
// COMPLAINT TELEMETRY (P2.5, marketing revamp 2026-08)
//
// Rolling spam-complaint rate for the whole email program. The kill line at
// this list size (~2.7k consumers) is ~5 complaints/week — the alert fires
// BEFORE it, at 3+ in the trailing 7 days, so Ben can pause the offending
// lane while it's still a warning and not a fire.
//
// No new table, no new field: the Resend webhook (app/api/webhooks/resend)
// already stamps every complaint into the record's Notes with a dated line —
//   Consumers: "[Auto-unsub 2026-08-08] spam complaint"
//   Ranchers:  "[Auto-flag 2026-08-08] Email spam complaint"
// — alongside the Complained checkbox. Those stamps ARE the ledger; this
// module just counts them at alert time. The {Complained}=TRUE() filter
// keeps the fetch tiny (a handful of records, or the alert already fired).
// ─────────────────────────────────────────────────────────────────────

import { getAllRecords, TABLES } from './airtable';

export const COMPLAINT_ALERT_THRESHOLD = 3;
export const COMPLAINT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Matches the exact stamp lines the webhook writes (see route.ts): the date
// capture + a same-line "spam complaint" so bounce stamps never count.
const COMPLAINT_LINE_RE = /\[Auto-(?:unsub|flag) (\d{4}-\d{2}-\d{2})\][^\n]*spam complaint/gi;

/** Pull the dates of every spam-complaint stamp out of a Notes blob. */
export function extractComplaintDates(notes: unknown): string[] {
  if (typeof notes !== 'string' || !notes) return [];
  const dates: string[] = [];
  for (const m of notes.matchAll(COMPLAINT_LINE_RE)) {
    dates.push(m[1]);
  }
  return dates;
}

/**
 * Count complaint stamps at or after `sinceMs` across records. Same-day
 * duplicate lines on one record count ONCE (a redelivered webhook re-appends
 * the identical line — that must not inflate the rate); distinct days each
 * count. Stamp dates are UTC day-granular, so pass a day-floored `sinceMs`.
 */
export function countComplaintStampsSince(
  records: Array<Record<string, unknown>>,
  sinceMs: number,
): number {
  let total = 0;
  for (const rec of records) {
    const distinctDays = new Set(extractComplaintDates(rec?.['Notes']));
    for (const day of distinctDays) {
      const t = Date.parse(`${day}T00:00:00Z`);
      if (Number.isFinite(t) && t >= sinceMs) total++;
    }
  }
  return total;
}

/**
 * Trailing-7-day complaint count across Consumers + Ranchers. The window
 * start is floored to the UTC day so a stamp from exactly 7 days ago (which
 * only carries a date, not a time) still counts — the bias runs toward
 * alerting early, never late. Ranchers-side failures are non-fatal (the
 * table's Complained field is newer; a miss must not hide consumer counts).
 */
export async function countRecentComplaints(now: number = Date.now()): Promise<number> {
  const windowStart = now - COMPLAINT_WINDOW_MS;
  const sinceMs = windowStart - (windowStart % (24 * 60 * 60 * 1000));
  let total = 0;
  const consumers = (await getAllRecords(
    TABLES.CONSUMERS,
    `{Complained} = TRUE()`,
  )) as Array<Record<string, unknown>>;
  total += countComplaintStampsSince(consumers, sinceMs);
  try {
    const ranchers = (await getAllRecords(
      TABLES.RANCHERS,
      `{Complained} = TRUE()`,
    )) as Array<Record<string, unknown>>;
    total += countComplaintStampsSince(ranchers, sinceMs);
  } catch (e: any) {
    console.warn('[complaintTelemetry] rancher-side count skipped:', e?.message);
  }
  return total;
}
