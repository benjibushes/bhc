// lib/depositRequestNudge.ts
//
// LEAK 2 of the rancher-driven deposit rail (2026-07-05, 0-for-7 unpaid):
// a buyer who got a deposit request and didn't pay received ZERO follow-up
// for 14 days — and that 14-day net (awaiting-payment-nudge) pings the
// RANCHER, not the buyer. This module decides which referrals get the
// BUYER-facing "your share is still waiting" nudge on a given cron run.
//
// Same discipline as lib/waitingActivation.ts / lib/noActionNudge.ts: pure,
// dependency-free selection logic (unit-tests without Airtable), the Airtable
// formula is only an I/O optimization and the predicate re-checks every row.
//
// Eligibility (ALL must hold):
//   - 'Deposit Requested At' set  (a rancher actually sent the request)
//   - 'Deposit Paid At' EMPTY      (buyer hasn't paid)
//   - Status === 'Awaiting Payment' (still in the requested state — a refund,
//     close, or re-route moves the status and stops the nudges)
//   - request age >= MIN_AGE (24h — give the original email its shot)
//   - 'Deposit Nudge Count' < LIFETIME_CAP (2 — nudge 1 ~24h, nudge 2 ~72h+,
//     then silence forever; the rancher-facing 14d chase still exists)
//   - outside COOLDOWN (48h) vs 'Deposit Nudge Last Sent At'; a non-empty
//     stamp that doesn't parse counts as RECENT (skip) — corrupt data must
//     never cause a nudge storm
//
// The linked Consumer's suppression trio (Unsubscribed/Bounced/Complained)
// is enforced by the cron via the consumer record + guardedSend's global
// suppression list — belt and braces.

import { sprintPlanFor, type SprintPlan } from './intentWindows';

export const DEPOSIT_NUDGE_LIFETIME_CAP = 2;
export const DEPOSIT_NUDGE_MIN_AGE_MS = 24 * 60 * 60 * 1000; // 24h after request
export const DEPOSIT_NUDGE_COOLDOWN_MS = 48 * 60 * 60 * 1000; // 48h between nudges

/** 'Deposit Nudge Count' value the cron writes on the SUPPRESSED path (comms
 *  containment 2026-08-18). A suppressed buyer (Unsubscribed/Bounced/
 *  Complained) can never receive this chase, yet with no stamp the row
 *  re-entered the selector every hour FOREVER, eating a batch-cap slot each
 *  run. Fields can't be created from code (docs/WRITE-MAP.md discipline), so
 *  the touch budget itself is the one-shot marker: any value at or above
 *  every rail's cap (rail A caps at 2; rail B's planner exhausts at its
 *  policy total) permanently retires the row from BOTH selectors — same
 *  field-reuse trade as DEPOSIT_SMS_SENT_FIELD below. Deliberately loud in
 *  the base: a count of 99 is greppable as "retired by suppression". */
export const DEPOSIT_NUDGE_SUPPRESSED_SENTINEL = 99;

export interface DepositNudgeReferralLike {
  id?: string;
  ['Status']?: unknown;
  ['Deposit Requested At']?: unknown;
  ['Deposit Paid At']?: unknown;
  ['Deposit Nudge Last Sent At']?: unknown;
  ['Deposit Nudge Count']?: unknown;
  [key: string]: unknown;
}

function statusName(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object' && typeof (raw as any).name === 'string') {
    return String((raw as any).name).trim();
  }
  return '';
}

function parseMs(raw: unknown): number | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function nudgeCount(r: DepositNudgeReferralLike): number {
  const n = Number(r['Deposit Nudge Count']);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Pure per-row predicate: does this referral get a buyer nudge right now? */
export function isDepositNudgeEligible(
  r: DepositNudgeReferralLike,
  nowMs: number,
): boolean {
  // Must be a rancher-sent request that's still unpaid + still awaiting.
  const requestedMs = parseMs(r['Deposit Requested At']);
  if (requestedMs === null) return false;
  if (String(r['Deposit Paid At'] || '').trim()) return false;
  if (statusName(r['Status']) !== 'Awaiting Payment') return false;

  // Give the original email 24h before the first nudge.
  if (nowMs - requestedMs < DEPOSIT_NUDGE_MIN_AGE_MS) return false;

  // Lifetime cap: 2 buyer nudges, then permanent silence on this channel.
  if (nudgeCount(r) >= DEPOSIT_NUDGE_LIFETIME_CAP) return false;

  // Cooldown vs the last nudge. Corrupt stamp => treat as recent (skip).
  const lastRaw = String(r['Deposit Nudge Last Sent At'] || '').trim();
  if (lastRaw) {
    const lastMs = Date.parse(lastRaw);
    if (!Number.isFinite(lastMs)) return false;
    if (nowMs - lastMs < DEPOSIT_NUDGE_COOLDOWN_MS) return false;
  }

  return true;
}

/**
 * Select the referrals to nudge this run: eligible per the predicate, oldest
 * request first (they leak first), capped per run to pace sends.
 */
export function selectDepositNudges<T extends DepositNudgeReferralLike>(
  referrals: T[],
  opts: { nowMs: number; batchCap?: number },
): T[] {
  const cap = Math.floor(opts.batchCap ?? 25);
  if (!Array.isArray(referrals) || referrals.length === 0 || cap <= 0) return [];
  return referrals
    .filter((r) => isDepositNudgeEligible(r, opts.nowMs))
    .sort((a, b) => (parseMs(a['Deposit Requested At']) ?? 0) - (parseMs(b['Deposit Requested At']) ?? 0))
    .slice(0, cap);
}

// ── DEPOSIT-ABANDON RAIL (2026-07-05; P5′ tiered window 2026-08-08) ─────────
// The rancher-request rail above only fires when a RANCHER hit "request
// deposit" (Deposit Requested At set). But a quiz-complete buyer routed to a
// deposit-capable rancher gets a deposit link too — sendQuizCompleteDepositInvite
// stamps 'Deposit Invite Sent At' — and if they don't pay, NOTHING chased them.
// That's the "abandoned cart" of the funnel (the single highest-ROI trigger in
// the research). Same claim-before-send stamps as rail A; only the entry
// signal differs. Deliberately mutually exclusive with the rail above
// (requires Deposit Requested At EMPTY) so a referral is never double-nudged.
//
// P5′ CADENCE (MARKETING-REVAMP-2026-08 §5, panel-amended): this rail now
// rides lib/intentWindows' 'deposit-invite' policy — 14-day window, up to 5
// touches on a ramping schedule (days 1/3/6/9/13 after the invite), then ONE
// decay touch in the following 7 days, then permanent silence. Replaces the
// old flat cap-2/48h-cooldown cadence, which closed before the median buyer
// decides (quiz→close median is 2-21d; ~90% of considered conversions land by
// day 12). The stamp fields are UNCHANGED — 'Deposit Nudge Count' + 'Deposit
// Nudge Last Sent At' stay the touch-count truth; the planner only answers
// due/not-due. Rail A above deliberately keeps its 2-touch cap (a rancher-
// initiated request has the rancher-facing 14d chase behind it).
//
// Terminal statuses stop the nudge: a paid, accepted (Slot Locked), or closed
// referral is done. Denylist (not allowlist) so a new mid-funnel status can't
// silently strand a buyer.

// Statuses that mean "stop nudging — the deal moved past the deposit ask."
const ABANDON_STOP_STATUSES = new Set(['Closed Won', 'Closed Lost', 'Slot Locked']);

/**
 * The tiered-window plan for a deposit-abandon row: structural guards first
 * (invite stamp set, NOT a rancher request, unpaid, non-terminal, no corrupt
 * stamps), then lib/intentWindows decides due/exhausted/tier. Returns null
 * when the row isn't a rail-B row at all (or its stamps are corrupt — fail
 * closed, never storm). The cron uses `tier` to pick the copy variant
 * (urgency → mid → decay "last note").
 */
export function depositAbandonPlan(
  r: DepositNudgeReferralLike,
  nowMs: number,
): SprintPlan | null {
  // Must be a quiz-complete invite (invite stamp set) — and NOT a rancher
  // request (that's the other rail; keeps the two disjoint).
  const invitedMs = parseMs(r['Deposit Invite Sent At']);
  if (invitedMs === null) return null;
  if (String(r['Deposit Requested At'] || '').trim()) return null;

  // Unpaid + not past the deposit ask.
  if (String(r['Deposit Paid At'] || '').trim()) return null;
  if (ABANDON_STOP_STATUSES.has(statusName(r['Status']))) return null;

  // Corrupt last-sent stamp => fail closed (the planner also fails closed on
  // a count>0/no-anchor mismatch — no nudge storm on data drift).
  const lastRaw = String(r['Deposit Nudge Last Sent At'] || '').trim();
  let lastMs: number | null = null;
  if (lastRaw) {
    const t = Date.parse(lastRaw);
    if (!Number.isFinite(t)) return null;
    lastMs = t;
  }

  // 24h min-age is subsumed by the policy's day-1 first offset; the ramping
  // deltas subsume the old 48h cooldown (every gap >= 2 days).
  return sprintPlanFor('deposit-invite', invitedMs, nudgeCount(r), nowMs, {
    lastTouchAt: lastMs,
  });
}

/** Pure per-row predicate — planner-backed since P5′. */
export function isDepositAbandonEligible(
  r: DepositNudgeReferralLike,
  nowMs: number,
): boolean {
  return depositAbandonPlan(r, nowMs)?.due === true;
}

/** Select deposit-abandon referrals to nudge this run — oldest invite first. */
export function selectDepositAbandonNudges<T extends DepositNudgeReferralLike>(
  referrals: T[],
  opts: { nowMs: number; batchCap?: number },
): T[] {
  const cap = Math.floor(opts.batchCap ?? 25);
  if (!Array.isArray(referrals) || referrals.length === 0 || cap <= 0) return [];
  return referrals
    .filter((r) => isDepositAbandonEligible(r, opts.nowMs))
    .sort((a, b) => (parseMs(a['Deposit Invite Sent At']) ?? 0) - (parseMs(b['Deposit Invite Sent At']) ?? 0))
    .slice(0, cap);
}

// ── SMS RESCUE LEG (2026-07-28 conversion audit) ─────────────────────────────
// The deposit-request rail was email-only, and the audit's ground truth is
// brutal: the deposit page converts ~1-for-1 WHEN OPENED — the email in front
// of it is the leak (0/7 stuck requests were ever opened). This leg sends ONE
// SMS per referral, ever, when the first email nudge got no deposit-page open
// within 48h.
//
// Channel gating lives in the CRON, not here (smsEnabled() env gate + the
// consumer's SMS Opt-In + quiet hours via isSmsWindow + sendSMSToConsumer's
// own hard gates). This module only answers "is this row due" — pure and
// unit-tested. With ENABLE_SMS unset the whole leg ships DARK, by design.
//
// STAMP: 'Reserve Recovery SMS Sent At' is REUSED as the one-shot marker (we
// cannot create Airtable fields; see docs/WRITE-MAP.md discipline). It is safe
// to share with the reserve-abandon rail (lib/reserveRecovery) because the two
// cohorts are DISJOINT by construction: this leg requires 'Deposit Requested
// At' SET, the reserve rail requires it EMPTY — and sharing yields the right
// global invariant anyway: at most one deposit-chase SMS per referral, ever,
// across every rail.

export const DEPOSIT_SMS_NO_OPEN_WINDOW_MS = 48 * 60 * 60 * 1000; // no-open window after nudge 1
export const DEPOSIT_SMS_SENT_FIELD = 'Reserve Recovery SMS Sent At';

/**
 * Pure per-row predicate: does this rancher-requested referral get the ONE
 * rescue SMS right now? Fails CLOSED on any missing/corrupt anchor.
 */
export function isDepositSmsRescueEligible(
  r: DepositNudgeReferralLike,
  nowMs: number,
): boolean {
  // Rail-A shape: a rancher-sent request that's still unpaid + still awaiting.
  const requestedMs = parseMs(r['Deposit Requested At']);
  if (requestedMs === null) return false;
  if (String(r['Deposit Paid At'] || '').trim()) return false;
  if (statusName(r['Status']) !== 'Awaiting Payment') return false;

  // SMS never leads: the FIRST email nudge must already be out.
  if (nudgeCount(r) < 1) return false;

  // 48h no-open window, anchored on the last email nudge. A blank or corrupt
  // anchor (count>=1 with no parseable stamp = data drift) fails closed —
  // never SMS blind.
  const lastMs = parseMs(r['Deposit Nudge Last Sent At']);
  if (lastMs === null) return false;
  if (nowMs - lastMs < DEPOSIT_SMS_NO_OPEN_WINDOW_MS) return false;

  // The buyer opened the deposit page → email is working, no SMS needed.
  if (String(r['Deposit Link Opened At'] || '').trim()) return false;

  // ONE SMS per referral, EVER (cross-rail via the shared stamp).
  if (String(r[DEPOSIT_SMS_SENT_FIELD] || '').trim()) return false;

  return true;
}

/**
 * Select the referrals that get the rescue SMS this run: eligible per the
 * predicate, minus any row already touched by email in the SAME run
 * (excludeIds — never two touches in one hour), oldest request first, capped.
 */
export function selectDepositSmsRescues<T extends DepositNudgeReferralLike>(
  referrals: T[],
  opts: { nowMs: number; batchCap?: number; excludeIds?: ReadonlySet<string> },
): T[] {
  const cap = Math.floor(opts.batchCap ?? 10);
  if (!Array.isArray(referrals) || referrals.length === 0 || cap <= 0) return [];
  const excluded = opts.excludeIds ?? new Set<string>();
  return referrals
    .filter((r) => !excluded.has(String(r.id || '')) && isDepositSmsRescueEligible(r, opts.nowMs))
    .sort((a, b) => (parseMs(a['Deposit Requested At']) ?? 0) - (parseMs(b['Deposit Requested At']) ?? 0))
    .slice(0, cap);
}

// FINAL COPY (docs/marketing/sms-deposit-nudge.md, Message 1 — landed #501).
// Any future copy change swaps THIS constant only; tokens: {first} {cut}
// {rancher} {payLink}. Tone fence from the doc: "your reservation link", never
// "last chance" — the rancher is holding a real slot; no fake cliffs.
export const DEPOSIT_SMS_NUDGE_BODY =
  'BuyHalfCow: {first}, your {cut} share at {rancher} is held. Your reservation link: {payLink} Reply STOP to opt out';

// Single GSM-7 SMS segment. The doc's rule: if a long ranch name pushes the
// render past this, fall back to "your ranch" — but only when the fallback
// actually gets under the limit (a JWT-length link can't be rescued by a
// shorter ranch name; keep the real name rather than downgrade for nothing).
const SMS_SINGLE_SEGMENT_CHARS = 160;

/** Fill the SMS template. Pure string work — the cron owns every send gate. */
export function renderDepositSmsNudge(ctx: {
  firstName: string;
  cut: string;
  rancherName: string;
  link: string;
}): string {
  const first = String(ctx.firstName || 'there').trim() || 'there';
  const cutRaw = String(ctx.cut || '').trim().toLowerCase();
  const cut = cutRaw === 'quarter' || cutRaw === 'half' || cutRaw === 'whole' ? cutRaw : 'beef';
  const link = String(ctx.link || '').trim();
  const fill = (rancher: string) =>
    DEPOSIT_SMS_NUDGE_BODY
      .replace('{first}', first)
      .replace('{cut}', cut)
      .replace('{rancher}', rancher)
      .replace('{payLink}', link);
  const full = fill(String(ctx.rancherName || 'your ranch').trim() || 'your ranch');
  if (full.length <= SMS_SINGLE_SEGMENT_CHARS) return full;
  const short = fill('your ranch');
  return short.length <= SMS_SINGLE_SEGMENT_CHARS ? short : full;
}

// ── DESK RESCUE LIST (read-only) ─────────────────────────────────────────────
// "Deposit requested, never opened >7d" — past both email nudges and the SMS,
// automation has had its shot; these are Ben's manual calls/texts. Pure filter
// over rows /api/referrals already returns (no new Airtable read).

export const DEPOSIT_NEVER_OPENED_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Pure per-row predicate for the desk list. */
export function isDepositNeverOpened(
  r: DepositNudgeReferralLike,
  nowMs: number,
): boolean {
  const requestedMs = parseMs(r['Deposit Requested At']);
  if (requestedMs === null) return false;
  if (String(r['Deposit Paid At'] || '').trim()) return false;
  if (statusName(r['Status']) !== 'Awaiting Payment') return false;
  if (String(r['Deposit Link Opened At'] || '').trim()) return false;
  return nowMs - requestedMs >= DEPOSIT_NEVER_OPENED_MIN_AGE_MS;
}

/** Oldest request first (they leak first), capped for the desk. */
export function selectDepositNeverOpened<T extends DepositNudgeReferralLike>(
  rows: T[],
  opts: { nowMs: number; limit?: number },
): T[] {
  const cap = Math.floor(opts.limit ?? 25);
  if (!Array.isArray(rows) || rows.length === 0 || cap <= 0) return [];
  return rows
    .filter((r) => isDepositNeverOpened(r, opts.nowMs))
    .sort((a, b) => (parseMs(a['Deposit Requested At']) ?? 0) - (parseMs(b['Deposit Requested At']) ?? 0))
    .slice(0, cap);
}

/**
 * The link Ben can text a buyer manually: ONLY the durable /r/p mint (re-mints
 * a fresh Stripe session at click). A raw checkout.stripe.com URL expires in
 * ~24h — handing one to Ben is a dead end, so anything else returns ''.
 */
export function durableDepositPayLink(url: unknown): string {
  const s = String(url || '').trim();
  return s.includes('/r/p/') ? s : '';
}
