// lib/staleHolds.ts
//
// STALE CAPACITY HOLDS (routing sweep 2026-07-08). Pure selector for the
// referral-stale-expiry cron.
//
// THE LEAK THIS CLOSES: a referral holds a rancher capacity slot from Intro
// Sent until Closed Won/Lost (lib/capacityCount.ts) — but nothing ever
// expired the ones that died quietly. Live data at discovery: Silverline
// 60 open holds vs cap 50, Foodstead 59/50 — both read FULL to the matcher
// almost entirely on months-old intros nobody closed out, while fresh
// qualified buyers in their states sat READY and unrouted. The founder rule
// is the right one: ranchers keep receiving leads until they actually sell
// out — dead intros must drain back into the pool.
//
// CONSERVATIVE BY DESIGN — a hold only expires when ALL are true:
//   - Status ∈ EXPIRABLE_STATUSES (the pre-money stages). Awaiting Payment /
//     Slot Locked NEVER expire here — those are money-committed.
//   - No deposit signal of any kind (Deposit Requested At / Deposit Paid At /
//     Deposit Amount) — anything money-touched is the operator's call.
//   - No activity from EITHER side for the status's window: the newest of
//     Last Rancher Activity At / Last Buyer Activity At / Intro Sent At /
//     created time is older than the cutoff.
//
// ── 'Negotiation' ADDED 2026-07-25 (pause-asymmetry sweep) ─────────────────
// The original cut excluded 'Negotiation' as "live". That was the wrong call
// and it cost real routing: 'Negotiation' IS in HELD_REFERRAL_STATUSES
// (lib/capacityCount.ts) so it holds a rancher capacity slot, but NO expiry
// path could ever release it. Live at discovery: 24 referrals parked in
// Negotiation, oldest silent since April, ALL 24 already carrying the
// close-detector's far-future give-up sentinel — so nothing on the platform
// was ever going to ask about them again. They were permanent phantom load on
// their ranchers' capacity.
//
// It gets a LONGER window than an unanswered intro rather than silently
// inheriting the same one: a real negotiation is more alive than an intro
// nobody replied to, and a wrong flip here is more expensive. The window is
// expressed as a MULTIPLE of the base so `STALE_HOLD_DAYS` stays the single
// knob that scales the whole rail coherently.
//   Intro Sent / Rancher Contacted → staleDays      (21 default)
//   Negotiation                    → staleDays × 2  (42 default)
// Deposit signals still block expiry at ANY age, in every status.
//
// Expiry flips Status → 'Dormant' AND (bulletproof 2026-07-08) the cron
// closes the loop itself: it resets stranded buyers (MATCHED → READY when no
// live deal remains) and resyncs the capacity counters (Redis + Airtable
// mirror) in the same run — freed slots are visible to the matcher
// immediately and the 14:30 UTC stuck-buyer-recovery pass routes them the
// same day.
//
// ── 'Pending Approval' ADDED 2026-07-30 (no-dead-end-deals sweep) ──────────
// The second hole. 'Pending Approval' is NOT a capacity-holding status (it is
// pre-INCR by design — see lib/capacityCount.ts) so the original cut, which
// was written to free capacity, had no reason to include it. But
// isActiveDealReferral DOES treat a Pending Approval row with a linked (or
// suggested) rancher as a live deal — so a rancher who never taps
// approve/decline freezes the BUYER out of every routing rail, forever.
// Live at discovery: 6 buyers stuck 58, 58, 60, 75, 80 and 92 days, none of
// them reachable by any other rail on the platform.
//
// It gets the SHORTEST window of any status, for the mirror-image reason
// Negotiation gets the longest: an unanswered approval card is the coldest
// signal we have. A rancher who has not clicked a one-tap yes/no button in a
// week is not going to. Window is a multiple of the base so `STALE_HOLD_DAYS`
// stays the single knob:
//   Pending Approval               → staleDays × 1/3  (7 default)
//   Intro Sent / Rancher Contacted → staleDays        (21 default)
//   Negotiation                    → staleDays × 2    (42 default)
// This tier frees no capacity slot — it frees the BUYER. Callers should
// report it as such rather than counting it as a slot.
//
// ── `Hold Until` now blocks expiry in EVERY status (2026-07-30) ────────────
// A future `Hold Until` is the operator's explicit "park this, come back to
// it" (the Telegram ⏸️ Hold button — lib/referralHold.ts). referral-chasup
// and close-detector already skip parked rows; expiry did not, so a hold
// could be auto-expired out from under the operator. Fail-OPEN on blank /
// corrupt values, exactly like isReferralOnHold. This is strictly more
// conservative than before, in both the old and the new tiers, and it matters
// most for Pending Approval — that is the one status the hold button writes.

import { isReferralOnHold } from './referralHold';

export interface StaleHoldRow {
  id: string;
  Status?: unknown;
  'Deposit Requested At'?: unknown;
  'Deposit Paid At'?: unknown;
  'Deposit Amount'?: unknown;
  'Last Rancher Activity At'?: unknown;
  'Last Buyer Activity At'?: unknown;
  'Intro Sent At'?: unknown;
  'Rancher'?: unknown;
  /** Pending Approval is pre-INCR: it can carry only a SUGGESTED rancher. */
  'Suggested Rancher'?: unknown;
  'Buyer Name'?: unknown;
  /** My Leads (2026-07-29): 'rancher-added' rows never auto-expire. */
  'Referral Source'?: unknown;
  /** Operator park pointer (lib/referralHold.ts) — a future value blocks expiry. */
  'Hold Until'?: unknown;
  _createdTime?: string;
}

/**
 * The original (2026-07-08) tier: pre-money statuses that HOLD A CAPACITY SLOT
 * (all three are in HELD_REFERRAL_STATUSES). Expiring one gives the rancher a
 * slot back.
 */
export const CAPACITY_HOLD_EXPIRABLE_STATUSES = new Set([
  'Intro Sent',
  'Rancher Contacted',
  'Negotiation',
]);

/**
 * The no-dead-end tier (2026-07-30): statuses that hold NO capacity slot but
 * still block the buyer via isActiveDealReferral. Expiring one gives the
 * BUYER back to routing.
 */
export const BUYER_BLOCK_EXPIRABLE_STATUSES = new Set(['Pending Approval']);

export const EXPIRABLE_STATUSES = new Set([
  ...CAPACITY_HOLD_EXPIRABLE_STATUSES,
  ...BUYER_BLOCK_EXPIRABLE_STATUSES,
]);
export const DEFAULT_STALE_DAYS = 21;

/**
 * Per-status silence window, as a multiple of the base `staleDays`. Any status
 * not listed uses the base window (×1). Explicit map (not a bare default) so
 * "why does Negotiation get longer?" is answerable from the code.
 */
export const STALE_DAYS_MULTIPLIER: Record<string, number> = {
  // A negotiation that has gone quiet is still a warmer thing than an intro
  // nobody answered — give it double the rope before releasing the slot.
  Negotiation: 2,
  // ...and an approval card nobody tapped is colder than either. A rancher who
  // has not answered a one-tap yes/no in a third of the base window (7d at the
  // 21d default) is not going to; every extra day is a buyer locked out of the
  // whole marketplace for nothing. Expressed as a fraction, not a literal 7,
  // so STALE_HOLD_DAYS still scales the entire rail coherently.
  'Pending Approval': 1 / 3,
};

/** Silence window (in days) that a given status must exceed to expire. */
export function staleDaysForStatus(status: string, baseDays: number): number {
  return baseDays * (STALE_DAYS_MULTIPLIER[String(status || '')] ?? 1);
}

/**
 * Human-readable day count for Telegram lines + the Notes audit stamp. The
 * multipliers are fractional, so a non-default STALE_HOLD_DAYS can produce
 * 3.3333333333333335 — never print that at an operator.
 */
export function formatDays(days: number): string {
  if (!Number.isFinite(days)) return '?';
  return Number.isInteger(days) ? String(days) : String(Math.round(days * 10) / 10);
}

/**
 * The rancher a flip is attributed to, for prioritization + the operator
 * report. Prefers the `Rancher` link (a capacity-holding row always has it —
 * the INCR fires at Intro Sent, which sets it). Pending Approval is pre-INCR
 * and may carry ONLY a `Suggested Rancher`, so that tier falls back to the
 * suggestion — otherwise the rows this whole tier exists to release would be
 * dropped by selectStaleHolds' unlinked filter.
 */
export function attributedRancherId(ref: StaleHoldRow): string {
  const first = (v: unknown): string => {
    const arr = Array.isArray(v) ? (v as unknown[]) : [];
    return arr.length > 0 ? String(arr[0]) : '';
  };
  const direct = first(ref['Rancher']);
  if (direct) return direct;
  if (BUYER_BLOCK_EXPIRABLE_STATUSES.has(String(ref?.Status || ''))) {
    return first(ref['Suggested Rancher']);
  }
  return '';
}

function newestActivityMs(ref: StaleHoldRow): number {
  const candidates = [
    ref['Last Rancher Activity At'],
    ref['Last Buyer Activity At'],
    ref['Intro Sent At'],
    ref._createdTime,
  ];
  let newest = 0;
  for (const c of candidates) {
    if (!c) continue;
    const t = new Date(String(c)).getTime();
    if (isFinite(t) && t > newest) newest = t;
  }
  return newest;
}

/** Pure: is this referral an expirable stale hold as of `now`? */
export function isStaleHold(
  ref: StaleHoldRow,
  now: number,
  staleDays: number = DEFAULT_STALE_DAYS,
): boolean {
  const status = String(ref?.Status || '');
  if (!EXPIRABLE_STATUSES.has(status)) return false;
  // My Leads (2026-07-29): a rancher-entered lead ('Referral Source' =
  // 'rancher-added', lib/rancherLeads) is the rancher's OWN customer — it can
  // legitimately sit quiet for months (market-season timing) and it holds no
  // counted capacity (lib/capacityCount skips it), so expiring it frees
  // nothing and silently deletes the rancher's pipeline. Never auto-expire.
  const src = ref?.['Referral Source'];
  const srcStr =
    src && typeof src === 'object' && 'name' in (src as any)
      ? String((src as any).name || '')
      : String(src ?? '');
  if (srcStr.trim() === 'rancher-added') return false;
  // Operator park (2026-07-30): a future `Hold Until` is an explicit "come
  // back to this" from the Telegram ⏸️ Hold button — the same guard
  // referral-chasup and close-detector already apply. Fail-OPEN: blank or
  // unparseable never hides a row forever (lib/referralHold.ts).
  if (isReferralOnHold(ref['Hold Until'], now)) return false;
  // Any deposit signal → never auto-expire (operator's call).
  if (ref['Deposit Requested At'] || ref['Deposit Paid At']) return false;
  if (Number(ref['Deposit Amount'] || 0) > 0) return false;
  const newest = newestActivityMs(ref);
  // No timestamp at all → don't guess; leave it for the operator.
  if (newest === 0) return false;
  const windowDays = staleDaysForStatus(status, staleDays);
  return now - newest > windowDays * 24 * 60 * 60 * 1000;
}

/**
 * Select expirable rows, capped for rate-limit sanity.
 * Bulletproof 2026-07-08:
 *  - rows with NO attributed rancher are excluded — for the capacity tier they
 *    hold no counted capacity (countHeldReferrals attributes via the Rancher
 *    link), so flipping them frees nothing while burning run-cap. Pending
 *    Approval attributes through `Suggested Rancher` too (attributedRancherId)
 *    — an orphan Pending Approval with NEITHER link is already inactive to
 *    isActiveDealReferral (the 2026-05-09 orphan fix), so it blocks nobody and
 *    flipping it would be pure noise.
 *  - opts.priorityRancherIds (capacity-blocked OPERATIONAL ranchers) sort
 *    FIRST — the flips that actually reopen routing land on day one instead
 *    of behind no-op backlog. Oldest-first within each group.
 */
export function selectStaleHolds(
  referrals: StaleHoldRow[],
  now: number,
  opts?: { staleDays?: number; cap?: number; priorityRancherIds?: Set<string> },
): StaleHoldRow[] {
  const staleDays = opts?.staleDays ?? DEFAULT_STALE_DAYS;
  const cap = opts?.cap ?? 50;
  const priority = opts?.priorityRancherIds ?? new Set<string>();
  return referrals
    .filter((r) => isStaleHold(r, now, staleDays) && attributedRancherId(r) !== '')
    .sort((a, b) => {
      const ap = priority.has(attributedRancherId(a)) ? 0 : 1;
      const bp = priority.has(attributedRancherId(b)) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return newestActivityMs(a) - newestActivityMs(b);
    })
    .slice(0, cap);
}

/** Per-rancher freed counts for the Telegram report. */
export function freedByRancher(rows: StaleHoldRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const key = attributedRancherId(r) || '(unlinked)';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/**
 * Days of silence behind a selected row — for the operator report ("stuck
 * 92d"), so a human reading the Telegram line sees how long this actually sat.
 * Returns null when the row carries no timestamp at all (isStaleHold already
 * refuses those, so this is defensive).
 */
export function silentDays(ref: StaleHoldRow, now: number): number | null {
  const newest = newestActivityMs(ref);
  if (newest === 0) return null;
  return Math.floor((now - newest) / (24 * 60 * 60 * 1000));
}

/**
 * The Notes audit stamp for an expired row, so cron-expired is distinguishable
 * from a hand-set Dormant months later. Pure so the exact wording is pinned by
 * a test rather than drifting inside the cron.
 *
 * Carries BOTH numbers, because either alone misleads:
 *  - the ACTUAL silence, so a human sees this sat 92 days, not 7;
 *  - the WINDOW that applied to this row's status — a Negotiation expires on
 *    2×staleDays and a Pending Approval on ⅓×, so quoting a flat 21d would be
 *    wrong for two of the three tiers.
 * Human-readable only: nothing in the codebase parses this string.
 */
export function expiryNoteStamp(
  ref: StaleHoldRow,
  opts: { today: string; staleDays: number; nowMs: number },
): string {
  const status = String(ref?.Status || '') || 'open hold';
  const applied = formatDays(staleDaysForStatus(status, opts.staleDays));
  const silent = silentDays(ref, opts.nowMs);
  // Pending Approval frees no capacity slot — say what it actually freed, or
  // the record lies to the next person who reads it.
  const outcome = BUYER_BLOCK_EXPIRABLE_STATUSES.has(status)
    ? 'rancher never answered the approval card — buyer released back to matching'
    : 'slot released';
  return (
    `[auto-expired ${opts.today}: ${status} — silent ${silent === null ? '?' : silent}d ` +
    `(window ${applied}d) — ${outcome}]`
  );
}
