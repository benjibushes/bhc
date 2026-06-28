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
  // NRD-5 (2026-06-05): non-refundable lock override flag. Required when the
  // payment's referral has Rancher Accepted At set. operator must supply
  // nrdOverrideReason as well so the audit trail captures WHY a locked
  // deposit was force-refunded (e.g., rancher cancelled, force majeure,
  // chargeback prevention).
  const nrdOverride: boolean = body?.nrdOverride === true;
  const nrdOverrideReason: string | undefined = body?.nrdOverrideReason;

  // NRD-5 gate: load the linked referral, check Rancher Accepted At, block
  // unless explicit nrdOverride + reason. The reason flows into the audit
  // log + Telegram alert so Ben can spot misuse.
  try {
    const refIds: string[] = (payment['Referral'] || []) as string[];
    const refId = refIds[0];
    if (refId) {
      const ref: any = await getRecordById(TABLES.REFERRALS, refId);
      const acceptedAt = ref?.['Rancher Accepted At'];
      if (acceptedAt) {
        if (!nrdOverride) {
          return NextResponse.json(
            {
              error: 'Refund blocked — deposit is locked per NRD policy',
              acceptedAt,
              hint: 'Rancher already accepted this slot. Re-submit with nrdOverride=true AND nrdOverrideReason="<why>" to force-refund. Reason will be audit-logged.',
            },
            { status: 412 },
          );
        }
        if (!nrdOverrideReason || nrdOverrideReason.trim().length < 6) {
          return NextResponse.json(
            { error: 'nrdOverrideReason required (min 6 chars) when force-refunding a locked deposit' },
            { status: 400 },
          );
        }
        // Loud Telegram so the override is visible in real time.
        try {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `🚨 <b>NRD OVERRIDE REFUND</b>\n\n` +
              `Payment: <code>${paymentId}</code>\n` +
              `Referral: <code>${refId}</code>\n` +
              `Slot accepted at: ${acceptedAt}\n` +
              `Operator reason: ${nrdOverrideReason}\n\n` +
              `<i>A locked deposit was force-refunded. Verify this was authorized.</i>`,
          );
        } catch {}
      }
    }
  } catch (e: any) {
    console.warn('[refund/NRD] gate check failed (fail-open):', e?.message);
  }

  // Partial refund support — P0 audit fix (C-6). amountCents is optional;
  // absent → full refund (preserves prior behavior). Must be positive +
  // <= the net-refundable amount (original minus already-refunded).
  //
  // NRD-7 (2026-06-18): cap against Refunded Amount Cents so sequential
  // partial refunds cannot exceed the original. Fall back to 0 if the field
  // is absent (older schema rows / first refund). Defensive — never throw on
  // missing field.
  // Cap against the TRUE charged total, not the deposit-only 'Amount Cents'.
  // The buyer's card was charged deposit + platform fee (+ tax), captured as
  // 'Total Charged Cents' at settlement. Capping on the deposit alone would
  // reject valid refunds of the fee portion and mis-detect full refunds.
  // Fallbacks for older rows settled before Total Charged Cents existed:
  // deposit + fee, then deposit alone.
  const depositAmountCents = Number(payment['Amount Cents'] || 0);
  const platformFeeCents = Number(payment['Platform Fee Cents'] || 0);
  const totalChargedCents = Number(payment['Total Charged Cents'] || 0);
  const originalAmountCents =
    totalChargedCents > 0
      ? totalChargedCents
      : (depositAmountCents + platformFeeCents) || depositAmountCents;
  const alreadyRefundedCents = Number(payment['Refunded Amount Cents'] || 0);
  const netRefundableCents = Math.max(0, originalAmountCents - alreadyRefundedCents);

  if (netRefundableCents <= 0) {
    return NextResponse.json(
      { error: `Payment has already been fully refunded (${originalAmountCents} cents, ${alreadyRefundedCents} already refunded).` },
      { status: 422 },
    );
  }

  let amountCents: number | undefined;
  if (body?.amountCents != null) {
    const n = Number(body.amountCents);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json(
        { error: 'amountCents must be a positive number' },
        { status: 400 },
      );
    }
    if (n > netRefundableCents) {
      return NextResponse.json(
        {
          error: `amountCents (${n}) exceeds net-refundable amount (${netRefundableCents}). ` +
            `Original: ${originalAmountCents}, already refunded: ${alreadyRefundedCents}.`,
        },
        { status: 400 },
      );
    }
    amountCents = Math.floor(n);
  }
  const isPartial = typeof amountCents === 'number' && amountCents < netRefundableCents;

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
        ...(typeof amountCents === 'number' ? { amount: amountCents } : {}),
        reverse_transfer: refundAppFee,
        refund_application_fee: refundAppFee,
        metadata: { source: 'admin_console', paymentRowId: paymentId, partial: String(isPartial) },
      },
      {
        stripeAccount: connectAccountId,
        // Idempotency key includes the amount so different partial refunds
        // against the same payment dedupe correctly. Otherwise a second
        // partial refund w/ same key would silently return the first refund.
        idempotencyKey: `refund-${paymentId}-${typeof amountCents === 'number' ? amountCents : 'full'}`,
      },
    );
  } catch (e: any) {
    console.error('[admin/payments/refund] Stripe refund failed:', e?.message);
    return NextResponse.json(
      { error: `Stripe refund failed: ${e?.message || 'unknown'}` },
      { status: 502 },
    );
  }

  // Eagerly flip Payments row + persist reason + amount. The charge.refunded
  // webhook will also fire and idempotently no-op when the row is already
  // marked. For partial refunds we keep Status='succeeded' so subsequent
  // partials can still target the same row.
  try {
    await markDepositRefunded(piId, {
      reason,
      // Refunded Amount Cents is the CUMULATIVE total — accumulate, don't
      // overwrite, or sequential partials reset the cap and over-refund. The
      // full-refund fallback is net-remaining (not the original) so prior
      // partials aren't double-counted.
      refundedAmountCents: alreadyRefundedCents + (refund?.amount ?? amountCents ?? netRefundableCents),
      partial: isPartial,
    });
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
      args: { paymentId, piId, reason, amountCents, isPartial, refundAppFee, connectAccountId },
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
    const refundedDollars = ((Number(refund?.amount || amountCents || originalAmountCents)) / 100).toFixed(2);
    const origDollars = (originalAmountCents / 100).toFixed(2);
    const tag = isPartial ? `PARTIAL $${refundedDollars}/$${origDollars}` : `$${refundedDollars}`;
    const reasonNote = reason ? ` — ${reason}` : '';
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `↩️ ADMIN REFUND — ${tag} on ${ranchName}${reasonNote} (PI ${piId.slice(-8)}, refund ${refund?.id?.slice(-8) || '?'})`,
    );
  } catch (e: any) {
    console.warn('[admin/payments/refund] telegram alert failed:', e?.message);
  }

  return NextResponse.json({
    ok: true,
    refundId: refund?.id,
    status: refund?.status,
    amount: refund?.amount,
    partial: isPartial,
    originalAmountCents,
    remainingCents: Math.max(0, originalAmountCents - Number(refund?.amount || amountCents || originalAmountCents)),
  });
}
