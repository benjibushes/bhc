// lib/firstTouchSla.ts
//
// Pure selectors for the 48h first-touch SLA cron (close-the-loop
// 2026-07-15). Forensics: only 38% of 703 intros ever got a real rancher
// touch, and "couldn't reach buyer" is the #1 downstream loss reason — the
// intro that never gets a first call is the platform's biggest silent leak.
// The cron (app/api/cron/first-touch-sla) sends the rancher ONE nudge at
// 48h and escalates to Ben at 96h.
//
// "Untouched" is NOT redefined here — needsFirstCall from lib/untouchedIntros
// is imported (the ONE definition the dashboard queue and Monday scorecard
// already share). This module only adds the SLA windows + throttle fields:
//   - nudge:      Intro Sent At ≥48h ago, Status still 'Intro Sent',
//                 'First Touch Nudged At' (fldCovvSweQKCp3Wh) empty.
//   - escalation: Intro Sent At ≥96h ago, still untouched (nudged or not),
//                 throttled on 'Stalled Alert Sent At' — the SAME field +
//                 3-day cooldown referral-chasup's stalled-rancher cards use,
//                 so Ben never gets two crons' cards for one referral in the
//                 same window (close-detector's stamp-field cooldown pattern,
//                 shared instead of forked).

import { needsFirstCall, type IntroTouchFields } from './untouchedIntros';

export const FIRST_TOUCH_NUDGE_AFTER_MS = 48 * 60 * 60 * 1000;
export const FIRST_TOUCH_ESCALATE_AFTER_MS = 96 * 60 * 60 * 1000;
// Mirrors referral-chasup's 3-day re-alert throttle on the same field.
export const ESCALATION_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
// Cross-cron throttle: referral-chasup L2a emails ranchers on this SAME
// population (Intro Sent ≥2d, 17:05 UTC, stamped 'Rancher Reminded At', 4d
// window). Without a cross-check, the day a referral crosses 48h the rancher
// gets chasup's email AND this cron's nudge an hour apart. If chasup pinged
// within the last 48h, hold the SLA nudge — it isn't lost, only delayed:
// chasup re-fires every 4d, so the stamp always ages past 48h before the
// next chasup send and the nudge fires in that window. The reverse direction
// is covered by the cron stamping 'Rancher Reminded At' alongside 'First
// Touch Nudged At', which chasup's own 4d throttle then respects.
export const CROSS_NUDGE_SUPPRESS_MS = 48 * 60 * 60 * 1000;

export interface FirstTouchRef extends IntroTouchFields {
  id: string;
  firstTouchNudgedAt?: string; // ISO — 'First Touch Nudged At'
  stalledAlertSentAt?: string; // ISO — 'Stalled Alert Sent At' (shared w/ chasup)
  rancherRemindedAt?: string; // ISO — 'Rancher Reminded At' (chasup L2a's 4d throttle)
}

const ageMs = (iso: string | undefined, nowMs: number): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t) || t === 0) return null;
  return nowMs - t;
};

/** 48h SLA: this referral's rancher should get their ONE first-touch nudge now. */
export function needsFirstTouchNudge(ref: FirstTouchRef, nowMs: number): boolean {
  if (String(ref.status || '') !== 'Intro Sent') return false;
  if (ref.firstTouchNudgedAt) return false; // one nudge, ever
  const age = ageMs(ref.introSentAt, nowMs);
  if (age === null || age < FIRST_TOUCH_NUDGE_AFTER_MS) return false;
  // chasup L2a pinged this rancher about this referral <48h ago → hold (see
  // CROSS_NUDGE_SUPPRESS_MS). One automated ping per referral per window,
  // never two crons an hour apart.
  const sinceReminder = ageMs(ref.rancherRemindedAt, nowMs);
  if (sinceReminder !== null && sinceReminder < CROSS_NUDGE_SUPPRESS_MS) return false;
  return needsFirstCall(ref);
}

/**
 * 96h escalation: still untouched (nudged or not) → one Telegram card to Ben,
 * throttled on the shared Stalled Alert Sent At stamp.
 */
export function needsFirstTouchEscalation(ref: FirstTouchRef, nowMs: number): boolean {
  const age = ageMs(ref.introSentAt, nowMs);
  if (age === null || age < FIRST_TOUCH_ESCALATE_AFTER_MS) return false;
  if (!needsFirstCall(ref)) return false;
  const sinceAlert = ageMs(ref.stalledAlertSentAt, nowMs);
  if (sinceAlert !== null && sinceAlert < ESCALATION_COOLDOWN_MS) return false;
  return true;
}

const oldestFirst = <T extends FirstTouchRef>(a: T, b: T) =>
  new Date(a.introSentAt || 0).getTime() - new Date(b.introSentAt || 0).getTime();

/** Nudge queue, longest-waiting buyer first, capped. */
export function selectFirstTouchNudges<T extends FirstTouchRef>(
  refs: T[],
  nowMs: number,
  cap: number,
): T[] {
  return refs
    .filter((r) => needsFirstTouchNudge(r, nowMs))
    .sort(oldestFirst)
    .slice(0, Math.max(0, cap));
}

/** Escalation queue, longest-waiting buyer first, capped. */
export function selectFirstTouchEscalations<T extends FirstTouchRef>(
  refs: T[],
  nowMs: number,
  cap: number,
): T[] {
  return refs
    .filter((r) => needsFirstTouchEscalation(r, nowMs))
    .sort(oldestFirst)
    .slice(0, Math.max(0, cap));
}

/**
 * Buyer-privacy display name for logs + operator cards: first name + last
 * initial ("Amie G."). Full names stay in Airtable, never in cron notes.
 */
export function privacyName(fullName: unknown): string {
  const parts = String(fullName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'a buyer';
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  return `${parts[0]} ${last[0].toUpperCase()}.`;
}

/**
 * First-name label for nudge copy ("Amie is waiting on your first call").
 * NOT privacyName(...).split(' ')[0] — that turns a nameless record's
 * 'a buyer' fallback into the literal word "a" (truthy, so a `|| 'A buyer'`
 * guard downstream never fires). Fall back on the RAW name's emptiness.
 */
export function buyerFirstLabel(fullName: unknown): string {
  const raw = String(fullName || '').trim();
  if (!raw) return 'A buyer';
  return privacyName(raw).split(' ')[0] || 'A buyer';
}
