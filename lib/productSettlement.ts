// lib/productSettlement.ts
//
// LOW-TICKET PRODUCT settlement (2026-07-06). Runs from the stripe-connect
// webhook on payment_intent.succeeded when metadata.type === 'product_purchase'.
// The money already moved (Stripe direct-charge split the funds automatically:
// rancher got Base, BHC got the application fee). This handler just RECORDS the
// order + tells the humans: create a Rancher Orders row, fire a loud operator
// signal (a real sale — this one SHOULD ring), receipt the buyer, and email the
// rancher the ship-to so they fulfill.
//
// Idempotent: a Stripe redelivery must never double-record or double-notify.
// Guarded by a claimOnce lock (concurrency) + an existing-order lookup (redelivery).

import { getAllRecords, createRecord, TABLES, escapeAirtableValue, getRecordById } from '@/lib/airtable';
import { claimOnce } from '@/lib/rancherCapacity';
import { PermanentSettlementError } from '@/lib/stripeSettlement';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { sendEmail } from '@/lib/email';

function formatShipping(pi: any): string {
  const s = pi?.shipping || pi?.charges?.data?.[0]?.shipping || null;
  if (!s) return '';
  const a = s.address || {};
  const parts = [
    s.name,
    a.line1,
    a.line2,
    [a.city, a.state, a.postal_code].filter(Boolean).join(', '),
  ].filter(Boolean);
  return parts.join('\n');
}

export async function settleProductPurchase(pi: any): Promise<void> {
  const productId = String(pi?.metadata?.productId || '');
  const productName = String(pi?.metadata?.productName || 'a product');
  const rancherId = String(pi?.metadata?.rancherId || '');
  const rancherName = String(pi?.metadata?.rancherName || 'the ranch');
  const buyerEmail = String(pi?.metadata?.buyerEmail || '').trim().toLowerCase();
  const buyerName = String(pi?.metadata?.buyerName || '').trim();
  const displayCents = Number(pi?.metadata?.displayCents || 0);
  const baseCents = Number(pi?.metadata?.baseCents || 0);
  const marginCents = Number(pi?.metadata?.marginCents || Math.max(0, displayCents - baseCents));

  if (!pi?.id || !buyerEmail || !displayCents) {
    // Malformed → can never settle. Permanent so Stripe stops the 3-day retry.
    throw new PermanentSettlementError(
      `product_purchase missing required fields — piId=${!!pi?.id} buyerEmail=${!!buyerEmail} displayCents=${displayCents}`,
    );
  }

  // Concurrency lock. If we can't claim, another delivery is mid-flight — skip.
  if (!(await claimOnce(`settle-product:${pi.id}`, 60))) return;

  // Redelivery dedup: already recorded this PI? then we're done.
  try {
    const existing = await getAllRecords(
      TABLES.RANCHER_ORDERS,
      `{Stripe Payment Intent} = "${escapeAirtableValue(pi.id)}"`,
    );
    if (Array.isArray(existing) && existing.length > 0) return;
  } catch {
    // If the lookup fails (e.g. table/field rename) fall through and create;
    // a rare duplicate order is safer than dropping a paid sale.
  }

  const shipTo = formatShipping(pi);
  const dollars = (c: number) => (c / 100).toFixed(2);

  await createRecord(TABLES.RANCHER_ORDERS, {
    'Order Ref': `${productName} — ${buyerName || buyerEmail}`,
    'Product Name': productName,
    'Rancher Name': rancherName,
    'Rancher Record ID': rancherId,
    'Buyer Email': buyerEmail,
    'Buyer Name': buyerName,
    'Ship To Address': shipTo,
    'Buyer Paid': displayCents / 100,
    'Rancher Payout': baseCents / 100,
    'BHC Margin': marginCents / 100,
    'Stripe Payment Intent': pi.id,
    'Status': 'New',
    'Ordered At': new Date().toISOString(),
  });

  // LOUD operator signal — a real sale. This is exactly the alert that should
  // ring after the noise cut.
  await sendOperatorSignal({
    urgency: 'loud',
    kind: 'sale',
    summary: `PRODUCT SOLD — ${productName} · $${dollars(displayCents)}`,
    detail:
      `${buyerName || buyerEmail} bought ${productName} from ${rancherName}.\n` +
      `You keep $${dollars(marginCents)} · rancher nets $${dollars(baseCents)}.\n` +
      `Tell ${rancherName} to ship to:\n${shipTo || '(address on the order)'}`,
    dedupeKey: `product-sold:${pi.id}`,
  }).catch(() => {});

  // Buyer receipt (brand voice).
  await sendEmail({
    to: buyerEmail,
    subject: `you're set — ${productName} is on its way`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
      <p>hey ${buyerName ? buyerName.split(/\s+/)[0] : 'there'},</p>
      <p>you're all set — <strong>${rancherName}</strong> got your order for a <strong>${productName}</strong> and will ship it direct to you.</p>
      <p style="font-size:14px;color:#5A5752">paid: $${dollars(displayCents)}. you'll get tracking as soon as it's on the way.</p>
      <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
    </div>`,
    templateName: 'product_receipt',
  }).catch(() => {});

  // Rancher ship-it notification (operational — clear, not marketing).
  try {
    const rancher: any = rancherId ? await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null) : null;
    const rancherEmail = String(rancher?.['Email'] || '').trim();
    if (rancherEmail) {
      await sendEmail({
        to: rancherEmail,
        subject: `new order to ship — ${productName}`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
          <p>hi ${rancherName},</p>
          <p>you have a paid BuyHalfCow order to ship:</p>
          <div style="background:#fff;border:1px solid #A7A29A;padding:16px;margin:16px 0;font-size:15px">
            <strong>${productName}</strong><br>
            ship to:<br>${(shipTo || '(see BuyHalfCow order)').replace(/\n/g, '<br>')}
          </div>
          <p style="font-size:14px;color:#2A2A2A">you net <strong>$${dollars(baseCents)}</strong> — already routed to your Stripe account. pack it, ship it, and reply with the tracking number.</p>
          <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
        </div>`,
        templateName: 'rancher_order_notify',
      }).catch(() => {});
    }
  } catch { /* non-fatal — the operator signal already carries the ship-to */ }
}
