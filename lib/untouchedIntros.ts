// lib/untouchedIntros.ts
//
// "Needs first call" — the touch-accountability selector. Forensic audit
// 2026-07-15: only 38% of 703 intros ever got a real rancher touch, and the
// #1 rancher-reported loss reason downstream is "couldn't reach the buyer" —
// a lead that never got a first call in the fresh window is the platform's
// biggest silent leak. This module is the ONE definition of "untouched" so
// the rancher dashboard queue and the Monday scorecard can never disagree.
//
// The same-day artifact rule: several write paths auto-stamp Last Rancher
// Activity At at intro time (the intro flip itself, quick-action GET
// prefetches). An activity stamp on the SAME UTC calendar day as the intro
// is therefore treated as NO touch — only a later-day stamp proves the
// rancher actually came back to the lead.

export interface IntroTouchFields {
  status?: string;
  introSentAt?: string; // ISO
  lastRancherActivityAt?: string; // ISO
}

// Statuses where a first call is moot: deal is terminal, or the deposit rail
// is already in motion (Awaiting Payment / Slot Locked have their own queue
// rows and prove heavy engagement).
const EXCLUDED_STATUSES = new Set([
  'Closed Won',
  'Closed Lost',
  'Refunded',
  'Awaiting Payment',
  'Slot Locked',
]);

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
 * than the intro. Same-day stamps are the auto-stamp artifact and count as
 * no touch.
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
  if (EXCLUDED_STATUSES.has(String(ref.status || ''))) return false;
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
