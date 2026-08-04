/**
 * Commission-owed selection + pay-path helpers — the ONE place that decides
 * which referrals a rancher actually owes post-close commission on, and where
 * the "Pay" action for each of them points.
 *
 * BORN FROM A REAL TICKET (2026-08-03): a rancher had 2 unpaid commission
 * invoices ($156.91 total) and asked "I never received an email to pay that.
 * Is there a way to pay through the dashboard?" Row-level forensics showed:
 *   - every commission email HAD been sent (Email Sends status='sent', no
 *     bounces) — but none carried a payment link. Both referrals closed
 *     OFF-RAIL before the RAIL-PER-ROW fix, so `createCommissionInvoice`
 *     never fired and `Stripe Invoice URL` was never stamped → the instant
 *     emails rendered the "reply and I'll resend it" fallback, and the
 *     monthly statement's Pay Now button was gated on the unset
 *     COMMISSION_PAYMENT_URL env → also fell back to a reply loop.
 *   - the dashboard had NO commission surface at all.
 *
 * THE DOCTRINE (matches lib/commission.ts RAIL-PER-ROW):
 *   - Owing is decided per REFERRAL, never per rancher. A tier_v2 (Connect)
 *     rancher with off-rail closes still owes; a legacy-model rancher whose
 *     row somehow carries Deposit Paid At owes nothing on that row (the fee
 *     was skimmed at deposit via application_fee_amount — showing it as owed
 *     would contradict the buyer-pays-on-top money model).
 *   - Commission Due of 0 is NOT owed (locked 0% Operator-tier rate is
 *     valid) — a zero row must never render a Pay button.
 *   - The pay path is ALWAYS a Stripe hosted invoice. When the close-time
 *     invoice exists, the stamped `Stripe Invoice URL` field on the Referral
 *     is the link. When it doesn't (the exact trap this ticket's rancher was
 *     in), the dashboard mints it lazily via
 *     POST /api/rancher/referrals/[id]/commission-invoice — idempotent per
 *     referral (Stripe idempotencyKey `invoice-${referralId}`).
 *
 * Pure functions only — no Airtable, no Stripe, no env reads except the
 * explicit siteUrl argument. Everything here is unit-tested in
 * lib/commissionOwed.test.ts.
 */

import { referralRail } from '@/lib/commission';

export interface CommissionOwedRow {
  referralId: string;
  buyerName: string;
  orderType: string;
  closedAt: string | null;
  /** Whole days since Closed At (0 when Closed At missing/unparseable). */
  ageDays: number;
  saleAmount: number;
  commissionDue: number;
  /** Stamped hosted-invoice URL — null means "mint lazily via the endpoint". */
  stripeInvoiceUrl: string | null;
}

/** Ownership belt — identical semantics to every rancher-scoped reader:
 * the row is the rancher's if EITHER link field contains their record id. */
export function referralBelongsToRancher(ref: any, rancherId: string): boolean {
  for (const field of ['Rancher', 'Suggested Rancher']) {
    const ids = ref?.[field];
    if (Array.isArray(ids) && ids.includes(rancherId)) return true;
  }
  return false;
}

function ageDaysFrom(closedAt: unknown, now: Date): number {
  const t = new Date(String(closedAt || '')).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / (24 * 60 * 60 * 1000)));
}

/**
 * Does this single referral row represent commission the rancher still owes?
 * Closed Won + not Commission Paid + legacy (invoice) rail + positive due.
 */
export function isCommissionOwedRow(ref: any): boolean {
  if (String(ref?.['Status'] || '') !== 'Closed Won') return false;
  if (ref?.['Commission Paid']) return false;
  // Deposit-rail rows had the fee skimmed at deposit — nothing owed, ever.
  if (referralRail(ref) === 'tier_v2') return false;
  return (Number(ref?.['Commission Due']) || 0) > 0;
}

/**
 * The dashboard "Commission owed" block's row source. Oldest first, so the
 * most overdue invoice is the first thing the rancher sees.
 */
export function selectCommissionOwedRows(
  referrals: any[],
  rancherId: string,
  now: Date = new Date(),
): CommissionOwedRow[] {
  return (referrals || [])
    .filter((r) => referralBelongsToRancher(r, rancherId) && isCommissionOwedRow(r))
    .map((r) => ({
      referralId: String(r.id || ''),
      buyerName: String(r['Buyer Name'] || 'Buyer'),
      orderType: String(r['Order Type'] || 'Beef order'),
      closedAt: r['Closed At'] || null,
      ageDays: ageDaysFrom(r['Closed At'], now),
      saleAmount: Number(r['Sale Amount']) || 0,
      commissionDue: Number(r['Commission Due']) || 0,
      stripeInvoiceUrl: String(r['Stripe Invoice URL'] || '').trim() || null,
    }))
    .sort((a, b) => new Date(a.closedAt || 0).getTime() - new Date(b.closedAt || 0).getTime());
}

export function totalCommissionOwed(rows: Pick<CommissionOwedRow, 'commissionDue'>[]): number {
  return Math.round(rows.reduce((sum, r) => sum + (Number(r.commissionDue) || 0), 0) * 100) / 100;
}

/**
 * Gate for the lazy-mint endpoint (POST .../commission-invoice) — refuses
 * anything that must never turn into a Stripe invoice. `existingUrl` is the
 * idempotent short-circuit: an already-stamped invoice is returned, never
 * re-minted.
 */
export function commissionInvoiceEligibility(
  ref: any,
  rancherId: string,
):
  | { eligible: true; existingUrl: string | null }
  | { eligible: false; reason: string } {
  if (!ref) return { eligible: false, reason: 'referral-not-found' };
  if (!referralBelongsToRancher(ref, rancherId)) {
    return { eligible: false, reason: 'not-your-referral' };
  }
  if (String(ref['Status'] || '') !== 'Closed Won') {
    return { eligible: false, reason: 'not-closed-won' };
  }
  if (ref['Commission Paid']) return { eligible: false, reason: 'already-paid' };
  if (referralRail(ref) === 'tier_v2') {
    // Buyer already paid the fee at deposit — an invoice here double-bills.
    return { eligible: false, reason: 'deposit-rail-nothing-owed' };
  }
  if ((Number(ref['Commission Due']) || 0) <= 0) {
    return { eligible: false, reason: 'nothing-due' };
  }
  return {
    eligible: true,
    existingUrl: String(ref['Stripe Invoice URL'] || '').trim() || null,
  };
}

/**
 * Which unpaid invoice-eligible rows still need a Stripe invoice minted?
 * Used by the monthly cron to close the gap this ticket exposed: a statement
 * about money owed must never go out without a payable hosted invoice
 * behind every line. Checks BOTH stamp fields — either one present means a
 * Stripe invoice already exists for the row.
 */
export function rowsNeedingInvoiceMint(rows: any[]): any[] {
  return (rows || []).filter(
    (r) =>
      isCommissionOwedRow(r) &&
      !String(r?.['Stripe Invoice ID'] || '').trim() &&
      !String(r?.['Stripe Invoice URL'] || '').trim(),
  );
}

/**
 * The ONE payment CTA every commission email must carry — there is no
 * "reply and I'll send a link" mode anymore. Hosted Stripe invoice when we
 * have it; otherwise the rancher dashboard billing page, which lists every
 * open invoice and can mint the hosted page on demand.
 */
export function commissionPayCta(args: {
  stripeInvoiceUrl?: string | null;
  siteUrl: string;
}): { kind: 'hosted' | 'dashboard'; url: string } {
  const hosted = String(args.stripeInvoiceUrl || '').trim();
  if (hosted) return { kind: 'hosted', url: hosted };
  return { kind: 'dashboard', url: `${args.siteUrl.replace(/\/$/, '')}/rancher/billing` };
}
