// lib/depositWatchdog.ts
//
// MONEY-TRUTH invariant 1b: detect the HALF-STATE — a referral flipped to
// Status='Awaiting Payment' but the buyer was NEVER sent a deposit invite
// ('Deposit Invite Sent At' blank). Every send rail stamps that field on a
// successful buyer email (rancher request-deposit, quiz-complete invite,
// admin send-deposit-invoice); if it's blank >2h after the flip, the buyer is
// silently waiting on a link nobody sent. That is a lost sale in progress.
//
// This is deliberately DISJOINT from lib/depositRequestNudge.ts: the nudge
// rails chase SENT-but-unpaid invites (invite stamp present). The watchdog
// fires ONLY when the invite stamp is absent — sent-but-unpaid never reaches
// it, and an invited referral never double-alerts.
//
// CRITICAL exclusion: 'Deposit Paid At' present ⇒ NOT a target. Paid deals
// KEEP Status='Awaiting Payment' (settleBuyerDeposit does not flip status),
// so without this clause the watchdog would scream about money already
// collected.
//
// SCOPE (GTM audit 2026-07-21): the watchdog targets the DEPOSIT RAIL only —
// a referral is eligible ONLY when 'Deposit Requested At' is stamped (the
// rail's entry stamp). Legacy deals and desk stage-advances also sit in
// Status='Awaiting Payment' with no invite stamp — by design, they have no
// deposit flow at all — and anchoring on createdTime made the watchdog cry
// wolf on every one of them (6 false alarms on the first prod run).
//
// Age anchor: 'Deposit Requested At'. Unparseable ⇒ NOT eligible — never
// alert on unknown age.
//
// Same discipline as lib/depositRequestNudge.ts / lib/finalInvoiceDunning.ts:
// pure, dependency-free selection so the colocated node:test file runs
// without Airtable or the secrets chain.

export const WATCHDOG_MIN_AGE_MS = 2 * 60 * 60 * 1000; // 2h — let the send rails finish/retry
export const WATCHDOG_COOLDOWN_MS = 24 * 60 * 60 * 1000; // re-alert at most daily per referral

export interface WatchdogReferralLike {
  id?: string;
  _createdTime?: unknown;
  ['Status']?: unknown;
  ['Deposit Paid At']?: unknown;
  ['Deposit Invite Sent At']?: unknown;
  ['Deposit Requested At']?: unknown;
  ['Deposit Watchdog Alerted At']?: unknown;
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

/**
 * The age anchor for a referral: 'Deposit Requested At' if parseable, else
 * null = unknown age / not on the deposit rail (no 'Deposit Requested At').
 */
export function watchdogAnchorMs(r: WatchdogReferralLike): number | null {
  return parseMs(r['Deposit Requested At']);
}

/**
 * Why this referral is NOT a watchdog target right now — or null when it IS.
 * Split out so the cron can report a skipReasonBreakdown without re-deriving
 * the logic.
 */
export function watchdogSkipReason(
  r: WatchdogReferralLike,
  nowMs: number,
): string | null {
  if (statusName(r['Status']) !== 'Awaiting Payment') return 'wrong-status';

  // Paid deals keep Status='Awaiting Payment' — excluding them is mandatory
  // or the watchdog alerts on money already collected.
  if (String(r['Deposit Paid At'] || '').trim()) return 'already-paid';

  // The invite went out — the sent-but-unpaid chase belongs to
  // deposit-request-nudge, not the watchdog.
  if (String(r['Deposit Invite Sent At'] || '').trim()) return 'invite-sent';

  const anchorMs = watchdogAnchorMs(r);
  if (anchorMs === null) return 'no-parseable-anchor'; // never alert on unknown age
  if (nowMs - anchorMs < WATCHDOG_MIN_AGE_MS) return 'too-young';

  // Cooldown: an alert in the last 24h means the operator already knows.
  // An unparseable (corrupt) stamp counts as RECENT — never alert-storm.
  const alertedRaw = String(r['Deposit Watchdog Alerted At'] || '').trim();
  if (alertedRaw) {
    const alertedMs = Date.parse(alertedRaw);
    if (!Number.isFinite(alertedMs)) return 'cooldown';
    if (nowMs - alertedMs < WATCHDOG_COOLDOWN_MS) return 'cooldown';
  }

  return null;
}

/** Pure per-row predicate: is this referral in the never-invited half-state? */
export function isWatchdogTarget(r: WatchdogReferralLike, nowMs: number): boolean {
  return watchdogSkipReason(r, nowMs) === null;
}

// ── SELF-HEAL (2026-07-22, false-alarm incident) ────────────────────────────
// A blank 'Deposit Invite Sent At' does NOT prove the invite was never sent —
// it can just mean the stamp field didn't exist when the send happened
// (referrals invited before PR #410) or a send path we haven't audited didn't
// stamp. Email Sends is the ground truth. Before the cron alarms a target, it
// pulls that buyer's deposit-invite sends: if any 'sent' one exists, the field
// gets BACKFILLED from that timestamp and NO alarm fires — the instrument
// heals itself instead of crying wolf. Only a target with ZERO real
// deposit-invite send is a genuine "never sent".

// Templates that ARE a buyer deposit invite (the link that asks for the
// deposit). Nudges (deposit_request_nudge_*) are follow-ups, not the invite,
// so they do NOT count as proof the original invite went out.
export const DEPOSIT_INVITE_TEMPLATES: ReadonlySet<string> = new Set([
  'buyer_deposit_invoice',
  'quiz_complete_deposit_invite',
]);

export interface EmailSendLike {
  ['Template Name']?: unknown;
  ['Status']?: unknown;
  ['Sent At']?: unknown;
  [key: string]: unknown;
}

/**
 * The earliest SUCCESSFUL deposit-invite send timestamp (ISO) from a buyer's
 * Email Sends rows, or null if none was ever sent. Pure — the cron passes the
 * rows it fetched. Suppressed/failed sends do NOT count (the buyer never got a
 * link), so a cap-suppressed-only history correctly stays a real alarm.
 */
export function earliestSentDepositInvite(rows: EmailSendLike[]): string | null {
  if (!Array.isArray(rows)) return null;
  let best: number | null = null;
  let bestIso: string | null = null;
  for (const row of rows) {
    const template = String(row['Template Name'] || '').trim();
    if (!DEPOSIT_INVITE_TEMPLATES.has(template)) continue;
    if (String(row['Status'] || '').trim().toLowerCase() !== 'sent') continue;
    const ms = parseMs(row['Sent At']);
    if (ms === null) continue;
    if (best === null || ms < best) {
      best = ms;
      bestIso = new Date(ms).toISOString();
    }
  }
  return bestIso;
}

/**
 * Select the referrals to alert on this run: eligible per the predicate,
 * oldest anchor first (the longest-waiting buyer is bleeding hardest).
 * Capping is the cron's job (it also owns claim-before-alert).
 */
export function selectWatchdogTargets(
  records: any[],
  opts: { now: Date },
): any[] {
  if (!Array.isArray(records) || records.length === 0) return [];
  const nowMs = opts.now.getTime();
  return records
    .filter((r) => isWatchdogTarget(r, nowMs))
    .sort((a, b) => (watchdogAnchorMs(a) ?? 0) - (watchdogAnchorMs(b) ?? 0));
}
