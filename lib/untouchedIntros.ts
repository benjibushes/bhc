// lib/untouchedIntros.ts
//
// "Needs first call" — the touch-accountability selector. Forensic audit
// 2026-07-15: only 38% of 703 intros ever got a real rancher touch, and the
// #1 rancher-reported loss reason downstream is "couldn't reach the buyer" —
// a lead that never got a first call in the fresh window is the platform's
// biggest silent leak. This module is the ONE definition of "untouched" so
// the rancher dashboard queue and the Monday scorecard can never disagree.
//
// The same-day artifact rule: pre-2026-07-01 the quick-action route mutated
// on GET, and corporate mail scanners (SafeLinks / Mimecast) prefetched those
// links straight out of the intro email — minting a Last Rancher Activity At
// stamp on the intro's own day with no human involved. Historical rows in the
// audit window carry those stamps, so a same-day stamp alone is treated as NO
// touch. Current writers are all genuine actions (quick-action POST, dashboard
// PATCH, inbound email reply), and a genuine touch moves Status off 'Intro
// Sent' — the TOUCHED_STATUSES gate below keeps a real same-day call from
// being nagged as "needs first call".

export interface IntroTouchFields {
  status?: string;
  introSentAt?: string; // ISO
  lastRancherActivityAt?: string; // ISO
}

// Statuses where a first call is moot: deal is terminal, or the deposit rail
// is already in motion (Awaiting Payment / Slot Locked have their own queue
// rows and prove heavy engagement). 'Dormant' is the stale-hold expiry cron's
// terminal — those buyers were reset READY and re-routed to another rancher,
// so surfacing them with a tap-to-call invites double-contact. ('Refunded' IS
// a live Airtable Status — refundReferralClearFields writes it on every full
// refund; the note here used to claim otherwise, which was a stale-truth trap.
// lib/deal/states maps it to its own REFUNDED state as of the 2026-08-18
// data-layer audit.)
const EXCLUDED_STATUSES = new Set([
  'Closed Won',
  'Closed Lost',
  'Dormant',
  'Refunded',
  'Awaiting Payment',
  'Slot Locked',
]);

// Statuses only a rancher action can produce (quick-action POST 'in_talks',
// dashboard status change). Reaching one proves the first call happened even
// when the activity stamp lands on the intro's own UTC day — without this, a
// rancher who does exactly what the 24h CTA asks (calls same day, clicks
// "In talks") would still be nagged as "needs first call".
const TOUCHED_STATUSES = new Set(['Rancher Contacted', 'Negotiation']);

const utcDayKey = (iso: string): string | null => {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t) || t === 0) return null;
  return new Date(t).toISOString().slice(0, 10);
};

export function isSameUtcDay(aIso: string, bIso: string): boolean {
  const a = utcDayKey(aIso);
  const b = utcDayKey(bIso);
  return !!a && !!b && a === b;
}

/**
 * A REAL touch = Last Rancher Activity At present AND on a later UTC day
 * than the intro. Same-day stamps count as no touch (historical scanner
 * artifact — see header); status-based proof of a same-day touch is handled
 * in needsFirstCall, not here, so the scorecard's touched-% stays a
 * conservative measure over windows containing pre-2026-07-01 rows.
 */
export function isRealRancherTouch(
  introSentAt: string | undefined,
  lastRancherActivityAt: string | undefined,
): boolean {
  if (!introSentAt || !lastRancherActivityAt) return false;
  const intro = new Date(introSentAt).getTime();
  const touch = new Date(lastRancherActivityAt).getTime();
  if (!Number.isFinite(intro) || !Number.isFinite(touch)) return false;
  return !isSameUtcDay(introSentAt, lastRancherActivityAt);
}

export function needsFirstCall(ref: IntroTouchFields): boolean {
  if (!ref.introSentAt || !utcDayKey(ref.introSentAt)) return false;
  const status = String(ref.status || '');
  if (EXCLUDED_STATUSES.has(status)) return false;
  if (TOUCHED_STATUSES.has(status)) return false;
  return !isRealRancherTouch(ref.introSentAt, ref.lastRancherActivityAt);
}

/** Untouched intros, oldest intro first (the longest-waiting buyer on top). */
export function selectUntouchedIntros<T extends IntroTouchFields>(refs: T[]): T[] {
  return refs
    .filter(needsFirstCall)
    .sort(
      (a, b) =>
        new Date(a.introSentAt || 0).getTime() - new Date(b.introSentAt || 0).getTime(),
    );
}

/** Compact age badge: '6h' under 48 hours, then '3d'. */
export function introAgeLabel(introSentAtIso: string, nowMs: number): string {
  const t = new Date(introSentAtIso).getTime();
  if (!Number.isFinite(t)) return '';
  const hours = Math.max(0, Math.floor((nowMs - t) / (60 * 60 * 1000)));
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
