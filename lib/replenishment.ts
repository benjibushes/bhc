// lib/replenishment.ts
//
// T2.3 (2026-07-02): pure eligibility selector for the replenishment cron
// (app/api/cron/replenishment). A beef share runs out on a schedule — a
// quarter feeds a household ~4 months, a half ~6, a whole ~10+. Nobody asks
// the buyer to reorder at the moment their freezer runs low, so repeat
// revenue (the cheapest revenue there is) never happens on purpose.
//
// Eligibility (ALL must hold), judged from the Referrals row + linked buyer:
//   - Status === 'Closed Won' and Sale Amount > 0 (a real, paid deal)
//   - Closed At is at least cutReplenishDays(orderType) ago (cut-aware:
//     the freezer-empty moment differs by share size) and at most
//     REPLENISH_MAX_WINDOW_DAYS past that threshold (when the cron first
//     goes live we don't blast years-stale buyers whose moment passed)
//   - 'Replenishment Nudged At' is empty — ONE nudge per deal, ever. The
//     cron stamps claim-before-send; a corrupt stamp reads as SENT (skip,
//     never storm) — same fail-safe posture as lib/waitingActivation.
//   - the buyer has an email + is not Unsubscribed/Bounced/Complained
//
// Ordering: oldest Closed At first (their freezer has been empty longest).
// Output capped per run to pace sends.

export interface ReplenishReferralLike {
  id?: string;
  Status?: unknown;
  'Sale Amount'?: unknown;
  'Closed At'?: unknown;
  'Order Type'?: unknown;
  'Replenishment Nudged At'?: unknown;
  Buyer?: unknown;
  'Buyer Email'?: unknown;
  [key: string]: unknown;
}

export interface ReplenishBuyerLike {
  Email?: unknown;
  Unsubscribed?: unknown;
  Bounced?: unknown;
  Complained?: unknown;
  'Full Name'?: unknown;
  [key: string]: unknown;
}

const DAY_MS = 86_400_000;

/** How long a share of each size feeds a household before the freezer runs
 * low. Deliberately conservative (nudge a touch early — beef in the freezer
 * still keeps; an empty freezer means they already bought grocery beef). */
export function cutReplenishDays(orderType: unknown): number {
  const t = String(orderType || '').toLowerCase();
  if (t.includes('quarter')) return 120;
  if (t.includes('whole')) return 300;
  if (t.includes('half')) return 180;
  return 180; // unknown/Not Sure → the half-cow midpoint
}

/** Late cap: past threshold + this window the moment has passed — skip
 * rather than nudge a buyer about a 3-year-old order on go-live day. */
export const REPLENISH_MAX_WINDOW_DAYS = 180;

export interface ReplenishOptions {
  nowISO: string;
  batchCap: number;
}

/**
 * Per-referral predicate (buyer suppression is checked separately by the
 * caller, which owns the Consumers lookup). Pure.
 */
export function isReplenishEligible(
  ref: ReplenishReferralLike,
  opts: Pick<ReplenishOptions, 'nowISO'>,
): boolean {
  if (String(ref['Status'] || '').trim() !== 'Closed Won') return false;
  const sale = Number(ref['Sale Amount']);
  if (!Number.isFinite(sale) || sale <= 0) return false;

  // One nudge per deal, ever. Any non-empty stamp — parseable or not —
  // counts as sent (a corrupt stamp must never cause a re-send).
  if (String(ref['Replenishment Nudged At'] || '').trim()) return false;

  const closedMs = Date.parse(String(ref['Closed At'] || ''));
  if (!Number.isFinite(closedMs)) return false;
  const nowMs = Date.parse(opts.nowISO);
  if (!Number.isFinite(nowMs)) return false;

  const ageDays = (nowMs - closedMs) / DAY_MS;
  const threshold = cutReplenishDays(ref['Order Type']);
  return ageDays >= threshold && ageDays <= threshold + REPLENISH_MAX_WINDOW_DAYS;
}

/** Buyer-side suppression — mirrors the repo's standard trio + email check. */
export function isReplenishBuyerContactable(buyer: ReplenishBuyerLike | null | undefined): boolean {
  if (!buyer) return false;
  if (!String(buyer['Email'] || '').trim()) return false;
  if (buyer['Unsubscribed'] || buyer['Bounced'] || buyer['Complained']) return false;
  return true;
}

/**
 * Pick the referrals to nudge this run: eligible, oldest close first, capped.
 * Buyer contactability is enforced by the cron after its Consumers fetch —
 * this selector only orders + caps the referral-side decision.
 */
export function selectReplenishReferrals<T extends ReplenishReferralLike>(
  referrals: T[],
  opts: ReplenishOptions,
): T[] {
  const cap = Math.floor(opts.batchCap);
  if (!Array.isArray(referrals) || referrals.length === 0 || cap <= 0) return [];
  return referrals
    .filter((r) => isReplenishEligible(r, opts))
    .sort(
      (a, b) =>
        (Date.parse(String(a['Closed At'] || '')) || 0) -
        (Date.parse(String(b['Closed At'] || '')) || 0),
    )
    .slice(0, cap);
}
