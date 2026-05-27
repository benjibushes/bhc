// Stage-3 Task 12 — admin-triggered refund on a buyer deposit.
//
// Calls Stripe Refund API on the CONNECTED account (direct charges live
// on the rancher's acct_*, not the platform). markDepositRefunded flips
// the Payments row when the charge.refunded webhook fires — calling it
// here pre-emptively makes the UI feel instant; the webhook is the
// canonical source of truth.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getStripe } from '@/lib/stripe';
import { getRecordById, TABLES } from '@/lib/airtable';
import { markDepositRefunded } from '@/lib/contracts/payments';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { logAuditEntry } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const PAYMENTS_TABLE = 'Payments';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  const { paymentId } = await params;
  if (!paymentId) {
    return NextResponse.json({ error: 'Missing paymentId' }, { status: 400 });
  }

  // Load Payments row by Airtable record id (not Stripe PI id).
  let payment: any;
  try {
    payment = await getRecordById(PAYMENTS_TABLE, paymentId);
  } catch (e: any) {
    return NextResponse.json({ error: 'Payment not found.' }, { status: 404 });
  }
  if (!payment) return NextResponse.json({ error: 'Payment not found.' }, { status: 404 });

  const piId = String(payment['Stripe Payment Intent Id'] || '');
  if (!piId) {
    return NextResponse.json({ error: 'Payment has no Stripe Payment Intent Id.' }, { status: 422 });
  }

  const status = String(payment['Status'] || '');
  if (status === 'refunded') {
    // Idempotent — return 200 so double-click UIs don't error.
    return NextResponse.json({ ok: true, alreadyRefunded: true });
  }
  if (status !== 'succeeded') {
    return NextResponse.json(
      { error: `Cannot refund payment in status "${status}". Only succeeded payments can be refunded.` },
      { status: 422 },
    );
  }

  // Resolve the connected account id (refund must be initiated on the same
  // account the charge lived on for direct-charge model).
  const rancherIds = (payment['Rancher'] || []) as string[];
  const rancherId = rancherIds[0];
  if (!rancherId) {
    return NextResponse.json({ error: 'Payment is missing rancher link.' }, { status: 422 });
  }
  let rancher: any;
  try {
    rancher = await getRecordById(TABLES.RANCHERS, rancherId);
  } catch (e: any) {
    return NextResponse.json({ error: 'Rancher record not found.' }, { status: 404 });
  }
  const connectAccountId = String(rancher?.['Stripe Connect Account Id'] || '');
  if (!connectAccountId) {
    return NextResponse.json(
      { error: 'Rancher has no Stripe Connect account — cannot refund a direct charge.' },
      { status: 422 },
    );
  }

  // Parse optional body for reason + reverse_transfer (refund the platform fee too).
  let body: any = {};
  try { body = await request.json(); } catch { /* allow empty body */ }
  const reason: string | undefined = body?.reason;
  const refundAppFee: boolean = body?.refundApplicationFee !== false; // default true

  // Stripe Refund — on the connected account. reverse_transfer=true returns
  // the application fee from the platform balance back to the connected
  // account so a partial refund correctly clawbacks BHC's commission.
  let refund: any;
  try {
    const stripe = getStripe();
    refund = await stripe.refunds.create(
      {
        payment_intent: piId,
        ...(reason ? { reason: reason as any } : {}),
        reverse_transfer: refundAppFee,
        refund_application_fee: refundAppFee,
        metadata: { source: 'admin_console', paymentRowId: paymentId },
      },
      {
        stripeAccount: connectAccountId,
        idempotencyKey: `refund-${paymentId}`,
      },
    );
  } catch (e: any) {
    console.error('[admin/payments/refund] Stripe refund failed:', e?.message);
    return NextResponse.json(
      { error: `Stripe refund failed: ${e?.message || 'unknown'}` },
      { status: 502 },
    );
  }

  // Eagerly flip Payments row. The charge.refunded webhook will also fire
  // and idempotently no-op since markDepositRefunded returns { flipped: false }
  // when the row is already refunded.
  try {
    await markDepositRefunded(piId);
  } catch (e: any) {
    console.warn('[admin/payments/refund] markDepositRefunded post-refund failed:', e?.message);
  }

  // Audit + Telegram alert. Best-effort.
  try {
    await logAuditEntry({
      actor: 'manual',
      tool: 'admin-payments-refund',
      targetType: 'Other',
      targetId: paymentId,
      args: { paymentId, piId, reason, refundAppFee, connectAccountId },
      result: { refundId: refund?.id, status: refund?.status, amount: refund?.amount },
      reverseAction: {
        type: 'noop',
        reason: `Refund ${refund?.id} cannot be reversed — Stripe refunds are terminal.`,
      },
    });
  } catch (e: any) {
    console.warn('[admin/payments/refund] audit log failed:', e?.message);
  }

  try {
    const ranchName = rancher['Ranch Name'] || rancher['Operator Name'] || rancherId;
    const dollars = ((Number(payment['Amount Cents'] || 0)) / 100).toFixed(2);
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `↩️ ADMIN REFUND — $${dollars} on ${ranchName} (PI ${piId.slice(-8)}, refund ${refund?.id?.slice(-8) || '?'})`,
    );
  } catch (e: any) {
    console.warn('[admin/payments/refund] telegram alert failed:', e?.message);
  }

  return NextResponse.json({
    ok: true,
    refundId: refund?.id,
    status: refund?.status,
    amount: refund?.amount,
  });
}
