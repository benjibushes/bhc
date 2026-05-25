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

export async function markDepositRefunded(stripePaymentIntentId: string): Promise<void> {
  const escaped = stripePaymentIntentId.replace(/"/g, '\\"');
  const existing: any[] = await getAllRecords(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`
  );
  if (existing.length === 0) return;
  const payment = existing[0];
  if (payment['Status'] === 'refunded') return;
  await updateRecord(PAYMENTS_TABLE, payment.id, {
    'Status': 'refunded',
    'Refunded At': new Date().toISOString(),
  });
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
