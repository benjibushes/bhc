/**
 * Rancher capacity field aliasing.
 *
 * THE BUG WE'RE PREVENTING: The Airtable schema has a field named
 * `Max Active Referalls` (typo: missing one L). Code reads this typo'd name
 * in 20+ places. If anyone "fixes" the spelling in Airtable to
 * `Max Active Referrals`, every code reader returns `undefined` and
 * silently falls back to a default of 5 — meaning every rancher's capacity
 * silently collapses to 5 the moment someone tries to clean up the schema.
 *
 * This helper reads from BOTH spellings. Whichever has a non-null value wins.
 * Writes still go through the existing typo'd field name (preserving compat),
 * but reads are defended.
 */

const DEFAULT_MAX = 5;

export function getMaxActiveReferrals(rancher: any): number {
  if (!rancher) return DEFAULT_MAX;
  // Try corrected spelling first (futures-proof). Fall back to typo. Default 5.
  const correct = rancher['Max Active Referrals'];
  if (correct !== undefined && correct !== null && correct !== '') return Number(correct);
  // eslint-disable-next-line dot-notation
  const typo = rancher['Max Active Referalls'];
  if (typo !== undefined && typo !== null && typo !== '') return Number(typo);
  return DEFAULT_MAX;
}

/**
 * Returns the field name to use when WRITING to Airtable. Currently still
 * the typo'd name, since the schema field is `Max Active Referalls`. If/when
 * the schema is corrected, change this constant in one place.
 */
export const MAX_ACTIVE_REFERRALS_FIELD = 'Max Active Referalls';
