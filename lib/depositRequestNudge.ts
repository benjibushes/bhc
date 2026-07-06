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
