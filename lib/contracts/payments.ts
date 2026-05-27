// Stripe Connect Express — platform takes 100% deposit, holds it, pays rancher
// 90% on fulfillment confirm, retains 10% as commission + monthly platform fee.
//
// Two Airtable tables back this contract:
//   - Payments: every deposit attempt (pending/succeeded/refunded/failed)
//   - Payouts:  every release to a rancher's connected account
// Idempotency is keyed on Stripe Payment Intent ID + Stripe Transfer ID so
// webhook retries never double-process.

import { createRecord, updateRecord, getAllRecords } from '@/lib/airtable';

export type PaymentStatus = 'pending' | 'succeeded' | 'refunded' | 'failed';
export type PayoutStatus = 'pending' | 'paid' | 'failed';

export const PAYMENTS_TABLE = 'Payments';
export const PAYOUTS_TABLE = 'Payouts';

export interface CreateDepositInput {
  referralId: string;
  buyerId: string;
  rancherId: string;
  tier: 'Pasture' | 'Ranch' | 'Operator';  // NEW — tier_v2 only
  amountCents: number;
  platformFeeCents: number;  // NEW — BHC's cut of the deposit
  stripePaymentIntentId: string;
}

export async function recordDeposit(input: CreateDepositInput): Promise<{ id: string }> {
  const created: any = await createRecord(PAYMENTS_TABLE, {
    'Referral': [input.referralId],
    'Buyer': [input.buyerId],
    'Rancher': [input.rancherId],
    'Tier': input.tier,
    'Amount Cents': input.amountCents,
    'Platform Fee Cents': input.platformFeeCents,
    'Stripe Payment Intent Id': input.stripePaymentIntentId,
    'Status': 'pending',
    'Created At': new Date().toISOString(),
  });
  return { id: created.id };
}

export async function markDepositSucceeded(stripePaymentIntentId: string): Promise<void> {
  const escaped = stripePaymentIntentId.replace(/"/g, '\\"');
  const existing: any[] = await getAllRecords(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`
  );
  if (existing.length === 0) return;
  const payment = existing[0];
  // Idempotency: already-succeeded payments are a no-op on webhook retry.
  if (payment['Status'] === 'succeeded') return;
  await updateRecord(PAYMENTS_TABLE, payment.id, {
    'Status': 'succeeded',
    'Captured At': new Date().toISOString(),
  });
}

export interface MarkDepositRefundedOpts {
  reason?: string;
  refundedAmountCents?: number; // partial refund support — P0 audit fix (C-6)
  // Partial flag — if true, Payments row keeps Status='succeeded' so a follow-up
  // refund can still target it. Default false (full refund flips to 'refunded').
  partial?: boolean;
}

export async function markDepositRefunded(
  stripePaymentIntentId: string,
  opts: MarkDepositRefundedOpts = {},
): Promise<{ flipped: boolean }> {
  const escaped = stripePaymentIntentId.replace(/"/g, '\\"');
  const existing: any[] = await getAllRecords(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`
  );
  if (existing.length === 0) return { flipped: false };
  const payment = existing[0];
  // For non-partial refunds, idempotently no-op on re-call.
  if (!opts.partial && payment['Status'] === 'refunded') return { flipped: false };

  // Best-effort field writes — Refund Reason + Refunded Amount Cents may not
  // exist in older Airtable schemas. Catch the typed-field error and retry
  // without them.
  const fields: Record<string, any> = {
    'Refunded At': new Date().toISOString(),
  };
  if (!opts.partial) fields['Status'] = 'refunded';
  if (opts.reason) fields['Refund Reason'] = opts.reason;
  if (typeof opts.refundedAmountCents === 'number') {
    fields['Refunded Amount Cents'] = opts.refundedAmountCents;
  }

  try {
    await updateRecord(PAYMENTS_TABLE, payment.id, fields);
  } catch (e: any) {
    // Fallback: strip the new fields and retry. Old Airtable schemas without
    // Refund Reason / Refunded Amount Cents will reject those keys outright.
    console.warn('[markDepositRefunded] schema fallback (retrying without new fields):', e?.message);
    const fallback: Record<string, any> = { 'Refunded At': fields['Refunded At'] };
    if (!opts.partial) fallback['Status'] = 'refunded';
    await updateRecord(PAYMENTS_TABLE, payment.id, fallback);
  }
  return { flipped: true };
}

export interface MarkDepositDisputedInput {
  stripePaymentIntentId: string;
  disputeStatus: string;          // Stripe dispute.status (warning_needs_response, needs_response, under_review, lost, won, etc)
  disputeAmountCents?: number;    // dispute.amount
  disputeReason?: string;         // dispute.reason (fraudulent, product_not_received, etc)
}

/**
 * Stripe dispute mutation contract. Wraps the Payments row dispute write so
 * stripe + stripe-connect webhook handlers share a single surface. Pre-H4 the
 * webhook handlers called updateRecord(PAYMENTS_TABLE, ...) directly — the
 * boundary check tolerated it (it's the same table) but the inconsistency
 * meant any future schema change (e.g. dispute-side audit field) had to be
 * patched in two webhook files instead of one contract.
 *
 * Returns { found: false } when no Payments row matches the PI (founder
 * lifetime + brand listing disputes don't write here — handler still fires
 * its own Telegram + audit).
 */
export async function markDepositDisputed(
  input: MarkDepositDisputedInput,
): Promise<{ found: boolean; recordId?: string }> {
  const escaped = input.stripePaymentIntentId.replace(/"/g, '\\"');
  const rows: any[] = await getAllRecords(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`,
  );
  if (rows.length === 0) {
    console.warn(`[markDepositDisputed] dispute event for unknown PI: ${input.stripePaymentIntentId}`);
    return { found: false };
  }
  const recordId: string = rows[0].id;
  await updateRecord(PAYMENTS_TABLE, recordId, {
    'Dispute Status': input.disputeStatus,
    'Dispute Amount': (input.disputeAmountCents || 0) / 100,
    'Dispute Reason': input.disputeReason || '',
    'Dispute Updated At': new Date().toISOString(),
  });
  return { found: true, recordId };
}

export interface ReleasePayoutInput {
  paymentId: string;
  rancherId: string;
  stripeTransferId: string;
  amountCents: number; // 90% of deposit, computed by caller
  reason: 'fulfillment_confirmed' | 'dispute_resolved';
}

export async function releasePayout(input: ReleasePayoutInput): Promise<{ id: string }> {
  // Idempotency: skip if a Payout row already exists for this transfer id.
  const safeTransferId = input.stripeTransferId.replace(/"/g, '\\"');
  const existing: any[] = await getAllRecords(
    PAYOUTS_TABLE,
    `{Stripe Transfer Id} = "${safeTransferId}"`
  );
  if (existing.length > 0) return { id: existing[0].id };

  const created: any = await createRecord(PAYOUTS_TABLE, {
    'Payment': [input.paymentId],
    'Rancher': [input.rancherId],
    'Stripe Transfer Id': input.stripeTransferId,
    'Amount Cents': input.amountCents,
    'Status': 'paid',
    'Released At': new Date().toISOString(),
    'Reason': input.reason,
  });
  return { id: created.id };
}
