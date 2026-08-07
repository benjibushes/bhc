// lib/depositBalk.ts
//
// BALK RAIL (2026-08-07, human-in-the-loop slice 1): the hottest
// non-converted inventory the funnel produces is a buyer who OPENED the
// deposit page and didn't pay. Deposit pages convert near 1-for-1 when
// reached, so an open-without-pay is a live objection, not a cold lead —
// and speed-to-lead research says the first hour is worth multiples of
// any automated follow-up later.
//
// This module is the PURE half: given referral rows, decide which ones are
// balked and need Ben pinged. The deposit-watchdog cron owns fetching,
// claim-before-alert stamping ('Balk Alert Sent At'), and the operator
// signal. Selection rules:
//
//   · 'Deposit Link Opened At' set, parseable, and 60min–48h old.
//     (<60min: they may still be reading. >48h: the nudge rails own it —
//     a stale balk ping would just be noise Ben ignores.)
//   · 'Deposit Paid At' blank — money in = not a balk.
//   · 'Balk Alert Sent At' blank — one ping per referral, ever. Ben acts
//     or he doesn't; repeat pings train him to ignore the channel.
//   · Status not terminal — a Closed/Cancelled referral's open is history.

export const BALK_MIN_AGE_MS = 60 * 60 * 1000; // 1h — still-reading grace
export const BALK_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48h — then nudge rails own it

// Terminal statuses copied from the referral lifecycle (matching
// lib/rancherLeads TERMINAL semantics): no balk ping once the deal is
// decided either way.
const TERMINAL_STATUSES = new Set([
  'closed won',
  'closed lost',
  'cancelled',
  'canceled',
  'expired',
]);

export interface BalkCandidate {
  id: string;
  fields: Record<string, unknown>;
}

function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object' && 'name' in (v as any)) return String((v as any).name || '');
  return String(v);
}

function parseMs(v: unknown): number | null {
  const s = str(v).trim();
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

export type BalkSkipReason =
  | 'no-open-stamp'
  | 'unparseable-open'
  | 'too-fresh'
  | 'too-old'
  | 'already-paid'
  | 'already-alerted'
  | 'terminal-status';

/** Why this row is NOT a balk target — null means it IS one. */
export function balkSkipReason(fields: Record<string, unknown>, nowMs: number): BalkSkipReason | null {
  const openedMs = parseMs(fields['Deposit Link Opened At']);
  if (str(fields['Deposit Link Opened At']).trim() === '') return 'no-open-stamp';
  if (openedMs == null) return 'unparseable-open';
  if (str(fields['Deposit Paid At']).trim() !== '') return 'already-paid';
  if (str(fields['Balk Alert Sent At']).trim() !== '') return 'already-alerted';
  if (TERMINAL_STATUSES.has(str(fields['Status']).trim().toLowerCase())) return 'terminal-status';
  const age = nowMs - openedMs;
  if (age < BALK_MIN_AGE_MS) return 'too-fresh';
  if (age > BALK_MAX_AGE_MS) return 'too-old';
  return null;
}

/** The balked subset, oldest open first (closest to going cold = first). */
export function selectBalkedReferrals(rows: BalkCandidate[], nowMs: number): BalkCandidate[] {
  return rows
    .filter((r) => balkSkipReason(r.fields, nowMs) === null)
    .sort((a, b) => (parseMs(a.fields['Deposit Link Opened At']) || 0) - (parseMs(b.fields['Deposit Link Opened At']) || 0));
}

/** Count skip reasons for the cron's honest notes line. */
export function balkSkipBreakdown(rows: BalkCandidate[], nowMs: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const reason = balkSkipReason(r.fields, nowMs) || 'selected';
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

/** Minutes since the deposit page open — for alert copy. */
export function minutesSinceOpen(fields: Record<string, unknown>, nowMs: number): number {
  const openedMs = parseMs(fields['Deposit Link Opened At']);
  if (openedMs == null) return 0;
  return Math.max(0, Math.round((nowMs - openedMs) / 60000));
}
