// lib/marketingSunset.ts
//
// P5′ SUNSET POLICY (MARKETING-REVAMP-2026-08 §5, Track 1) — pure selection
// logic for app/api/cron/marketing-sunset. Pressure gets a hard end date:
//
//   1. ASK — a marketing-lane consumer (lanes 1+2; lane 3 'customer' is never
//      touched — purchase = engagement) whose last ENGAGEMENT is >180 days
//      old, and who has actually RECEIVED sends inside that window, gets ONE
//      plain re-permission email ("still want ranch updates?"). Stamped with
//      a Notes marker (the AREA_OPENED pattern — no new Airtable fields).
//   2. SUPPRESS — 30 days after the ask with still no engagement → suppress
//      via the existing lib/email.ts mechanism (Consumers 'Unsubscribed' flag
//      feeds getSuppressionList; every guardedSend checks it) + Notes marker.
//   3. NO-CONTACT SUPPRESS — created >365 days ago with ZERO engagement
//      stamps ever and no purchases → suppress WITHOUT sending anything
//      (panel decision: a 12-month-cold never-engaged address is a
//      deliverability liability, not a lead).
//
// ENGAGEMENT = clicks + site/quiz activity. NEVER opens — Apple MPP inflates
// them into noise (the same rule the panel set for the digest sunset line).
// Every field name below is read from existing writer code, never guessed:
//   'Last Email Clicked At' / 'Email Clicks'  ← app/api/webhooks/resend
//   'Warmup Engaged At'                       ← recordBuyerEngagement contract
//   'Qualified At'                            ← /api/qualify + buyer/reconfirm
//   'Funnel Completed At'                     ← funnel completion writer
//   send stamps                               ← their crons (see SEND_RECENCY_FIELDS)

import { laneForSegment } from './routingSegment';
import { isSyntheticTestEmail } from './demandRouter';

export const SUNSET_ASK_MARKER = '[SUNSET-ASK';
export const SUNSET_KEEP_MARKER = '[SUNSET-KEEP';
export const SUNSET_SUPPRESSED_MARKER = '[SUNSET-SUPPRESSED';

export const SUNSET_LOOKBACK_DAYS = 180;
export const SUNSET_ASK_GRACE_DAYS = 30;
export const NEVER_ENGAGED_MIN_AGE_DAYS = 365;

export const SUNSET_ASK_CAP_PER_RUN = 25;
export const SUNSET_SUPPRESS_CAP_PER_RUN = 25;
export const NEVER_ENGAGED_SUPPRESS_CAP_PER_RUN = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/** User-initiated activity ONLY. Opens are deliberately absent (MPP). */
export const ENGAGEMENT_FIELDS = [
  'Last Email Clicked At',
  'Warmup Engaged At',
  'Qualified At',
  'Funnel Completed At',
] as const;

/**
 * "We sent them something" recency — delivery webhook stamps + every rail's
 * own consumer-row send stamp (the same set lib/demandRouter.lastActivityMs
 * treats as contact). 'Last Email Event At' counts: ANY webhook event implies
 * a send reached the mailbox, even though it never counts as engagement.
 */
export const SEND_RECENCY_FIELDS = [
  'Last Email Delivered At',
  'Last Email Event At',
  'Campaign Last Sent At',
  'Nurture Touched At',
  'Sequence Sent At',
  'Waiting Nudge Last Sent At',
  'Ready Nudge Last Sent At',
  'Warmup Sent At',
  'Routing Segment Last Sent At',
] as const;

// Same terminal-deal signals lib/routingSegment.classifyBuyer maps to
// TERMINAL — the belt for a stale stored 'Routing Segment'.
const TERMINAL_REFERRAL_STATUSES = new Set(['Awaiting Payment', 'Slot Locked', 'Closed Won']);

export type SunsetDecision =
  | { action: 'ask' }
  | { action: 'suppress'; reason: 'no-reply-30d' | 'never-engaged-12mo' }
  | { action: 'skip'; reason: string };

function readEnumOrString(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

function parseMs(raw: unknown): number | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function maxFieldMs(c: Record<string, unknown>, fields: readonly string[]): number | null {
  let max: number | null = null;
  for (const f of fields) {
    const t = parseMs(c[f]);
    if (t !== null && (max === null || t > max)) max = t;
  }
  return max;
}

function createdMs(c: Record<string, unknown>): number | null {
  return parseMs(c['Created']) ?? parseMs((c as any)._createdTime) ?? parseMs((c as any).createdTime);
}

/**
 * Newest `[<marker> YYYY-MM-DD]` date in Notes, as ms — null when absent.
 * Mirrors the AREA_OPENED_MARKER pattern (state-coverage-notify).
 */
export function latestSunsetMarkerMs(notes: unknown, marker: string): number | null {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let max: number | null = null;
  for (const m of String(notes || '').matchAll(new RegExp(`${escaped} (\\d{4}-\\d{2}-\\d{2})`, 'g'))) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t) && (max === null || t > max)) max = t;
  }
  return max;
}

/** Any user-initiated engagement strictly AFTER `sinceMs`. */
function engagedSince(c: Record<string, unknown>, sinceMs: number): boolean {
  const eng = maxFieldMs(c, ENGAGEMENT_FIELDS);
  if (eng !== null && eng > sinceMs) return true;
  const kept = latestSunsetMarkerMs(c['Notes'], SUNSET_KEEP_MARKER);
  return kept !== null && kept > sinceMs;
}

/** Zero user-initiated engagement in this consumer's entire lifetime. */
function neverEngagedEver(c: Record<string, unknown>): boolean {
  if (maxFieldMs(c, ENGAGEMENT_FIELDS) !== null) return false;
  if (Number(c['Email Clicks']) > 0) return false;
  if (c['Ready to Buy'] === true) return false;
  if (latestSunsetMarkerMs(c['Notes'], SUNSET_KEEP_MARKER) !== null) return false;
  return true;
}

/**
 * The whole policy for one consumer row. Pure; `nowMs` injected. Fails
 * toward SILENCE on any missing anchor — this cron must never invent
 * pressure or suppression from garbage data.
 */
export function decideSunset(c: Record<string, unknown>, nowMs: number): SunsetDecision {
  const email = String(c['Email'] || '').trim().toLowerCase();
  if (!email) return { action: 'skip', reason: 'no-email' };
  if (isSyntheticTestEmail(email)) return { action: 'skip', reason: 'synthetic' };

  // Already suppressed by any channel → nothing to do (and never resend).
  if (c['Unsubscribed'] === true || c['Bounced'] === true || c['Complained'] === true) {
    return { action: 'skip', reason: 'already-suppressed' };
  }
  if (latestSunsetMarkerMs(c['Notes'], SUNSET_SUPPRESSED_MARKER) !== null) {
    return { action: 'skip', reason: 'already-sunset-suppressed' };
  }

  // Lane 3 ('customer') gets the longer leash — purchase = engagement. Belt:
  // a live/won deal always wins over a stale stored segment.
  if (laneForSegment(readEnumOrString(c['Routing Segment'])) === 'customer') {
    return { action: 'skip', reason: 'customer-lane' };
  }
  const stage = readEnumOrString(c['Buyer Stage']);
  if (stage === 'MATCHED' || stage === 'CLOSED') return { action: 'skip', reason: 'active-deal' };
  if (TERMINAL_REFERRAL_STATUSES.has(readEnumOrString(c['Referral Status']))) {
    return { action: 'skip', reason: 'active-deal' };
  }

  // ── the 30-day grace clock after an ask ──
  const askMs = latestSunsetMarkerMs(c['Notes'], SUNSET_ASK_MARKER);
  if (askMs !== null) {
    if (engagedSince(c, askMs)) return { action: 'skip', reason: 'engaged-after-ask' };
    if (nowMs - askMs >= SUNSET_ASK_GRACE_DAYS * DAY_MS) {
      return { action: 'suppress', reason: 'no-reply-30d' };
    }
    return { action: 'skip', reason: 'ask-pending' };
  }

  // ── 12mo+ never-engaged: suppress with NO contact (checked before the ask
  // so a year-cold corpse never gets a re-permission email) ──
  const created = createdMs(c);
  if (
    created !== null &&
    nowMs - created > NEVER_ENGAGED_MIN_AGE_DAYS * DAY_MS &&
    neverEngagedEver(c)
  ) {
    return { action: 'suppress', reason: 'never-engaged-12mo' };
  }

  // ── the 180d re-permission ask ──
  // A fresh signup is itself an action: creation counts toward "last
  // engagement" so a quiet-but-recent consumer is never sunset early.
  const lastEngagement = Math.max(maxFieldMs(c, ENGAGEMENT_FIELDS) ?? 0, created ?? 0);
  if (lastEngagement === 0) return { action: 'skip', reason: 'no-anchor' };
  if (nowMs - lastEngagement <= SUNSET_LOOKBACK_DAYS * DAY_MS) {
    return { action: 'skip', reason: 'engaged-recently' };
  }
  // "…AND who have received sends in that window" — someone we stopped
  // mailing long ago has nothing to re-permission; leave them be.
  const lastSend = maxFieldMs(c, SEND_RECENCY_FIELDS);
  if (lastSend === null || nowMs - lastSend > SUNSET_LOOKBACK_DAYS * DAY_MS) {
    return { action: 'skip', reason: 'no-sends-in-window' };
  }
  return { action: 'ask' };
}

export interface SunsetSelection<T> {
  asks: T[];
  suppressAsked: T[];
  suppressNeverEngaged: T[];
  skipped: Record<string, number>;
}

/**
 * Bucket + cap + order the whole consumer table for one run. Deterministic:
 * asks go oldest-engagement-first (longest-dead first), suppressions go
 * oldest-anchor-first, so the caps walk the tail instead of re-picking heads.
 */
export function selectSunsetActions<T extends Record<string, unknown>>(
  consumers: T[],
  nowMs: number,
  caps?: { asks?: number; suppressAsked?: number; suppressNeverEngaged?: number },
): SunsetSelection<T> {
  const askCap = Math.max(0, Math.floor(caps?.asks ?? SUNSET_ASK_CAP_PER_RUN));
  const supCap = Math.max(0, Math.floor(caps?.suppressAsked ?? SUNSET_SUPPRESS_CAP_PER_RUN));
  const nevCap = Math.max(
    0,
    Math.floor(caps?.suppressNeverEngaged ?? NEVER_ENGAGED_SUPPRESS_CAP_PER_RUN),
  );

  const asks: T[] = [];
  const suppressAsked: T[] = [];
  const suppressNeverEngaged: T[] = [];
  const skipped: Record<string, number> = {};

  for (const c of Array.isArray(consumers) ? consumers : []) {
    const d = decideSunset(c, nowMs);
    if (d.action === 'ask') asks.push(c);
    else if (d.action === 'suppress' && d.reason === 'no-reply-30d') suppressAsked.push(c);
    else if (d.action === 'suppress') suppressNeverEngaged.push(c);
    else skipped[d.reason] = (skipped[d.reason] || 0) + 1;
  }

  const engagementAnchor = (c: T) =>
    Math.max(maxFieldMs(c, ENGAGEMENT_FIELDS) ?? 0, createdMs(c) ?? 0);
  asks.sort((a, b) => engagementAnchor(a) - engagementAnchor(b));
  suppressAsked.sort(
    (a, b) =>
      (latestSunsetMarkerMs(a['Notes'], SUNSET_ASK_MARKER) ?? 0) -
      (latestSunsetMarkerMs(b['Notes'], SUNSET_ASK_MARKER) ?? 0),
  );
  suppressNeverEngaged.sort((a, b) => (createdMs(a) ?? 0) - (createdMs(b) ?? 0));

  return {
    asks: asks.slice(0, askCap),
    suppressAsked: suppressAsked.slice(0, supCap),
    suppressNeverEngaged: suppressNeverEngaged.slice(0, nevCap),
    skipped,
  };
}
