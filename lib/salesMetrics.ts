// lib/salesMetrics.ts
//
// B4: the founder's headline sales metrics. Pure + side-effect-free +
// independently unit-tested (mirrors lib/routingPriority.ts), so the admin
// analytics route can derive Sales / Revenue / Commission / Conversion from
// raw Airtable rows without any I/O in the math.
//
// Two sale ledgers exist:
//   • LEGACY  — Inquiries rows with Status 'Sale Completed' (pre-tier_v2 /
//     manual closes). Kept visible as legacyInquirySales so nothing silently
//     disappears, but this table stops moving once traffic is on the funnel.
//   • LIVE    — Referrals rows. 'Deposit Paid At' set = deposit money landed;
//     Status 'Closed Won' = the sale completed. These are STAGES of the same
//     deal, not two deals — a referral that paid a deposit and later closed
//     is ONE sale, counted once.
//
// Airtable field names are load-bearing — they must match the base exactly.

type Row = Record<string, any>;

// Airtable numerics arrive as number OR string depending on field type.
const num = (v: any): number => {
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function isLegacyInquirySale(inquiry: Row): boolean {
  return inquiry['Status'] === 'Sale Completed';
}

export function hasDepositPaid(referral: Row): boolean {
  return !!referral['Deposit Paid At'];
}

export function isClosedWon(referral: Row): boolean {
  return String(referral['Status'] || '') === 'Closed Won';
}

// A referral is a real sale once the deposit landed OR it reached Closed Won.
export function isReferralSale(referral: Row): boolean {
  return hasDepositPaid(referral) || isClosedWon(referral);
}

// Best-available sale value for a referral. `||` (not `??`) on purpose:
// an explicit 0 falls through to the next field, matching how the route
// has always read these amounts.
export function referralSaleValue(referral: Row): number {
  return num(
    referral['Total Sale Amount'] || referral['Sale Amount'] || referral['Deposit Amount'] || 0,
  );
}

export interface SalesMetrics {
  // Deposit-funnel truth (tier_v2 Referrals).
  depositsPaid: number; // referrals with 'Deposit Paid At' set — money landed
  salesClosed: number; // referrals with Status 'Closed Won' — sale completed
  referralSales: number; // DISTINCT referrals that are a sale (deposit paid or closed won)
  referralRevenue: number;
  referralCommission: number;
  // Legacy Inquiries 'Sale Completed' path — kept visible, clearly named.
  legacyInquirySales: number;
  legacyInquiryRevenue: number;
  legacyInquiryCommission: number;
  // Headline totals: each sale counted exactly once across both ledgers.
  totalSales: number;
  totalRevenue: number;
  totalCommission: number;
  // Sales per funnel LEAD (consumers) — the meaningful ad-funnel rate.
  conversionRate: number;
}

export function deriveSalesMetrics(
  inquiries: Row[],
  referrals: Row[],
  consumersCount: number,
): SalesMetrics {
  const legacySales = inquiries.filter(isLegacyInquirySale);
  const legacyInquiryRevenue = legacySales.reduce((s, i) => s + num(i['Sale Amount']), 0);
  const legacyInquiryCommission = legacySales.reduce((s, i) => s + num(i['Commission Amount']), 0);

  const saleReferrals = referrals.filter(isReferralSale);
  const referralRevenue = saleReferrals.reduce((s, r) => s + referralSaleValue(r), 0);
  const referralCommission = saleReferrals.reduce((s, r) => s + num(r['Commission Due']), 0);

  // Closed Won referrals are a SUBSET of saleReferrals (isReferralSale is
  // deposit-paid OR closed-won), so their money is already inside
  // referralRevenue/-Commission. Do NOT add a closed-won slice on top —
  // that re-add is exactly the double-count this module exists to prevent.
  const totalSales = legacySales.length + saleReferrals.length;
  const totalRevenue = legacyInquiryRevenue + referralRevenue;
  const totalCommission = legacyInquiryCommission + referralCommission;

  return {
    depositsPaid: referrals.filter(hasDepositPaid).length,
    salesClosed: referrals.filter(isClosedWon).length,
    referralSales: saleReferrals.length,
    referralRevenue,
    referralCommission,
    legacyInquirySales: legacySales.length,
    legacyInquiryRevenue,
    legacyInquiryCommission,
    totalSales,
    totalRevenue,
    totalCommission,
    conversionRate: consumersCount > 0 ? totalSales / consumersCount : 0,
  };
}
