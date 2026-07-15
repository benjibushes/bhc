// app/api/rancher/orders/route.ts
//
// Rancher product-ORDER management (Phase 10 unison loop). Until now a
// marketplace order reached the rancher as ONE email and then vanished — no
// dashboard surface, no mark-shipped, no tracking back to the buyer. This
// closes the loop:
//   GET  → my product orders (Rancher Orders rows owned by me), newest first
//   POST → mark shipped: { orderId, trackingNumber? } → Status 'Shipped' +
//          Shipped At + Tracking Number, and the BUYER gets the tracking
//          email automatically (the promise "you'll get tracking" in the
//          receipt finally has a sender).
//
// Auth = requireRancher; ownership = the order row's 'Rancher Record ID'
// (stamped by settlement) must equal the session rancher. Money fields are
// read-only here — this route never touches amounts, Stripe, or settlement.

import { NextResponse } from 'next/server';
import { requireRancher } from '@/lib/rancherAuth';
import { getAllRecords, getRecordById, updateRecord, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { claimOnce } from '@/lib/rancherCapacity';
import { sendEmail } from '@/lib/email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ownerOf = (row: any) => String(row?.['Rancher Record ID'] || '').trim();

// Same minimal escaper the settlement emails use — every interpolated string
// below is HTML-escaped (buyer name, product, ranch, tracking).
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toClientOrder(r: any) {
  const ref = String(r['Order Ref'] || '');
  return {
    id: r.id,
    ref,
    productName: String(r['Product Name'] || ''),
    buyerName: String(r['Buyer Name'] || ''),
    buyerEmail: String(r['Buyer Email'] || ''),
    shipTo: String(r['Ship To Address'] || ''),
    buyerPaid: Number(r['Buyer Paid'] || 0),
    payout: Number(r['Rancher Payout'] || 0),
    status: String(r['Status'] || 'New'),
    orderedAt: String(r['Ordered At'] || ''),
    shippedAt: String(r['Shipped At'] || ''),
    trackingNumber: String(r['Tracking Number'] || ''),
    // Deposit-style orders carry the marker settlement stamped into the ref —
    // the UI must say "confirm details first", never "ship it".
    depositStyle: ref.startsWith('DEPOSIT — '),
    // Wave C (2026-07-14): pickup orders carry their own marker — the UI must
    // say "mark picked up" (no tracking) and the buyer email must say
    // picked-up, never "just shipped + you'll get tracking". .includes
    // because the markers compound ('DEPOSIT — PICKUP — ').
    pickup: ref.includes('PICKUP — '),
  };
}

export async function GET(request: Request) {
  const r = await requireRancher(request);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  // Scale audit 2026-07-07: server-side filter on the plain-text owner key —
  // O(this rancher's orders), not O(all orders platform-wide). Rancher Orders
  // grows 1:1 with ad-driven product sales; the full scan burned the shared
  // 5 req/s Airtable budget on every Products-tab open. JS belt stays.
  //
  // FALSE-EMPTY FIX (Wave A 2026-07-14, mirror of the #374 inbox fix): the
  // old `.catch(() => [])` converted an Airtable outage into 200-empty — a
  // rancher clicking through the SLA nudge during a blip saw "no orders" and
  // concluded there was nothing to ship. Fail loud so the client can render
  // a retry instead of a lie.
  let raw: any[];
  try {
    raw = (await getAllRecords(
      TABLES.RANCHER_ORDERS,
      `{Rancher Record ID} = "${escapeAirtableValue(session.rancherId)}"`,
    )) as any[];
  } catch (e: any) {
    console.error('[rancher/orders] GET Airtable read failed:', e?.message);
    return NextResponse.json(
      { error: 'could not load your orders — refresh in a minute.' },
      { status: 502 },
    );
  }
  const rows = raw
    .filter((row) => ownerOf(row) === session.rancherId)
    .map(toClientOrder)
    .sort((a, b) => (b.orderedAt || '').localeCompare(a.orderedAt || ''));

  return NextResponse.json({ orders: rows });
}

export async function POST(request: Request) {
  const r = await requireRancher(request);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const orderId = String(body?.orderId || '').trim();
  const trackingNumber = String(body?.trackingNumber || '').trim().slice(0, 120);
  if (!/^rec[A-Za-z0-9]{14}$/.test(orderId)) {
    return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });
  }

  const order: any = await getRecordById(TABLES.RANCHER_ORDERS, orderId).catch(() => null);
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  if (ownerOf(order) !== session.rancherId) {
    return NextResponse.json({ error: 'This order does not belong to you.' }, { status: 403 });
  }
  const status = String(order['Status'] || 'New');
  if (status === 'Refunded') {
    return NextResponse.json({ error: 'This order was refunded — nothing to ship.' }, { status: 409 });
  }
  if (status === 'Shipped') {
    return NextResponse.json({ error: 'Already marked shipped.' }, { status: 409 });
  }

  // GTM-hardening (TOCTOU): a double-click fires two concurrent POSTs that
  // both read Status='New' before either writes — claim-before-send (same
  // rail the crons use; fails open if Redis is down, where the status guard
  // above still catches sequential retries).
  if (!(await claimOnce(`order-ship:${orderId}`, 60))) {
    return NextResponse.json({ error: 'Already in flight — give it a second.' }, { status: 409 });
  }

  // Wave C: a pickup order has no tracking — the buyer already drove (or is
  // driving) out. Writing a tracking number + sending "just shipped, you'll
  // get tracking" read like a duplicate order to a buyer who's already home
  // with the beef. Same parsing as toClientOrder.
  const isPickup = String(order['Order Ref'] || '').includes('PICKUP — ');

  await updateRecord(TABLES.RANCHER_ORDERS, orderId, {
    Status: 'Shipped',
    'Shipped At': new Date().toISOString(),
    ...(trackingNumber && !isPickup ? { 'Tracking Number': trackingNumber } : {}),
  });

  // The buyer email the receipt promised — tracking for shipped orders, a
  // picked-up note for pickups. Transactional (both templateNames whitelisted
  // in emailFrequencyGuard) — best-effort, never blocks the status update.
  const buyerEmail = String(order['Buyer Email'] || '').trim();
  const buyerFirst = escapeHtml(String(order['Buyer Name'] || '').trim().split(/\s+/)[0] || 'there');
  const productName = escapeHtml(String(order['Product Name'] || 'your order'));
  const ranchName = escapeHtml(String(order['Rancher Name'] || session.ranchName || 'the ranch'));
  const trackingSafe = escapeHtml(trackingNumber);
  if (buyerEmail) {
    await sendEmail({
      to: buyerEmail,
      subject: isPickup
        ? `all set — ${String(order['Product Name'] || 'your order')}`
        : `on the way — ${String(order['Product Name'] || 'your order')}`,
      html: isPickup
        ? `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
        <p>hey ${buyerFirst},</p>
        <p>hope the pickup went smooth — your <strong>${productName}</strong> order with <strong>${ranchName}</strong> is complete.</p>
        <p style="font-size:14px;color:#5A5752">if anything's off with your order, we make it right — just reply to this email.</p>
        <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
      </div>`
        : `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
        <p>hey ${buyerFirst},</p>
        <p>your <strong>${productName}</strong> just shipped from <strong>${ranchName}</strong>.</p>
        ${trackingSafe ? `<p style="font-size:14px;color:#2A2A2A">tracking: <strong>${trackingSafe}</strong></p>` : ''}
        <p style="font-size:14px;color:#5A5752">if anything shows up wrong or freezer-burned, we make it right — just reply to this email.</p>
        <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow</p>
      </div>`,
      templateName: isPickup ? 'product_picked_up' : 'product_shipped',
    }).catch(() => {});
  }

  const fresh: any = await getRecordById(TABLES.RANCHER_ORDERS, orderId).catch(() => null);
  return NextResponse.json({ order: fresh ? toClientOrder(fresh) : { id: orderId, status: 'Shipped' } });
}
