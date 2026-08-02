// lib/beefWeights.ts
//
// ONE source of truth for the share-size numbers quoted in buyer emails.
//
// Wave 2 (GTM plan 2.8): three emails quoted three different tables —
// "Quarter ≈ 90 lbs" in the incomplete-profile ask, "~85 lbs" in the
// post-purchase welcome, "~85 lbs, $1,500–2,000" in the loss-recovery
// downsell. A buyer who received two of them was told two different
// truths about the same product. The loss-recovery comment already
// declared ~85 lbs "the REAL numbers", so that scale wins everywhere.
//
// Every buyer-facing weight/freezer figure should come from here. Do not
// inline a new table in an email template.

export type ShareTier = 'quarter' | 'half' | 'whole';

export interface ShareWeightInfo {
  /** Approximate take-home weight label, e.g. "~85 lbs". */
  lbs: string;
  /** Approximate freezer space label, e.g. "~3–4 cu ft". */
  cuFt: string;
}

export const SHARE_WEIGHTS: Readonly<Record<ShareTier, ShareWeightInfo>> = {
  quarter: { lbs: '~85 lbs', cuFt: '~3–4 cu ft' },
  half: { lbs: '~170 lbs', cuFt: '~6–8 cu ft' },
  whole: { lbs: '~340 lbs', cuFt: '~12–16 cu ft' },
} as const;

/** Range labels for copy that spans all tiers ("85–340 lbs"). */
export const SHARE_WEIGHT_RANGE_LBS = '85–340 lbs';
export const SHARE_WEIGHT_RANGE_CU_FT = '3–16 cu ft';

/**
 * Parse an Order Type-ish string ("Quarter Beef", "half cow", …) to a tier.
 * Returns null when no tier word is present.
 */
export function shareTierFromOrderType(orderType: unknown): ShareTier | null {
  const raw = String(orderType || '').toLowerCase();
  if (raw.includes('quarter')) return 'quarter';
  if (raw.includes('half')) return 'half';
  if (raw.includes('whole')) return 'whole';
  return null;
}
