// app/api/rancher/orders/refund/route.ts
//
// CANCEL / REFUND a product order (shop-chain audit 2026-08-01).
//
// The gap: app/rancher/ProductsTab.tsx offered mark-shipped and
// mark-picked-up and nothing else. There was NO refund and NO cancel path for
// a rancher or an admin on a product order — it took the Stripe dashboard,
// after which the Rancher Orders row sat at 'New' (i.e. still shippable) until
// the charge.refunded webhook caught up. And a buyer who changed their mind
// ten minutes after ordering had no path but a support ticket, because
// 'Cancelled' was read by three modules and written by nobody.
//
//   POST { orderId, action:'cancel'|'refund', confirm:true }
//
// MONEY SAFETY — the ordering below is deliberate:
//   1. decideTermination (pure, tested) refuses shipped / already-terminal /
//      no-payment-intent. FAIL CLOSED on everything it can't prove.
//   2. `confirm:true` is required — no single stray POST moves money.
//   3. claimOnce serialises double-clicks and concurrent operators.
//   4. Status is flipped to the terminal state BEFORE the Stripe refund. Two
//      reasons: it closes the ship rail first (the safety-critical direction —
//      "refund never ships"), and it is the fail-closed probe for the
//      'Cancelled' select option. If that write fails, NO money has moved and
//      the caller gets an honest error.
//   5. Stripe refund on the CONNECTED account (these are direct charges) with
//      refund_application_fee so BHC's margin goes back too — otherwise the
//      rancher's balance eats the full refund while BHC keeps its cut.
//      Idempotency-keyed per order, so a retry can never double-refund.
//   6. If the refund fails, Status is reverted to 'New' and the operator is
//      rung loudly — the order is live again rather than a lie.
//   7. reconcileProductOrderRefund(force) then runs the SAME side effects the
//      webhook path runs (stock restore, external-order cancel, notices),
//      each individually idempotent. The charge.refunded webhook that lands
//      seconds later sees a terminal Status and no-ops.
//
// Operator Telegram fires on EVERY use (both success and failure) — a
// self-serve money reversal is never allowed to be invisible.

import { NextResponse } from 'next/server';
import { requireRancher } from '@/lib/rancherAuth';
import { requireAdmin } from '@/lib/adminAuth';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { getStripeClient } from '@/lib/stripeConnect';
import { claimOnce } from '@/lib/rancherCapacity';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { decideTermination } from '@/lib/productOrderTermination';
import { reconcileProductOrderRefund } from '@/lib/productSettlement';
import { isBrokerRancher } from '@/lib/brokerRail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const dollars = (c: number) => (c / 100).toFixed(2);

export async function POST(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const orderId = String(body?.orderId || '').trim();
  if (!/^rec[A-Za-z0-9]{14}$/.test(orderId)) {
    return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });
  }
  // EXPLICIT CONFIRM STEP: the UI asks "are you sure" and only then sends
  // confirm:true. A hand-rolled POST without it does nothing.
  if (body?.confirm !== true) {
    return NextResponse.json(
      { error: 'confirm required — this refunds the buyer and cannot be undone.' },
      { status: 400 },
    );
  }

  // AUTH: the owning rancher, or an admin (ops needs this for the cases a
  // rancher can't resolve themselves). Rancher first — the common path.
  const r = await requireRancher(request);
  const rancherSession = r instanceof NextResponse ? null : r.session;
  let actor: 'rancher' | 'admin';
  if (rancherSession) {
    actor = 'rancher';
  } else {
    const denied = await requireAdmin(request);
    if (denied) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    actor = 'admin';
  }

  const order: any = await getRecordById(TABLES.RANCHER_ORDERS, orderId).catch(() => null);
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });

  const orderRancherId = String(order['Rancher Record ID'] || '').trim();
  if (actor === 'rancher' && orderRancherId !== rancherSession!.rancherId) {
    return NextResponse.json({ error: 'This order does not belong to you.' }, { status: 403 });
  }

  const decision = decideTermination(
    {
      status: order['Status'],
      shippedAt: order['Shipped At'],
      stripePaymentIntent: order['Stripe Payment Intent'],
    },
    body?.action,
  );
  if (!decision.ok) {
    return NextResponse.json({ error: decision.message, code: decision.code }, { status: decision.status });
  }

  // The rancher row carries the connected account the charge lives on.
  const rancher: any = orderRancherId
    ? await getRecordById(TABLES.RANCHERS, orderRancherId).catch(() => null)
    : null;
  // BROKER-RAIL FENCE (#523): a represented ranch is not a marketplace seller
  // — its money model is "the deposit IS the commission" and it has no
  // Connect account for these charges. It can't legitimately own a Rancher
  // Orders row; if one exists the data is wrong, so refuse rather than guess
  // at whose balance to pull the refund from.
  if (rancher && isBrokerRancher(rancher)) {
    return NextResponse.json(
      { error: 'this ranch is on the represented (broker) rail — refunds there go through ben, not this button.' },
      { status: 409 },
    );
  }
  const connectAccountId = String(rancher?.['Stripe Connect Account Id'] || '').trim();
  if (!connectAccountId) {
    // FAIL CLOSED: without the account we cannot refund a direct charge, and
    // flipping the row alone would tell everyone the money moved when it hasn't.
    return NextResponse.json(
      { error: 'we can’t reach the payment account for this order — reply to your order email and we’ll handle it by hand.' },
      { status: 409 },
    );
  }

  // Serialise double-clicks + concurrent rancher/admin attempts.
  if (!(await claimOnce(`order-terminate:${orderId}`, 120))) {
    return NextResponse.json({ error: 'already in flight — give it a second.' }, { status: 409 });
  }

  const productName = String(order['Product Name'] || 'a product');
  const rancherName = String(order['Rancher Name'] || 'the ranch');
  const buyerPaidCents = Math.round(Number(order['Buyer Paid'] || 0) * 100);
  const { piId, terminalStatus, action } = decision;

  // ── STEP 1: close the ship rail (and probe that the status can persist) ───
  try {
    await updateRecord(TABLES.RANCHER_ORDERS, orderId, { Status: terminalStatus });
  } catch (e: any) {
    console.error('[orders/refund] terminal status write failed — no money moved:', e?.message);
    await sendOperatorSignal({
      urgency: 'loud',
      kind: 'system-error',
      summary: `ORDER ${action.toUpperCase()} BLOCKED — ${productName}`,
      detail:
        `A ${action} on the ${productName} order (${rancherName}) could not record Status='${terminalStatus}', so NOTHING was refunded.\n` +
        `If this says the option is unknown, add '${terminalStatus}' to the Rancher Orders 'Status' single-select.\n` +
        `Airtable said: ${e?.message || 'unknown'}`,
      dedupeKey: `order-terminate-block:${orderId}`,
    }).catch(() => {});
    return NextResponse.json(
      { error: 'we couldn’t record the cancellation, so we didn’t touch the money. ben has been alerted — nothing was charged or refunded.' },
      { status: 503 },
    );
  }
  // 'Cancelled At' is a NEW field — its own patch so a missing field can never
  // undo step 1.
  if (terminalStatus === 'Cancelled') {
    await updateRecord(TABLES.RANCHER_ORDERS, orderId, { 'Cancelled At': new Date().toISOString() }).catch(() => {});
  }

  // ── STEP 2: move the money ───────────────────────────────────────────────
  let refund: any = null;
  try {
    const stripe = getStripeClient();
    refund = await stripe.refunds.create(
      {
        payment_intent: piId,
        // Direct charge on the connected account: refund_application_fee pulls
        // BHC's margin back from the platform balance so the rancher isn't the
        // only one giving money back. (reverse_transfer is the destination-
        // charge param and has no transfer to reverse here — deliberately not
        // passed.)
        refund_application_fee: true,
        metadata: { source: `bhc_${actor}_${action}`, orderRowId: orderId },
      },
      {
        stripeAccount: connectAccountId,
        // One key per order+action: a retry returns the SAME refund instead of
        // creating a second one.
        idempotencyKey: `bhc-order-${action}-${orderId}`,
      },
    );
  } catch (e: any) {
    console.error('[orders/refund] Stripe refund failed — reverting status:', e?.message);
    // Nothing else has run yet, so putting the order back to 'New' is clean
    // (and it is better to have a live order than a "cancelled" one whose
    // money never moved).
    await updateRecord(TABLES.RANCHER_ORDERS, orderId, { Status: 'New' }).catch(() => {});
    await sendOperatorSignal({
      urgency: 'loud',
      kind: 'system-error',
      summary: `ORDER ${action.toUpperCase()} FAILED — ${productName} ($${dollars(buyerPaidCents)})`,
      detail:
        `Stripe refused the refund for the ${productName} order (${rancherName}, PI ${piId}) on account ${connectAccountId}.\n` +
        `The order was put back to 'New' — the buyer's money has NOT moved. Refund it in Stripe by hand if it should have.\n` +
        `Stripe said: ${e?.message || 'unknown'}`,
      dedupeKey: `order-terminate-fail:${orderId}`,
    }).catch(() => {});
    return NextResponse.json(
      { error: 'the refund didn’t go through, so we put the order back. ben has been alerted — nothing was charged or refunded.' },
      { status: 502 },
    );
  }

  // ── STEP 3: the same side effects the webhook path runs ──────────────────
  // force:true because step 1 already flipped Status; every side effect inside
  // has its own durable guard, so the webhook redelivery seconds from now
  // no-ops. A failure here is loud but NOT fatal: the money has moved and the
  // webhook is the durable backstop.
  try {
    await reconcileProductOrderRefund(piId, {
      kind: 'refund',
      amountCents: Number(refund?.amount || buyerPaidCents),
      terminalStatus,
      force: true,
      // Don't scream "🛑 DO NOT SHIP" at the rancher who just clicked cancel.
      notifyRancher: actor !== 'rancher',
    });
  } catch (e: any) {
    console.error('[orders/refund] reconcile after refund failed (money already moved):', e?.message);
    await sendOperatorSignal({
      urgency: 'loud',
      kind: 'system-error',
      summary: `ORDER ${action.toUpperCase()} — RECONCILE FAILED — ${productName}`,
      detail:
        `The refund SUCCEEDED (PI ${piId}) but the follow-up reconcile threw, so stock restore / external-order cancel / buyer notice may not have run.\n` +
        `The charge.refunded webhook should self-heal this; verify the order and the product's Orders Left.\n` +
        `Error: ${e?.message || 'unknown'}`,
      dedupeKey: `order-terminate-reconcile:${orderId}`,
    }).catch(() => {});
  }

  // Operator visibility on EVERY successful use.
  await sendOperatorSignal({
    urgency: 'loud',
    kind: 'sale',
    summary: `ORDER ${action.toUpperCase()}ED by ${actor} — ${productName} ($${dollars(Number(refund?.amount || buyerPaidCents))})`,
    detail:
      `${rancherName}'s ${productName} order was ${action === 'cancel' ? 'cancelled' : 'refunded'} by the ${actor} from the dashboard.\n` +
      `Status is now ${terminalStatus}; the buyer has been emailed and the stock restored.`,
    dedupeKey: `order-terminated:${orderId}`,
  }).catch(() => {});

  const fresh: any = await getRecordById(TABLES.RANCHER_ORDERS, orderId).catch(() => null);
  return NextResponse.json({
    ok: true,
    action,
    status: String(fresh?.['Status'] || terminalStatus),
    refundedCents: Number(refund?.amount || 0),
  });
}
