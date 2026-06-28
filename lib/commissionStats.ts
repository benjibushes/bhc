// Pure commission math shared by the admin dashboard surfaces.
//
// The "Unpaid Commission" tile on /admin previously summed only THIS-MONTH
// Closed Won referrals while being labeled "Unpaid Commission", under-reporting
// money actually owed. This helper is the single source of truth: all-time
// unpaid commission = sum of Commission Due across every Closed Won referral
// whose Commission Paid is not strictly true. Mirrors command-center's
// commissionUnpaid so the two surfaces never disagree.

export interface CommissionReferral {
  Status?: string;
  'Commission Due'?: number | string | null;
  'Commission Paid'?: boolean | null;
}

/** Numeric coercion that treats null/undefined/NaN as 0 (Airtable empties). */
function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * All-time unpaid commission across every Closed Won referral.
 * A referral counts as unpaid unless `Commission Paid === true`.
 * Result is rounded to cents.
 */
export function computeUnpaidCommission(referrals: CommissionReferral[]): number {
  const total = referrals
    .filter((r) => r.Status === 'Closed Won' && r['Commission Paid'] !== true)
    .reduce((sum, r) => sum + toNum(r['Commission Due']), 0);
  return Math.round(total * 100) / 100;
}
