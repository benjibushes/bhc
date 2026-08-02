// lib/noActionNudge.ts
//
// Pure selection logic for the qualified-no-action abandon-cart cron
// (app/api/cron/qualified-no-action/route.ts). Extracted 2026-07-02 after the
// cron's inline Airtable formula burned twice:
//
//   1. CONV-4: the original formula referenced {Deposit Paid At} on Consumers
//      (the field lives on Referrals) — the cron ERRORED every 30min.
//   2. The "fix": a Consumers formula excluding {Buyer Stage}='MATCHED', while
//      the loop required a Referral with Status='Intro Sent'. Matching sets
//      BOTH in the same pass (matching/suggest: Referral → 'Intro Sent',
//      Consumer → Buyer Stage 'MATCHED'), so the formula pre-excluded everyone
//      the loop could nudge. Hourly cron, selected ~0 rows, forever.
//
// The correct selector is Referrals-FIRST — the nudge is about a specific
// intro the buyer didn't act on, so anchor on the Referral state machine:
//   Status='Intro Sent' (matched, not yet accepted/locked/closed)
//   + Deposit Paid At blank (they haven't acted)
//   + Intro Sent At 30min–4h old (Crowd Cow / ButcherBox abandon-cart sweet
//     spot — earlier is pushy, later is forgotten)
// then join to the Consumer for the suppression trio + dedup stamp + email.
//
// Both the Airtable formula (I/O bound) and the in-loop re-check (truth) are
// generated from the SAME constants below, and mirrored by red-first tests in
// lib/noActionNudge.test.ts — the selector can no longer silently select
// nothing.

/** Nudge no earlier than 30min after the intro (earlier = pushy). */
export const NUDGE_WINDOW_MIN_MS = 30 * 60 * 1000;
/** Nudge no later than 4h after the intro (later = forgotten; lifecycle crons own it). */
export const NUDGE_WINDOW_MAX_MS = 4 * 60 * 60 * 1000;

/** Referral fields the selector reads (Airtable REST field names). */
export interface NudgeReferralFields {
  ['Status']?: unknown;
  ['Intro Sent At']?: unknown;
  ['Deposit Paid At']?: unknown;
}

/** Consumer fields the selector reads (suppression trio + dedup + email). */
export interface NudgeConsumerFields {
  ['Email']?: unknown;
  ['Unsubscribed']?: unknown;
  ['Bounced']?: unknown;
  ['Complained']?: unknown;
  ['Notes']?: unknown;
  // Durable dedup stamp (email-hygiene 2026-08-02) — dateTime, UTC ISO.
  // The Notes marker dies to the per-write `.slice(0, 2000)` on chatty
  // records; this field is truncation-proof. Written alongside the marker.
  ['No Action Nudge At']?: unknown;
}

/** Exact Airtable field name on Consumers (created 2026-08-02, exists in prod). */
export const NO_ACTION_NUDGE_AT_FIELD = 'No Action Nudge At';

/**
 * How long the durable `No Action Nudge At` stamp suppresses another nudge.
 * The nudge window itself is only 30min–4h post-intro, so 48h fully covers
 * every re-run/truncation case while never blocking a genuine future
 * re-match (those happen weeks-to-months later). Mirrors the 48h belt the
 * legacy id-less Notes stamp already uses.
 */
export const NO_ACTION_STAMP_SUPPRESS_MS = 48 * 60 * 60 * 1000;

function toMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A referral is nudge-eligible when the intro is out, unanswered by money,
 * and inside the 30min–4h window. Missing/garbage Intro Sent At is NEVER
 * eligible — the watchdog must not guess a window.
 */
export function isNudgeEligibleReferral(ref: NudgeReferralFields, nowMs: number): boolean {
  if (String(ref['Status'] || '') !== 'Intro Sent') return false;
  if (ref['Deposit Paid At']) return false;
  const introMs = toMs(ref['Intro Sent At']);
  if (introMs === null) return false;
  const age = nowMs - introMs;
  return age >= NUDGE_WINDOW_MIN_MS && age <= NUDGE_WINDOW_MAX_MS;
}

/**
 * A consumer is nudge-eligible when none of the suppression trio is set, the
 * claim-before-send dedup stamp isn't already in Notes, and an email exists.
 * (SMS opt-in + quiet hours are gated separately in the route — they only
 * decide the SMS channel, not selection.)
 *
 * PER-REFERRAL DEDUP (2026-07-22, reactivation audit): the stamp used to be
 * per-BUYER (`[no-action-nudge <date>]`, blocked forever) — so a buyer whose
 * old deal went Closed Lost and who was re-matched months later silently lost
 * the abandon-cart touch on every future match. When `referralId` is passed,
 * only a stamp carrying THAT referral id blocks (`[no-action-nudge <refId>
 * <date>]`), plus a 48h belt on legacy id-less stamps (a buyer nudged under
 * the old format may still be inside the 4h window at deploy time). Without a
 * referralId the legacy any-stamp-blocks behavior is preserved.
 */
export function isNudgeEligibleConsumer(
  consumer: NudgeConsumerFields,
  opts: { referralId?: string; nowMs?: number } = {},
): boolean {
  if (consumer['Unsubscribed'] === true) return false;
  if (consumer['Bounced'] === true) return false;
  if (consumer['Complained'] === true) return false;
  // Durable stamp first (email-hygiene 2026-08-02): the Notes marker below is
  // best-effort history — long Notes get sliced and the marker vanishes,
  // which used to re-nudge the buyer. The dateTime field survives truncation.
  const stampMs = toMs(String(consumer[NO_ACTION_NUDGE_AT_FIELD] ?? ''));
  if (stampMs !== null) {
    const nowMs = opts.nowMs ?? Date.now();
    if (nowMs - stampMs < NO_ACTION_STAMP_SUPPRESS_MS) return false;
  }
  const notes = String(consumer['Notes'] || '');
  if (opts.referralId) {
    if (notes.includes(`[no-action-nudge ${opts.referralId}`)) return false;
    const nowMs = opts.nowMs ?? Date.now();
    const legacyRecent = [...notes.matchAll(/\[no-action-nudge (\d{4}-\d{2}-\d{2})\]/g)].some(
      (m) => nowMs - Date.parse(m[1]) < 48 * 60 * 60 * 1000,
    );
    if (legacyRecent) return false;
  } else if (notes.includes('[no-action-nudge')) {
    return false;
  }
  return String(consumer['Email'] || '').trim().length > 0;
}

/**
 * Airtable filterByFormula mirroring isNudgeEligibleReferral — keeps the
 * cron's I/O bounded to the window. The route re-checks every returned row
 * with the predicate (defense in depth: the formula is I/O optimization, the
 * predicate is truth).
 */
export function buildNudgeReferralFormula(cutoffStartISO: string, cutoffEndISO: string): string {
  return `AND(
    {Status} = 'Intro Sent',
    {Deposit Paid At} = BLANK(),
    IS_AFTER({Intro Sent At}, '${cutoffStartISO}'),
    IS_BEFORE({Intro Sent At}, '${cutoffEndISO}')
  )`.replace(/\s+/g, ' ');
}

// ── Day-0 stack fix (email-hygiene 2026-08-02) ──────────────────────────────
// A fresh buyer's day 0 stacked 4 emails in ~4h: welcome → quiz-complete
// deposit/cal invite → intro → THIS nudge. The quiz-complete invite already
// made the exact same ask ("reserve your share") hours earlier — the same-day
// nudge is pure noise. Suppress the nudge when a quiz-complete invite went to
// this buyer inside the last 24h, detected two ways:
//   1. the Referral's own 'Deposit Invite Sent At' stamp (written by
//      /api/qualify when quiz_complete_deposit_invite fires), and
//   2. an Email Sends row for quiz_complete_deposit_invite OR
//      quiz_complete_cal_invite to the same recipient (the cal variant stamps
//      nothing on the Referral — the send log is its only trace). The cron
//      does ONE Email Sends read per run and passes the recipient set here.

export const SAME_DAY_INVITE_SUPPRESS_MS = 24 * 60 * 60 * 1000;

export const QUIZ_INVITE_TEMPLATE_NAMES = [
  'quiz_complete_deposit_invite',
  'quiz_complete_cal_invite',
] as const;

/** Airtable formula for the one-per-run Email Sends read (recent quiz invites). */
export function buildRecentQuizInviteFormula(sinceISO: string): string {
  const templateOr = QUIZ_INVITE_TEMPLATE_NAMES.map((t) => `{Template Name}="${t}"`).join(', ');
  return `AND({Sent At} > "${sinceISO}", {Status}="sent", OR(${templateOr}))`;
}

/**
 * Did this buyer already get the quiz-complete invite (the same ask) within
 * the suppress window? Pure — the route supplies the referral stamp + the
 * recipient set from its single Email Sends read.
 */
export function hasSameDayQuizInvite(opts: {
  /** Referral field 'Deposit Invite Sent At'. */
  depositInviteSentAt?: unknown;
  /** The buyer's email (any case — normalized here). */
  email?: unknown;
  /** Lowercased recipient emails of quiz-complete invites sent in-window. */
  recentInviteEmails?: ReadonlySet<string>;
  nowMs: number;
}): boolean {
  const inviteMs = toMs(String(opts.depositInviteSentAt ?? ''));
  if (inviteMs !== null && opts.nowMs - inviteMs < SAME_DAY_INVITE_SUPPRESS_MS) return true;
  const email = String(opts.email || '').trim().toLowerCase();
  if (email && opts.recentInviteEmails?.has(email)) return true;
  return false;
}
