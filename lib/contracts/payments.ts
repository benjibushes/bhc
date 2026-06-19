// Stripe Connect Express — platform takes 100% deposit, holds it, pays rancher
// 90% on fulfillment confirm, retains 10% as commission + monthly platform fee.
//
// Two Airtable tables back this contract:
//   - Payments: every deposit attempt (pending/succeeded/refunded/failed)
//   - Payouts:  every release to a rancher's connected account
// Idempotency is keyed on Stripe Payment Intent ID + Stripe Transfer ID so
// webhook retries never double-process.

import { createRecord, updateRecord, getAllRecords, getRecordById, TABLES } from '@/lib/airtable';
import { decrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import { logAuditEntry } from '@/lib/auditLog';
import { sendTelegramUpdate } from '@/lib/telegram';

export type PaymentStatus = 'pending' | 'succeeded' | 'refunded' | 'failed' | 'abandoned' | 'requires_webhook_replay';
export type PayoutStatus = 'pending' | 'paid' | 'failed';

export const PAYMENTS_TABLE = 'Payments';
export const PAYOUTS_TABLE = 'Payouts';

export interface CreateDepositInput {
  referralId: string;
  buyerId: string;
  rancherId: string;
  tier: 'Pasture' | 'Ranch' | 'Operator' | 'Legacy Connect';  // tier_v2 + hybrid (legacy_connect)
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

// Returns true if this call flipped the row to succeeded (or there is no row to
// flip — not a duplicate); false if the row was ALREADY succeeded (a repeat
// delivery). Callers use the false return as a cross-webhook idempotency guard
// to skip non-idempotent side effects (funnel/email/Telegram) on the second
// delivery of the same PaymentIntent. Backward-compatible: callers that ignore
// the return value keep working.
export async function markDepositSucceeded(stripePaymentIntentId: string): Promise<boolean> {
  const escaped = stripePaymentIntentId.replace(/"/g, '\\"');
  const existing: any[] = await getAllRecords(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`
  );
  if (existing.length === 0) return true;
  const payment = existing[0];
  // Idempotency: already-succeeded payments are a no-op on webhook retry.
  if (payment['Status'] === 'succeeded') return false;
  await updateRecord(PAYMENTS_TABLE, payment.id, {
    'Status': 'succeeded',
    'Captured At': new Date().toISOString(),
  });
  return true;
}

/**
 * Orphan-reaper contract: flip a pending Payments row to 'abandoned' when the
 * Stripe PaymentIntent has expired (canceled / requires_payment_method) without
 * the buyer ever completing checkout. Idempotent — re-running on an already-
 * abandoned row is a no-op so the cron is safe to run on overlap.
 *
 * Deliberately DOES NOT touch the linked Referral.Status. Orphan ≠ Lost — the
 * buyer can still re-engage later (different rancher, new deposit). Setting
 * the row to abandoned just stops the funnel from treating this PaymentIntent
 * as "still alive" indefinitely.
 *
 * Returns { found: false } if no Payments row matches the PI (defensive — the
 * caller should have already filtered to pending rows, but webhook races could
 * produce a mismatched row).
 */
export async function markDepositAbandoned(
  stripePaymentIntentId: string,
  opts: { stripeStatus?: string } = {},
): Promise<{ found: boolean; flipped: boolean }> {
  const escaped = stripePaymentIntentId.replace(/"/g, '\\"');
  const existing: any[] = await getAllRecords(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`,
  );
  if (existing.length === 0) return { found: false, flipped: false };
  const payment = existing[0];
  // Idempotency: any non-pending row is a no-op. We only flip pending → abandoned
  // so a succeeded row never gets downgraded by a delayed cron pass.
  if (payment['Status'] !== 'pending') return { found: true, flipped: false };

  const fields: Record<string, any> = {
    'Status': 'abandoned',
    'Abandoned At': new Date().toISOString(),
  };
  if (opts.stripeStatus) fields['Abandoned Reason'] = `stripe_status=${opts.stripeStatus}`;

  try {
    await updateRecord(PAYMENTS_TABLE, payment.id, fields);
  } catch (e: any) {
    // Schema fallback — Abandoned At + Abandoned Reason may not exist yet in
    // older Airtable schemas. Retry with just Status so the cron still
    // makes forward progress. createRecord/updateRecord typecast will create
    // the 'abandoned' singleSelect option on first hit.
    console.warn('[markDepositAbandoned] schema fallback (retrying with Status only):', e?.message);
    await updateRecord(PAYMENTS_TABLE, payment.id, { 'Status': 'abandoned' });
  }
  return { found: true, flipped: true };
}

/**
 * Orphan-reaper escalation contract: when the cron retrieves a PaymentIntent
 * that is `succeeded` but the local Payments row is still pending, the webhook
 * missed an event. Flag the row 'requires_webhook_replay' so the operator can
 * manually replay/repair it — DO NOT silently fire the success branch (that
 * would skip audit + funnel + Telegram celebration which are tightly coupled
 * to the webhook handler). Loud Telegram alert is fired by the caller.
 *
 * Idempotent — re-running on an already-flagged row is a no-op.
 */
export async function markDepositRequiresReplay(
  stripePaymentIntentId: string,
): Promise<{ found: boolean; flipped: boolean }> {
  const escaped = stripePaymentIntentId.replace(/"/g, '\\"');
  const existing: any[] = await getAllRecords(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`,
  );
  if (existing.length === 0) return { found: false, flipped: false };
  const payment = existing[0];
  if (payment['Status'] !== 'pending') return { found: true, flipped: false };

  try {
    await updateRecord(PAYMENTS_TABLE, payment.id, {
      'Status': 'requires_webhook_replay',
      'Abandoned At': new Date().toISOString(),
      'Abandoned Reason': 'webhook_missed_succeeded',
    });
  } catch (e: any) {
    console.warn('[markDepositRequiresReplay] schema fallback (Status only):', e?.message);
    await updateRecord(PAYMENTS_TABLE, payment.id, { 'Status': 'requires_webhook_replay' });
  }
  return { found: true, flipped: true };
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

  // P2-A audit fix: full-refund post-flip restore.
  //
  // Pre-fix, markDepositRefunded only stamped the Payments row. The linked
  // Referral stayed Closed Won → buyer permanently showed as converted →
  // affiliate auto-enroll fired, monthly backer letters went out, repeat-
  // purchase cron emailed the buyer. Money back, funnel says "won". Disaster.
  //
  // On any FULL (non-partial) refund of a buyer-deposit Payments row whose
  // Referral was Closed Won, revert the deal:
  //   - Referral.Status → 'Refunded' (new option, typecast-created)
  //   - Clear Closed At, Sale Amount, Commission Due, Commission Status
  //   - Stamp Refunded At
  //   - Decrement rancher capacity (the deal reverts; slot opens back up)
  //   - Buyer → Buyer Stage='READY', Buyer Health='Active', Sequence Stage=''
  //   - Audit-log the restore
  //   - Telegram-alert the operator (no buyer email storm)
  //
  // Partial refunds skip the restore — the deal is still "won" with reduced
  // sale amount. Operator can manually convert to full refund if desired.
  //
  // Idempotency: the early-return on Status==='refunded' above already
  // prevents double-restore. We also guard on Referral.Status==='Closed Won'
  // so re-running against an already-restored Referral is a no-op.
  if (!opts.partial) {
    try {
      await restoreReferralAfterRefund(payment, stripePaymentIntentId);
    } catch (e: any) {
      // Restore failure is non-fatal — the Payments row already flipped,
      // operator gets a Telegram alert via the catch path.
      console.error('[markDepositRefunded] restore-referral failed (non-fatal):', e?.message || e);
      try {
        await sendTelegramUpdate(
          `WARN DEPOSIT REFUNDED — Payments row flipped but Referral restore failed. PI ${stripePaymentIntentId.slice(-8)}. Error: ${e?.message || e}. Manual cleanup required.`,
        );
      } catch {}
    }
  }

  return { flipped: true };
}

/**
 * Revert the buyer-side / rancher-side funnel state after a full deposit
 * refund. Called from markDepositRefunded — separated for readability and so
 * the catch can isolate restore failures from the Payments-row write.
 *
 * Idempotent: re-running against an already-Refunded Referral is a no-op
 * (early-return on Status check). Webhook retries safe.
 */
async function restoreReferralAfterRefund(
  payment: any,
  stripePaymentIntentId: string,
): Promise<void> {
  // Pull linked Referral id from the Payments row. Linked-record fields are
  // always returned as arrays of record IDs.
  const referralIds: string[] = (payment['Referral'] || []) as string[];
  const referralId = Array.isArray(referralIds) ? referralIds[0] : null;
  if (!referralId) {
    console.warn('[restoreReferralAfterRefund] no Referral linked on Payments row', payment.id);
    return;
  }

  const referral: any = await getRecordById(TABLES.REFERRALS, referralId);
  if (!referral) {
    console.warn('[restoreReferralAfterRefund] Referral not found', referralId);
    return;
  }

  const currentStatus = String(referral['Status'] || '');
  // Idempotency: only restore from a Closed Won state. If the Referral was
  // already flipped to Refunded (re-run), or never reached Closed Won (refund
  // before close), skip the buyer/rancher restore — operator handles edge cases.
  if (currentStatus === 'Refunded') {
    console.log('[restoreReferralAfterRefund] Referral already Refunded, no-op', referralId);
    return;
  }
  if (currentStatus !== 'Closed Won') {
    console.warn(
      `[restoreReferralAfterRefund] Referral ${referralId} status=${currentStatus} (not Closed Won) — skipping restore. Operator should review.`,
    );
    return;
  }

  const now = new Date().toISOString();
  const rancherIds: string[] = (referral['Rancher'] || []) as string[];
  const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
  const buyerIds: string[] = (referral['Buyer'] || []) as string[];
  const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;

  // 1. Flip Referral state. Clear Closed Won-only fields. typecast creates
  // the 'Refunded' singleSelect option if it doesn't exist yet.
  const referralUpdates: Record<string, any> = {
    'Status': 'Refunded',
    'Closed At': null,
    'Sale Amount': null,
    'Commission Due': null,
    'Commission Status': null,
    'Refunded At': now,
  };
  try {
    await updateRecord(TABLES.REFERRALS, referralId, referralUpdates);
  } catch (e: any) {
    // Schema fallback: Refunded At on Referral may not exist yet. Retry
    // without it — the Refunded At on the Payments row is the primary audit.
    console.warn('[restoreReferralAfterRefund] Referral update fallback:', e?.message);
    const fallback = { ...referralUpdates };
    delete fallback['Refunded At'];
    await updateRecord(TABLES.REFERRALS, referralId, fallback);
  }

  // 2. Decrement rancher capacity — one count back since the deal reverts.
  // Best-effort: capacity drift on a rare refund is a non-fatal warning.
  if (rancherId) {
    try {
      const newCount = await decrementCapacity(rancherId);
      await syncCapacityToAirtable(rancherId, newCount);
    } catch (capErr: any) {
      console.warn('[restoreReferralAfterRefund] capacity decrement failed:', capErr?.message);
    }
  }

  // 3. Restore buyer to the routing pool. Sequence Stage clear stops the
  // post-purchase email sequence + repeat-purchase cron from firing.
  if (buyerId) {
    try {
      await updateRecord(TABLES.CONSUMERS, buyerId, {
        'Buyer Stage': 'READY',
        'Buyer Stage Updated At': now,
        'Buyer Health': 'Active',
        'Sequence Stage': '',
        'Ready to Buy': true,
      });
    } catch (e: any) {
      console.warn('[restoreReferralAfterRefund] Consumer restore failed:', e?.message);
    }
  }

  // 4. Audit log. typecast widens the Actor singleSelect to accept 'system'
  // if it doesn't already exist. We cast through unknown because the existing
  // AuditActor union doesn't yet include 'system' — refund-restore is a
  // brand-new actor type and we don't want to ripple the type across every
  // existing audit call site.
  try {
    await logAuditEntry({
      actor: 'system' as unknown as 'cron',
      tool: 'stripe-refund-restore',
      targetType: 'Referral',
      targetId: referralId,
      args: {
        paymentIntentId: stripePaymentIntentId,
        referralId,
        rancherId,
        buyerId,
        previousStatus: currentStatus,
      },
      result: {
        referralStatus: 'Refunded',
        capacityDecremented: !!rancherId,
        buyerRestored: !!buyerId,
      },
      reverseAction: { type: 'noop', reason: 'Stripe-driven refund — cannot un-refund via Airtable' },
    });
  } catch (e: any) {
    console.warn('[restoreReferralAfterRefund] audit log failed:', e?.message);
  }

  // 5. Telegram alert — operator decides next step. NO buyer email storm.
  try {
    await sendTelegramUpdate(
      `🔁 DEPOSIT REFUNDED — Referral reverted, buyer back in routing pool: ref=${referralId}`,
    );
  } catch (e: any) {
    console.warn('[restoreReferralAfterRefund] Telegram alert failed:', e?.message);
  }
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
