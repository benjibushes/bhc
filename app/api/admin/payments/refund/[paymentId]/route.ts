// Stage-3 Task 12 — admin-triggered refund on a buyer deposit. TWO RAILS.
//
// CONNECT (money model 1/2). The charge is a DIRECT charge living on the
// rancher's acct_*, so the refund must be initiated on that same connected
// account, and reverse_transfer / refund_application_fee claw BHC's fee back
// out of the platform balance.
//
// BROKER (money model 3 — docs/BUSINESS-MODEL.md). The charge is a plain
// Checkout Session on BHC's OWN platform account: no connected account, no
// application fee, no transfer. A represented ranch has NO
// `Stripe Connect Account Id` BY DEFINITION, and this route used to resolve
// that field and 422 — so the two live AZ broker referrals could not be
// refunded at all, while the reserve page promised the buyer "fully
// refundable … and any refund comes straight back from BuyHalfCow". The rail
// is therefore decided from the LEDGER ROW, before the rancher record is
// touched at all, and a broker refund goes on the platform account with none
// of the three Connect-only parameters (Stripe errors on every one of them
// when there is no connected account behind the charge).
//
// markDepositRefunded flips the Payments row when the charge.refunded webhook
// fires — calling it here pre-emptively makes the UI feel instant; the webhook
// is the canonical source of truth. It also runs the full-refund restore,
// which is what releases the ranch's held capacity slot on both rails.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getStripe } from '@/lib/stripe';
import { getRecordById, TABLES } from '@/lib/airtable';
import { markDepositRefunded, isBrokerPaymentRow, capturedTotalCents } from '@/lib/contracts/payments';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { logAuditEntry } from '@/lib/auditLog';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const PAYMENTS_TABLE = 'Payments';

export type RefundRail = 'broker' | 'connect';

/**
 * Which rail is this Payments row on? Read from the ledger's own `Type`
 * marker, NOT from the rancher record — the row is the thing being refunded,
 * and a represented ranch's record can be edited or unreadable long after the
 * charge settled. Fails CLOSED to 'connect', the unchanged path.
 */
export function refundRailFor(payment: any): RefundRail {
  return isBrokerPaymentRow(payment) ? 'broker' : 'connect';
}

export interface RefundRequestInput {
  rail: RefundRail;
  piId: string;
  paymentId: string;
  isPartial: boolean;
  reason?: string;
  amountCents?: number;
  /** Connect only — reverse the transfer + claw back the application fee. */
  refundAppFee: boolean;
  /** Connect only — the acct_* the direct charge lives on. */
  connectAccountId?: string;
}

/**
 * The exact `stripe.refunds.create(params, options)` pair for this refund.
 * Pure, so both rails are pinned without calling Stripe.
 *
 * THE BROKER RAIL OMITS, DELIBERATELY:
 *   • `stripeAccount` — the charge is on the platform account. Sending a
 *     connected-account header would send Stripe looking for a PaymentIntent
 *     that does not exist there.
 *   • `reverse_transfer` — there is no transfer. Nothing was ever moved to a
 *     connected account; the whole deposit is already BHC's.
 *   • `refund_application_fee` — there is no application fee. The deposit IS
 *     the fee, and it is refunded by refunding the charge itself.
 * All three are Connect-only concepts and Stripe errors on each of them for a
 * plain platform charge. The CONNECT branch is byte-identical to the shape
 * that shipped before the split.
 */
export function buildRefundRequest(input: RefundRequestInput): {
  params: Record<string, any>;
  options: Record<string, any>;
} {
  const { rail, piId, paymentId, isPartial, reason, amountCents, refundAppFee, connectAccountId } = input;
  const common: Record<string, any> = {
    payment_intent: piId,
    ...(reason ? { reason } : {}),
    ...(typeof amountCents === 'number' ? { amount: amountCents } : {}),
  };
  // Idempotency key includes the amount so different partial refunds against
  // the same payment dedupe correctly. Otherwise a second partial refund w/
  // same key would silently return the first refund.
  const idempotencyKey = `refund-${paymentId}-${typeof amountCents === 'number' ? amountCents : 'full'}`;

  if (rail === 'broker') {
    return {
      params: {
        ...common,
        metadata: {
          source: 'admin_console',
          paymentRowId: paymentId,
          partial: String(isPartial),
          rail: 'broker',
        },
      },
      options: { idempotencyKey },
    };
  }

  return {
    params: {
      ...common,
      reverse_transfer: refundAppFee,
      refund_application_fee: refundAppFee,
      metadata: { source: 'admin_console', paymentRowId: paymentId, partial: String(isPartial) },
    },
    options: { stripeAccount: connectAccountId, idempotencyKey },
  };
}

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

  // ── RAIL DECISION — BEFORE the rancher record is touched ─────────────────
  // A represented ranch has no Connect account BY DEFINITION, so resolving one
  // first (as this route used to) hard-blocks every broker refund at 422 with
  // "Rancher has no Stripe Connect account" — a refusal the product's own
  // refund promise cannot survive.
  const rail = refundRailFor(payment);

  const rancherIds = (payment['Rancher'] || []) as string[];
  const rancherId = rancherIds[0];
  let rancher: any = null;
  let connectAccountId = '';

  if (rail === 'connect') {
    // Direct-charge model: the refund must be initiated on the same connected
    // account the charge lived on, so both the link and the account are hard
    // requirements. Unchanged.
    if (!rancherId) {
      return NextResponse.json({ error: 'Payment is missing rancher link.' }, { status: 422 });
    }
    try {
      rancher = await getRecordById(TABLES.RANCHERS, rancherId);
    } catch (e: any) {
      return NextResponse.json({ error: 'Rancher record not found.' }, { status: 404 });
    }
    connectAccountId = String(rancher?.['Stripe Connect Account Id'] || '');
    if (!connectAccountId) {
      return NextResponse.json(
        { error: 'Rancher has no Stripe Connect account — cannot refund a direct charge.' },
        { status: 422 },
      );
    }
  } else if (rancherId) {
    // BROKER: the rancher record is READ-ONLY CONTEXT here (the ranch name in
    // the operator alert). It is never a precondition — the money is on BHC's
    // own account and the refund does not depend on the ranch existing, being
    // readable, or having any Stripe footprint at all.
    rancher = await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null);
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
  // On the Connect rail the buyer's card was charged deposit + platform fee
  // (+ tax), captured as 'Total Charged Cents' at settlement; capping on the
  // deposit alone would reject valid refunds of the fee portion and mis-detect
  // full refunds. capturedTotalCents owns the fallback chain for older rows
  // AND the broker correction (there, deposit and fee are the SAME dollars, so
  // summing them would invent a ceiling twice the real charge).
  const originalAmountCents = capturedTotalCents(payment);
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

  // Stripe Refund. CONNECT: on the connected account, with reverse_transfer so
  // the application fee comes back out of the platform balance and a partial
  // refund correctly claws back BHC's commission. BROKER: on the PLATFORM
  // account with none of those parameters — see buildRefundRequest.
  const { params: refundParams, options: refundOptions } = buildRefundRequest({
    rail,
    piId,
    paymentId,
    isPartial,
    reason,
    amountCents,
    refundAppFee,
    connectAccountId,
  });
  let refund: any;
  try {
    const stripe = getStripe();
    refund = await stripe.refunds.create(refundParams as any, refundOptions as any);
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
      args: { paymentId, piId, rail, reason, amountCents, isPartial, refundAppFee, connectAccountId },
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
    const ranchName = rancher?.['Ranch Name'] || rancher?.['Operator Name'] || rancherId || 'unknown ranch';
    const refundedDollars = ((Number(refund?.amount || amountCents || originalAmountCents)) / 100).toFixed(2);
    const origDollars = (originalAmountCents / 100).toFixed(2);
    const tag = isPartial ? `PARTIAL $${refundedDollars}/$${origDollars}` : `$${refundedDollars}`;
    const reasonNote = reason ? ` — ${reason}` : '';
    // On the broker rail the money leaves BHC's OWN balance and the ranch owes
    // nothing back, so say which balance it came out of — the two rails read
    // identically in Telegram otherwise.
    const railNote = rail === 'broker' ? ' [BROKER — out of BHC balance, ranch owes nothing]' : '';
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `↩️ ADMIN REFUND — ${tag} on ${ranchName}${reasonNote}${railNote} (PI ${piId.slice(-8)}, refund ${refund?.id?.slice(-8) || '?'})`,
    );
  } catch (e: any) {
    console.warn('[admin/payments/refund] telegram alert failed:', e?.message);
  }

  return NextResponse.json({
    ok: true,
    rail,
    refundId: refund?.id,
    status: refund?.status,
    amount: refund?.amount,
    partial: isPartial,
    originalAmountCents,
    remainingCents: Math.max(0, originalAmountCents - Number(refund?.amount || amountCents || originalAmountCents)),
  });
}
