import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { transition } from '@/lib/deal/transitionLive';
import {
  calcCommissionForRancher,
  hasLockedCommissionRate,
  getRancherCommissionRate,
} from '@/lib/commission';
import { createCommissionInvoice } from '@/lib/stripe-commission';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { requireRancher } from '@/lib/rancherAuth';

export const maxDuration = 60;

// Rancher confirms payment received for a referral that was previously
// flipped to Awaiting Payment. Moves Status → Closed Won + fires the Stripe
// commission invoice.
//
// Why this exists: off-platform closes (buyer pays on delivery, by cash,
// Venmo, etc) shouldn't generate a commission invoice the moment the
// rancher says "yeah we agreed on a deal." The Ashcraft pattern (2026-05-20)
// invoiced $95 commission on a $1 placeholder sale because the rancher
// closed before the buyer had paid. This endpoint is the explicit
// confirmation gate — invoice only fires here.
//
// Body: { saleAmount: number, method?: 'cash' | 'check' | 'venmo' | 'square'
//   | 'stripe' | 'wire' | 'other' }
//
// Returns: { ok: true, saleAmount, commission, invoiceUrl }
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireRancher(request);
    if (auth instanceof NextResponse) return auth;
    const decoded = { rancherId: auth.session.rancherId };

    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const saleAmount = Number(body?.saleAmount);
    const method = String(body?.method || 'other');

    if (!Number.isFinite(saleAmount) || saleAmount <= 0) {
      return NextResponse.json(
        { error: 'A positive saleAmount is required.' },
        { status: 400 },
      );
    }

    const ref: any = await getRecordById(TABLES.REFERRALS, id);
    if (!ref) {
      return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
    }

    // Verify ownership — same pattern as PATCH endpoint
    const assignedIds: string[] = ref['Rancher'] || [];
    const suggestedIds: string[] = ref['Suggested Rancher'] || [];
    const isOwner =
      (Array.isArray(assignedIds) && assignedIds.includes(decoded.rancherId)) ||
      (Array.isArray(suggestedIds) && suggestedIds.includes(decoded.rancherId));
    if (!isOwner) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const currentStatus = String(ref['Status'] || '');
    if (currentStatus !== 'Awaiting Payment') {
      return NextResponse.json(
        {
          error: `Referral is in ${currentStatus} state, not Awaiting Payment. Use the regular Close-Sale flow instead.`,
        },
        { status: 400 },
      );
    }

    const rancher: any = await getRecordById(TABLES.RANCHERS, decoded.rancherId);
    if (!hasLockedCommissionRate(rancher)) {
      return NextResponse.json(
        {
          error:
            'No Commission Rate locked on your account. Contact hello@buyhalfcow.com to set this before confirming payment.',
        },
        { status: 400 },
      );
    }

    const commission = calcCommissionForRancher(rancher, saleAmount);
    const rate = getRancherCommissionRate(rancher);

    const nowIso = new Date().toISOString();
    const _t = await transition(id, {
      to: 'CLOSED_WON',
      actor: `rancher:${decoded.rancherId}`,
      reason: 'off-platform payment confirmed',
      extraFields: {
        'Sale Amount': saleAmount,
        'Commission Due': commission,
        'Payment Confirmed At': nowIso,
        'Payment Confirmation Method': method,
        'Closed At': ref['Closed At'] || nowIso,
        'Last Rancher Activity At': nowIso,
        'Rancher Engaged Flag': true,
      },
    });
    if (!_t.ok && !_t.noop) {
      // Safety net: the state machine must NEVER block a real close. Fall back to
      // the original direct write and alert the operator.
      console.error('[confirm-payment] transition rejected, falling back to direct write:', _t.error);
      await updateRecord(TABLES.REFERRALS, id, {
        Status: 'Closed Won',
        'Sale Amount': saleAmount,
        'Commission Due': commission,
        'Payment Confirmed At': nowIso,
        'Payment Confirmation Method': method,
        'Closed At': ref['Closed At'] || nowIso,
        'Last Rancher Activity At': nowIso,
        'Rancher Engaged Flag': true,
      });
      try {
        const { sendOperatorSignal } = await import('@/lib/operatorSignal');
        await sendOperatorSignal({ urgency: 'normal', kind: 'system-error', summary: `Deal ${id}: state-machine rejected Closed Won (used fallback). Check lib/deal.`, dedupeKey: `transition-fallback-${id}`, dedupeWindowMs: 3600_000 });
      } catch {}
    }

    // Fire the invoice. createCommissionInvoice enforces floor + ratio guards
    // — if it throws, we surface the error to the dashboard so the rancher
    // can correct + retry. Status stays Closed Won regardless (sale is
    // confirmed; invoice can be re-fired manually).
    //
    // Tier_v2 ranchers SKIP — commission already taken at deposit time via
    // Stripe Connect application_fee_amount. Legacy invoice here = double-bill.
    const pricingModel = String(rancher?.['Pricing Model'] || 'legacy');
    const skipLegacyInvoice = pricingModel === 'tier_v2';
    if (skipLegacyInvoice) {
      console.log(`[confirm-payment] rancher ${rancher.id} is tier_v2 — skipping legacy commission invoice`);
    }
    let invoiceUrl = '';
    let invoiceId = '';
    let invoiceError = '';
    if (!skipLegacyInvoice) try {
      const result = await createCommissionInvoice({
        rancher: {
          id: rancher.id,
          operatorName: rancher['Operator Name'] || '',
          ranchName: rancher['Ranch Name'] || '',
          email: rancher['Email'] || '',
          stripeCustomerId: rancher['Stripe Customer ID'] || undefined,
        },
        referral: {
          id,
          buyerName: ref['Buyer Name'] || '',
          orderType: ref['Order Type'] || '',
          saleAmount,
          commissionDue: commission,
        },
      });
      invoiceUrl = result.invoiceUrl;
      invoiceId = result.invoiceId;
      await updateRecord(TABLES.REFERRALS, id, {
        'Stripe Invoice ID': invoiceId,
        'Stripe Invoice URL': invoiceUrl,
      });
    } catch (e: any) {
      invoiceError = e?.message || 'Stripe invoice failed';
      // createCommissionInvoice fires its own loud operator signal on the
      // floor/ratio guard fail — no need to double up here.
    }

    // Telegram celebration card so Ben sees the confirmed payment land.
    try {
      if (TELEGRAM_ADMIN_CHAT_ID) {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `💵 <b>Payment Confirmed</b> — ${ref['Buyer Name']} → ${rancher['Operator Name']}\n\n` +
            `Sale: <b>$${saleAmount.toLocaleString()}</b>\n` +
            `Commission (${(rate * 100).toFixed(1)}%): <b>$${commission.toLocaleString()}</b>\n` +
            `Method: ${method}\n` +
            (invoiceUrl
              ? `Invoice: ${invoiceUrl}\n`
              : `⚠️ Invoice failed: ${invoiceError}\n`),
        );
      }
    } catch {}

    return NextResponse.json({
      ok: true,
      saleAmount,
      commission,
      commissionRate: rate,
      invoiceUrl,
      invoiceError: invoiceError || undefined,
    });
  } catch (error: any) {
    console.error('confirm-payment error:', error);
    return NextResponse.json(
      { error: error?.message || 'Internal error' },
      { status: 500 },
    );
  }
}
