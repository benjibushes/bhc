// Pure commission math shared by the admin dashboard surfaces.
//
// The "Unpaid Commission" tile on /admin previously summed only THIS-MONTH
// Closed Won referrals while being labeled "Unpaid Commission", under-reporting
// money actually owed. This helper is the single source of truth: all-time
// unpaid commission = sum of Commission Due across every Closed Won referral
// whose Commission Paid is not strictly true. Mirrors command-center's
// commissionUnpaid so the two surfaces never disagree.
//
// RAIL-AWARE (money-model truth, 2026-07-24). `Commission Due` / `Commission
// Paid` belong to ONE rail: the deprecated "rancher owes BHC 10%, invoiced
// monthly after close" model. On the live model (docs/BUSINESS-MODEL.md ⭐) the
// 10% is ADDED to the buyer and captured atomically at deposit via the Stripe
// Connect application_fee — nothing is owed, so nothing is receivable. The
// RANCHER dashboard already filtered on this (app/api/rancher/dashboard,
// referralRail(r) === 'legacy'); the three ADMIN tiles did not, so one Connect
// close would read as an outstanding receivable to the founder and as settled
// to the rancher. Every helper here is legacy-rail only, and the Connect rail
// gets its own figure from Payments (computeConnectFeeCaptured) instead of
// being folded into a single misleading total.

import { referralRail } from './commission';

export interface CommissionReferral {
  Status?: string;
  'Commission Due'?: number | string | null;
  'Commission Paid'?: boolean | null;
  /** Rail discriminator — stamped ⇒ the fee was skimmed at deposit (Connect). */
  'Deposit Paid At'?: string | null;
}

/** Numeric coercion that treats null/undefined/NaN as 0 (Airtable empties). */
function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Round to cents. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Closed Won referrals riding the LEGACY (invoice-after-close) rail — the only
 * rows for which `Commission Due` means anything. Uses the canonical per-row
 * discriminator from lib/commission.ts; never per-rancher.
 */
export function legacyClosedWon<T extends CommissionReferral>(referrals: T[]): T[] {
  return referrals.filter((r) => r.Status === 'Closed Won' && referralRail(r) === 'legacy');
}

/**
 * All-time LEGACY commission receivable still outstanding — every Closed Won
 * legacy-rail referral whose `Commission Paid` is not strictly true.
 * Connect-rail closes are excluded: their fee was already taken at deposit.
 * Result is rounded to cents.
 */
export function computeUnpaidCommission(referrals: CommissionReferral[]): number {
  const total = legacyClosedWon(referrals)
    .filter((r) => r['Commission Paid'] !== true)
    .reduce((sum, r) => sum + toNum(r['Commission Due']), 0);
  return round2(total);
}

/**
 * All-time LEGACY commission billed (paid + unpaid) across Closed Won rows.
 * A receivable-book number, NOT total BHC revenue — Connect-rail fee revenue
 * lives in Payments, not Referrals. Pair it with computeConnectFeeCaptured so
 * the operator sees both rails.
 */
export function computeLegacyCommissionEarned(referrals: CommissionReferral[]): number {
  return round2(
    legacyClosedWon(referrals).reduce((sum, r) => sum + toNum(r['Commission Due']), 0),
  );
}

export interface ConnectFeePayment {
  Status?: string | null;
  'Platform Fee Cents'?: number | string | null;
}

/**
 * Connect-rail fee revenue actually captured, in DOLLARS.
 *
 * This is the money the deprecated Referrals commission columns know nothing
 * about: the marketplace fee added on top of the buyer's price and taken
 * atomically at deposit as the Stripe `application_fee`. It is persisted on the
 * Payments row as `Platform Fee Cents` — exact Airtable field name, verified
 * against the live base schema and matching app/api/admin/payments/data and
 * lib/contracts/payments.ts.
 *
 * Only `Status === 'succeeded'` rows count — same definition as the "Deposits
 * collected" tile. pending / abandoned / failed / requires_webhook_replay never
 * moved money, and a full refund flips the row to 'refunded' so it drops out.
 */
export function computeConnectFeeCaptured(payments: ConnectFeePayment[]): number {
  const cents = payments
    .filter((p) => String(p.Status ?? '') === 'succeeded')
    .reduce((sum, p) => sum + toNum(p['Platform Fee Cents']), 0);
  return round2(cents / 100);
}

/** How many succeeded payments actually carry a non-zero Connect fee. */
export function countConnectFeePayments(payments: ConnectFeePayment[]): number {
  return payments.filter(
    (p) => String(p.Status ?? '') === 'succeeded' && toNum(p['Platform Fee Cents']) > 0,
  ).length;
}
