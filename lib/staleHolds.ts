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
  'Buyer Name'?: unknown;
  _createdTime?: string;
}

export const EXPIRABLE_STATUSES = new Set(['Intro Sent', 'Rancher Contacted', 'Negotiation']);
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
};

/** Silence window (in days) that a given status must exceed to expire. */
export function staleDaysForStatus(status: string, baseDays: number): number {
  return baseDays * (STALE_DAYS_MULTIPLIER[String(status || '')] ?? 1);
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
 *  - rows with NO Rancher link are excluded — they hold no counted capacity
 *    (countHeldReferrals attributes via the Rancher link), so flipping them
 *    frees nothing while burning run-cap.
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
  const linkedRancher = (r: StaleHoldRow): string => {
    const link = Array.isArray(r['Rancher']) ? (r['Rancher'] as unknown[]) : [];
    return link.length > 0 ? String(link[0]) : '';
  };
  return referrals
    .filter((r) => isStaleHold(r, now, staleDays) && linkedRancher(r) !== '')
    .sort((a, b) => {
      const ap = priority.has(linkedRancher(a)) ? 0 : 1;
      const bp = priority.has(linkedRancher(b)) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return newestActivityMs(a) - newestActivityMs(b);
    })
    .slice(0, cap);
}

/** Per-rancher freed-slot counts for the Telegram report. */
export function freedByRancher(rows: StaleHoldRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const link = Array.isArray(r['Rancher']) ? (r['Rancher'] as unknown[]) : [];
    const key = link.length > 0 ? String(link[0]) : '(unlinked)';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}
