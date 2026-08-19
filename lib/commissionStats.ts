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

import { referralRail, isBrokerReferralRow } from './commission';
import { TERMINAL_PRODUCT_ORDER_STATUSES } from './productOrderStatus';

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
 *
 * BROKER BELT (2026-08-19). `referralRail` discriminates on `Deposit Paid At`,
 * which a broker row does not carry until its deposit settles — and a broker
 * close that was stamped by hand may never carry one at all. Such a row read
 * as 'legacy' here, so a `Commission Due` typed onto it was added to a total
 * that ALREADY contains that same sale as a broker deposit BHC kept in full:
 * the one sale, billed twice. `isBrokerReferralRow` keys on `Match Type`,
 * stamped at referral CREATION, so it holds in exactly the window where
 * `Deposit Paid At` does not. The same belt was already applied by
 * lib/commissionOwed.isCommissionOwedRow and lib/commission's
 * partitionUnpaidByRail + shouldWriteLegacyCommissionDue — this was the one
 * legacy-rail selector missing it.
 */
export function legacyClosedWon<T extends CommissionReferral>(referrals: T[]): T[] {
  return referrals.filter(
    (r) => r.Status === 'Closed Won' && !isBrokerReferralRow(r) && referralRail(r) === 'legacy',
  );
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

// ── Range-aware variants (Wave 1B cockpit) ─────────────────────────────────
//
// SUPERSEDED for "what did BHC earn" (2026-08-19). /admin/today used to add
// these two together and call the result "Earned", which omitted the legacy
// rail — 84% of lifetime revenue. Both admin screens now read
// lib/bhcRevenue.computeBhcRevenue, which spans EVERY measurable rail and
// names them. These stay as single-rail helpers (and are unit-tested as such);
// do NOT build a sixth "total revenue" out of them.
//
// The /admin/today cockpit needs "earned TODAY" and "earned MTD", which the
// all-time helpers above cannot answer. Range membership is decided by the
// caller via a predicate over the row's capture timestamp so the timezone
// question (Ben's calendar day is America/Denver, not UTC) stays in exactly
// one place — the caller pairs these with lib/followUpQueue.operatorToday.

export interface RangedConnectFeePayment extends ConnectFeePayment {
  /** Stamped by markDepositSucceeded at settlement (lib/contracts/payments). */
  'Captured At'?: string | null;
  /** Row-creation stamp — fallback for pre-Captured-At legacy rows. */
  'Created At'?: string | null;
}

/**
 * Connect fees captured within a caller-defined range, in DOLLARS.
 * Same succeeded-only definition as computeConnectFeeCaptured; the range is
 * tested against `Captured At` (when the money actually moved), falling back
 * to `Created At` for legacy rows that predate the Captured At stamp.
 */
export function computeConnectFeeCapturedInRange(
  payments: RangedConnectFeePayment[],
  inRange: (isoTimestamp: string) => boolean,
): number {
  const cents = payments
    .filter((p) => String(p.Status ?? '') === 'succeeded')
    .filter((p) => {
      const ts = String(p['Captured At'] || p['Created At'] || '');
      return !!ts && inRange(ts);
    })
    .reduce((sum, p) => sum + toNum(p['Platform Fee Cents']), 0);
  return round2(cents / 100);
}

export interface ProductMarginOrder {
  /** Rancher Orders — dollars kept by BHC on a shop sale (lib/productSettlement). */
  'BHC Margin'?: number | string | null;
  'Ordered At'?: string | null;
  /** New | Shipped | Refunded | Cancelled — terminal rows earned nothing. */
  'Status'?: unknown;
}

/**
 * A refunded / cancelled shop order is NOT earned revenue (2026-08-19).
 *
 * The refund path flips Status and stamps 'Refunded At' but deliberately
 * leaves 'BHC Margin' intact — the field records what the sale WAS. Both
 * helpers below used to sum every row, so money that went back out stayed in
 * the founder's "earned" figure forever. The Connect rail was never exposed to
 * this because its sums are succeeded-only; this is the same rule for the shop
 * rail, sharing the one terminal set (lib/productOrderStatus).
 */
function earnedProductOrders<T extends ProductMarginOrder>(orders: T[]): T[] {
  return orders.filter((o) => {
    const raw = (o as any)['Status'];
    const status =
      raw && typeof raw === 'object' && 'name' in raw ? String((raw as any).name ?? '') : String(raw ?? '');
    return !TERMINAL_PRODUCT_ORDER_STATUSES.has(status);
  });
}

/**
 * Shop-rail margin BHC keeps, in DOLLARS — all rows. Extracted from
 * command-center's inline reduce so the cockpit and command-center share one
 * definition of the product-rail money.
 */
export function computeProductMargin(orders: ProductMarginOrder[]): number {
  return round2(earnedProductOrders(orders).reduce((sum, o) => sum + toNum(o['BHC Margin']), 0));
}

/** Shop-rail margin within a caller-defined range (tested on `Ordered At`). */
export function computeProductMarginInRange(
  orders: ProductMarginOrder[],
  inRange: (isoTimestamp: string) => boolean,
): number {
  return round2(
    earnedProductOrders(orders)
      .filter((o) => {
        const ts = String(o['Ordered At'] || '');
        return !!ts && inRange(ts);
      })
      .reduce((sum, o) => sum + toNum(o['BHC Margin']), 0),
  );
}
