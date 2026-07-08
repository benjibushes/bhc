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
//   - Status ∈ {Intro Sent, Rancher Contacted} (the pre-money stages).
//     Negotiation / Awaiting Payment / Slot Locked NEVER expire here —
//     those are live or money-adjacent.
//   - No deposit signal of any kind (Deposit Requested At / Deposit Paid At /
//     Deposit Amount) — anything money-touched is the operator's call.
//   - No activity from EITHER side for `staleDays` (default 21): the newest
//     of Last Rancher Activity At / Last Buyer Activity At / Intro Sent At /
//     created time is older than the cutoff.
//
// Expiry flips Status → 'Dormant': the slot frees (countHeldReferrals skips
// Dormant), the stored counter self-heals within ~2h (batch-approve
// recompute), the buyer stays re-marketable (lib/demandRouter treats Dormant
// as not-in-deal), and the daily stuck-buyer-recovery cron can route the
// freed capacity the next morning.

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

export const EXPIRABLE_STATUSES = new Set(['Intro Sent', 'Rancher Contacted']);
export const DEFAULT_STALE_DAYS = 21;

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
  if (!EXPIRABLE_STATUSES.has(String(ref?.Status || ''))) return false;
  // Any deposit signal → never auto-expire (operator's call).
  if (ref['Deposit Requested At'] || ref['Deposit Paid At']) return false;
  if (Number(ref['Deposit Amount'] || 0) > 0) return false;
  const newest = newestActivityMs(ref);
  // No timestamp at all → don't guess; leave it for the operator.
  if (newest === 0) return false;
  return now - newest > staleDays * 24 * 60 * 60 * 1000;
}

/** Select expirable rows (oldest first), capped for rate-limit sanity. */
export function selectStaleHolds(
  referrals: StaleHoldRow[],
  now: number,
  opts?: { staleDays?: number; cap?: number },
): StaleHoldRow[] {
  const staleDays = opts?.staleDays ?? DEFAULT_STALE_DAYS;
  const cap = opts?.cap ?? 50;
  return referrals
    .filter((r) => isStaleHold(r, now, staleDays))
    .sort((a, b) => newestActivityMs(a) - newestActivityMs(b))
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
