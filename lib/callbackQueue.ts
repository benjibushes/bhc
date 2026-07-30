// lib/callbackQueue.ts
//
// THE DIAL QUEUE — "who do I ring RIGHT NOW", across every source at once.
//
// lib/closeQueue.ts already ranks OPEN DEALS by how much money one more call is
// worth. This module answers a different, earlier question: of every buyer the
// business can see, who has earned the next dial. The difference matters
// because the single hottest row in the business has no deal attached to it at
// all — a buyer who read a real dollar amount, stopped, and asked to be called.
//
// THE ORDER, and why it is this order:
//
//   1. callback           — they ASKED. Inbound beats every outbound guess we
//                           could make, and the ask is a promise with a clock
//                           on it. Nothing outranks this, ever.
//   2. deposit-opened     — they opened a checkout and did not pay. Money was
//                           on the screen and something stopped them; a human
//                           can usually name it in ninety seconds.
//   3. qualified-no-deal  — quiz done, a cut on file, nothing live. Warm and
//                           unblocked, but nobody has stood at a price yet.
//   4. other              — everything else. Present so the queue never
//                           silently drops a row, never because it is worth a
//                           cold dial.
//
// WITHIN a tier the sort direction FLIPS on purpose:
//   • callback rows sort OLDEST-FIRST. A callback request is a debt, and the
//     one that has waited longest is the one closest to becoming a bad review.
//   • every other tier sorts NEWEST-FIRST, because heat decays. A deposit page
//     opened forty minutes ago is a live conversation; the same event three
//     weeks ago is archaeology.
// Rows with no phone number sink below callable rows inside their own tier —
// they are still listed (email is a path) but they cannot be *dialed*, and this
// is a dial queue.
//
// PURE: no I/O, no Date.now() (the caller passes `now`), no mutation of input.
// Every Airtable field name stays in the caller; this module speaks camelCase.

/** Tiers, most-callable first. The array order IS the ranking. */
export const DIAL_TIERS = [
  'callback',
  'deposit-opened',
  'qualified-no-deal',
  'other',
] as const;

export type DialTier = (typeof DIAL_TIERS)[number];

export const DIAL_TIER_RANK: Record<DialTier, number> = {
  callback: 0,
  'deposit-opened': 1,
  'qualified-no-deal': 2,
  other: 3,
};

/** Desk-facing one-liner for why this row is in this tier. */
export const DIAL_TIER_REASON: Record<DialTier, string> = {
  callback: 'asked for a call',
  'deposit-opened': 'opened checkout, never paid',
  'qualified-no-deal': 'qualified with a cut on file, no live deal',
  other: 'no fresh signal',
};

/** Default page size for the desk section. */
export const DEFAULT_DIAL_QUEUE_LIMIT = 25;

/**
 * One callable buyer, assembled by the caller from whatever rows it already
 * holds. Every field is optional except `id` — a source that cannot supply a
 * signal simply leaves it off rather than faking one.
 */
export interface DialCandidate {
  /** Consumers record id. Stable, and the tiebreak of last resort. */
  id: string;
  name?: string;
  state?: string;
  phone?: string;
  email?: string;
  /** Consumers.'Callback Requested At' */
  callbackRequestedAt?: string;
  /** Consumers.'Callback Handled At' */
  callbackHandledAt?: string;
  /** Consumers.'Callback Note' — the buyer's own words. */
  callbackNote?: string;
  /** Referrals.'Deposit Link Opened At' on this buyer's newest live deal. */
  depositLinkOpenedAt?: string;
  /** Referrals.'Deposit Paid At' — set means the checkout converted. */
  depositPaidAt?: string;
  /** Consumers.'Qualified At' */
  qualifiedAt?: string;
  /**
   * Whether Order Type resolves to a real cut. Computed by the caller with
   * lib/requalifyCampaign.orderTypeToCut so the "Half Cow" vs "Half" vs
   * "Not Sure" mess is decoded in exactly one place, not re-guessed here.
   */
  hasCutOnFile?: boolean;
  /** True when an open referral already exists for this buyer. */
  hasLiveDeal?: boolean;
  // ── Deal context for the desk card. Display only, never a ranking input. ──
  rancherName?: string;
  referralId?: string;
  cutLabel?: string;
  dealAmount?: number;
}

export interface RankedDialCandidate extends DialCandidate {
  tier: DialTier;
  tierRank: number;
  reason: string;
  /** Whole days since the signal that placed this row in its tier. */
  signalAgeDays: number | null;
}

// ── date helpers ───────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Parse to epoch ms, or null for blank / unparseable / non-string input. */
function ms(value: unknown): number | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// ── open-request predicate ─────────────────────────────────────────────────

/**
 * Is there an OPEN callback request on this row?
 *
 * Open means: a request was made, and it has not been handled SINCE. The
 * "since" is load-bearing. Both stamps are single-value dateTime fields, so a
 * buyer who asks again after Ben already called overwrites `Callback Requested
 * At` while `Callback Handled At` still holds the older call. A naive
 * `!handledAt` test would read that second ask as already-handled and drop the
 * hottest row in the business on the floor.
 *
 * FAILS TOWARD SHOWING: an unparseable `Callback Handled At` cannot be compared,
 * so the request is treated as open. Ben seeing a row twice costs a minute;
 * a buyer who raised their hand and got silence costs the sale.
 *
 * The API's duplicate guard and the desk's queue MUST both come through here —
 * two definitions of "open" is how you get a rate limiter that blocks a request
 * the desk never shows.
 */
export function hasOpenCallbackRequest(row: {
  callbackRequestedAt?: unknown;
  callbackHandledAt?: unknown;
}): boolean {
  const requested = ms(row?.callbackRequestedAt);
  if (requested == null) return false;
  const handledRaw = String(row?.callbackHandledAt ?? '').trim();
  if (!handledRaw) return true;
  const handled = ms(handledRaw);
  if (handled == null) return true; // unparseable → cannot prove it was handled
  return handled < requested;
}

// ── tiering ────────────────────────────────────────────────────────────────

/**
 * Which tier does this row belong to? First match wins, top down — a buyer who
 * asked for a call is a callback row even if they also have an unpaid checkout
 * open, because the ask is the stronger and more recent statement of intent.
 */
export function dialTierFor(row: DialCandidate): DialTier {
  if (hasOpenCallbackRequest(row)) return 'callback';
  if (ms(row.depositLinkOpenedAt) != null && ms(row.depositPaidAt) == null) {
    return 'deposit-opened';
  }
  if (ms(row.qualifiedAt) != null && row.hasCutOnFile && !row.hasLiveDeal) {
    return 'qualified-no-deal';
  }
  return 'other';
}

/**
 * The timestamp that put this row in its tier — the thing whose age the desk
 * should show. `other` rows fall back to `Qualified At` so an undifferentiated
 * row still carries some age rather than reading as brand new.
 */
export function dialSignalAt(row: DialCandidate, tier: DialTier): string {
  switch (tier) {
    case 'callback':
      return String(row.callbackRequestedAt ?? '');
    case 'deposit-opened':
      return String(row.depositLinkOpenedAt ?? '');
    case 'qualified-no-deal':
      return String(row.qualifiedAt ?? '');
    default:
      return String(row.qualifiedAt ?? '');
  }
}

/** Whole days between the tier signal and `now`. Null when undated. */
export function dialSignalAgeDays(row: DialCandidate, tier: DialTier, now: number): number | null {
  const at = ms(dialSignalAt(row, tier));
  if (at == null) return null;
  return Math.max(0, Math.floor((now - at) / DAY_MS));
}

/** Tier + reason + age, without sorting. Exported for per-row rendering. */
export function scoreDialCandidate(
  row: DialCandidate,
  now: number,
): { tier: DialTier; tierRank: number; reason: string; signalAgeDays: number | null } {
  const tier = dialTierFor(row);
  return {
    tier,
    tierRank: DIAL_TIER_RANK[tier],
    reason: DIAL_TIER_REASON[tier],
    signalAgeDays: dialSignalAgeDays(row, tier, now),
  };
}

// ── ranking ────────────────────────────────────────────────────────────────

export interface RankDialQueueOptions {
  /** Epoch ms. Passed in so every age in the queue is measured off one clock. */
  now: number;
  limit?: number;
}

/**
 * Rank every callable buyer into ONE list, best dial first.
 *
 * Total and deterministic: tier, then callable-before-uncallable, then the
 * tier's own time direction (callback oldest-first, everything else
 * newest-first), then record id. Two identical rows never swap places between
 * two renders of the same desk.
 */
export function rankDialQueue(
  rows: DialCandidate[],
  { now, limit = DEFAULT_DIAL_QUEUE_LIMIT }: RankDialQueueOptions,
): RankedDialCandidate[] {
  const ranked: RankedDialCandidate[] = (rows || []).map((r) => ({
    ...r,
    ...scoreDialCandidate(r, now),
  }));

  ranked.sort((a, b) => {
    // 1. tier
    if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;

    // 2. a row we can dial outranks one we can only email
    const aPhone = String(a.phone ?? '').trim() ? 1 : 0;
    const bPhone = String(b.phone ?? '').trim() ? 1 : 0;
    if (aPhone !== bPhone) return bPhone - aPhone;

    // 3. the tier's own time direction. Undated rows sink either way — no
    //    timestamp means no evidence of heat.
    const at = ms(dialSignalAt(a, a.tier));
    const bt = ms(dialSignalAt(b, b.tier));
    if (at == null && bt != null) return 1;
    if (bt == null && at != null) return -1;
    if (at != null && bt != null && at !== bt) {
      return a.tier === 'callback' ? at - bt : bt - at;
    }

    // 4. stable
    return a.id.localeCompare(b.id);
  });

  return ranked.slice(0, Math.max(0, limit));
}
