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

export const DEPOSIT_NUDGE_LIFETIME_CAP = 2;
export const DEPOSIT_NUDGE_MIN_AGE_MS = 24 * 60 * 60 * 1000; // 24h after request
export const DEPOSIT_NUDGE_COOLDOWN_MS = 48 * 60 * 60 * 1000; // 48h between nudges

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

// ── DEPOSIT-ABANDON RAIL (2026-07-05) ────────────────────────────────────────
// The rancher-request rail above only fires when a RANCHER hit "request
// deposit" (Deposit Requested At set). But a quiz-complete buyer routed to a
// deposit-capable rancher gets a deposit link too — sendQuizCompleteDepositInvite
// stamps 'Deposit Invite Sent At' — and if they don't pay, NOTHING chased them.
// That's the "abandoned cart" of the funnel (the single highest-ROI trigger in
// the research). Same copy, same caps, same claim-before-send; only the entry
// signal differs. Deliberately mutually exclusive with the rail above
// (requires Deposit Requested At EMPTY) so a referral is never double-nudged.
//
// Terminal statuses stop the nudge: a paid, accepted (Slot Locked), or closed
// referral is done. Denylist (not allowlist) so a new mid-funnel status can't
// silently strand a buyer.

// Statuses that mean "stop nudging — the deal moved past the deposit ask."
const ABANDON_STOP_STATUSES = new Set(['Closed Won', 'Closed Lost', 'Slot Locked']);

/**
 * Pure per-row predicate for the deposit-ABANDON rail: a quiz-complete deposit
 * invite that was sent, never paid, and isn't terminal. Shares the same cap +
 * cooldown fields as the rancher-request rail so a referral that somehow
 * qualifies for both is still capped once.
 */
export function isDepositAbandonEligible(
  r: DepositNudgeReferralLike,
  nowMs: number,
): boolean {
  // Must be a quiz-complete invite (invite stamp set) — and NOT a rancher
  // request (that's the other rail; keeps the two disjoint).
  const invitedMs = parseMs(r['Deposit Invite Sent At']);
  if (invitedMs === null) return false;
  if (String(r['Deposit Requested At'] || '').trim()) return false;

  // Unpaid + not past the deposit ask.
  if (String(r['Deposit Paid At'] || '').trim()) return false;
  if (ABANDON_STOP_STATUSES.has(statusName(r['Status']))) return false;

  // Give the original invite 24h before the first nudge.
  if (nowMs - invitedMs < DEPOSIT_NUDGE_MIN_AGE_MS) return false;

  // Shared lifetime cap: 2 buyer nudges, then silence.
  if (nudgeCount(r) >= DEPOSIT_NUDGE_LIFETIME_CAP) return false;

  // Shared cooldown. Corrupt stamp => treat as recent (skip) — no nudge storm.
  const lastRaw = String(r['Deposit Nudge Last Sent At'] || '').trim();
  if (lastRaw) {
    const lastMs = Date.parse(lastRaw);
    if (!Number.isFinite(lastMs)) return false;
    if (nowMs - lastMs < DEPOSIT_NUDGE_COOLDOWN_MS) return false;
  }

  return true;
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

// PLACEHOLDER COPY — marketing is drafting the final body in
// docs/marketing/sms-deposit-nudge.md; when it lands, swap THIS constant only
// (tokens: {first} {rancher} {link}). Keep it short, honest, STOP-compliant.
export const DEPOSIT_SMS_NUDGE_BODY =
  '{first}, your beef share with {rancher} is still reserved — the deposit link is waiting: {link} — Ben @ BuyHalfCow. Reply STOP to opt out.';

/** Fill the SMS template. Pure string work — the cron owns every send gate. */
export function renderDepositSmsNudge(ctx: {
  firstName: string;
  rancherName: string;
  link: string;
}): string {
  return DEPOSIT_SMS_NUDGE_BODY
    .replace('{first}', String(ctx.firstName || 'there').trim() || 'there')
    .replace('{rancher}', String(ctx.rancherName || 'your rancher').trim() || 'your rancher')
    .replace('{link}', String(ctx.link || '').trim());
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
