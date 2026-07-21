// app/api/cron/product-fulfillment-sla/route.ts
//
// FULFILLMENT SLA CHASE (backlog #112 / checkout audit 2026-07-14): a PAID
// product order stuck in Status='New' now gets chased instead of silently
// aging. Day 3+: nudge the rancher (one email ever, stamped 'SLA Nudged At').
// Day 6+: escalate to the operator (Telegram, re-screams every 48h via
// dedupe window until someone acts). Selection logic is pure + tested in
// lib/productFulfillmentSla.ts.

import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { slaDecisions, NUDGE_DAYS, ESCALATE_DAYS, SLOW_NUDGE_DAYS, SLOW_ESCALATE_DAYS } from '@/lib/productFulfillmentSla';
import { sendEmail } from '@/lib/email';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';

export const maxDuration = 120;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

interface SlaResult {
  status: 'success' | 'partial' | 'error';
  recordsTouched: number;
  notes: string;
}

async function realHandler(_request: Request): Promise<SlaResult> {
  const newOrders = await getAllRecords(TABLES.RANCHER_ORDERS, `{Status} = 'New'`);
  // Connector-pushed orders are Shopify's to fulfill (GTM audit 2026-07-21):
  // the store fulfills on its own SLA and the reverse webhook stamps Shipped
  // — nudging the rancher to "ship" an order Printify is already printing is
  // pure noise, and the day-6 escalation reads like an accusation.
  const unpushed = (newOrders as any[]).filter(
    (o) => String(o['External Push Status'] || '') !== 'pushed',
  );
  const decisions = slaDecisions(
    unpushed.map((o) => ({
      id: o.id,
      status: String(o['Status'] || ''),
      orderedAt: String(o['Ordered At'] || ''),
      slaNudgedAt: String(o['SLA Nudged At'] || ''),
      // Wave C: the DEPOSIT/PICKUP markers live only in Order Ref — without
      // it the cron told ranchers to SHIP deposit-style orders on day 3.
      orderRef: String(o['Order Ref'] || ''),
    })),
    new Date().toISOString(),
  );

  if (decisions.length === 0) {
    return { status: 'success', recordsTouched: 0, notes: `0 stale of ${newOrders.length} New` };
  }

  const byId = new Map((newOrders as any[]).map((o) => [o.id, o]));
  let nudged = 0;
  let escalated = 0;
  const errors: string[] = [];

  for (const d of decisions) {
    const order: any = byId.get(d.id);
    if (!order) continue;
    const product = String(order['Product Name'] || 'a product');
    const buyer = String(order['Buyer Name'] || order['Buyer Email'] || 'a buyer');
    const rancherName = String(order['Rancher Name'] || 'the ranch');

    if (d.action === 'nudge') {
      try {
        const rancherId = String(order['Rancher Record ID'] || '').trim();
        const rancher: any = rancherId
          ? await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null)
          : null;
        const to = String(rancher?.['Email'] || '').trim();
        if (!to) {
          errors.push(`${d.id}: no rancher email`);
          continue;
        }
        // Wave C — kind-specific copy. A deposit order must NEVER be told to
        // "ship it" (the settle email said the opposite); a pickup order's
        // next step is setting the pickup time, not tracking numbers.
        const nudge =
          d.kind === 'deposit'
            ? {
                subject: `⏰ ${buyer}'s ${product} deposit is waiting on you`,
                headline: `quick heads up — <strong>${buyer}</strong> put a deposit down on <strong>${product}</strong> ${d.ageDays} days ago and it's still sitting untouched.`,
                body: `Reach out to confirm their size and settle the remaining balance — do NOT ship anything yet. Their contact info is on the order:`,
                footer: `Already talked to them? Great — once the balance settles the order moves along on its own. Problem with the order? Reply here — a real person reads it.`,
              }
            : d.kind === 'pickup'
              ? {
                  subject: `⏰ ${buyer}'s ${product} pickup still isn't scheduled`,
                  headline: `quick heads up — <strong>${buyer}</strong> paid for <strong>${product}</strong> ${d.ageDays} days ago and the order is still marked New.`,
                  body: `They're picking this one up — reach out and set the pickup time, then mark the order complete once they've come by:`,
                  footer: `Already handed it over? Just mark it complete so our records match. Problem with the order? Reply here — a real person reads it.`,
                }
              : {
                  subject: `⏰ ${buyer}'s ${product} order is waiting to ship`,
                  headline: `quick heads up — <strong>${buyer}</strong> paid for <strong>${product}</strong> ${d.ageDays} days ago and the order is still marked New.`,
                  body: `They're expecting it. When it ships, add the tracking number in your dashboard and we'll tell them automatically:`,
                  footer: `Already shipped it? Just mark it Shipped so the buyer gets their tracking. Problem with the order? Reply here — a real person reads it.`,
                };
        await sendEmail({
          to,
          subject: nudge.subject,
          templateName: 'product_sla_nudge',
          html: `
            <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#26251E;">
              <p style="font-size:19px;">${nudge.headline}</p>
              <p style="font-size:15px;line-height:1.6;">${nudge.body}</p>
              <p><a href="${SITE_URL}/rancher#products" style="display:inline-block;background:#26251E;color:#F4F0E7;padding:12px 22px;text-decoration:none;border-radius:2px;">Open your orders &rarr;</a></p>
              <p style="font-size:14px;color:#6B5D4A;">${nudge.footer}</p>
            </div>`,
        });
        await updateRecord(TABLES.RANCHER_ORDERS, d.id, { 'SLA Nudged At': new Date().toISOString() });
        nudged += 1;
      } catch (e: any) {
        errors.push(`${d.id}: nudge failed (${e?.message || 'unknown'})`);
      }
    } else {
      // Escalation re-screams every 48h until the order leaves 'New'.
      // Wave C: deposit/pickup escalations say "stalled", never "chargeback
      // forming" — those orders dwell in New by design and crying wolf
      // trains ops to ignore the one alarm that matters.
      try {
        const summary =
          d.kind === 'deposit'
            ? `STALLED DEPOSIT ${d.ageDays}d: ${product} (${rancherName})`
            : d.kind === 'pickup'
              ? `STALLED PICKUP ${d.ageDays}d: ${product} (${rancherName})`
              : `UNSHIPPED ${d.ageDays}d: ${product} (${rancherName})`;
        const detail =
          d.kind === 'deposit'
            ? `${buyer} put a deposit on ${product} ${d.ageDays} days ago and the size/balance confirm still hasn't happened ` +
              `(deposit SLA: nudge @${SLOW_NUDGE_DAYS}d, escalate @${SLOW_ESCALATE_DAYS}d). Nudge the rancher to call the buyer.`
            : d.kind === 'pickup'
              ? `${buyer} paid for ${product} ${d.ageDays} days ago and the pickup still isn't done/scheduled ` +
                `(pickup SLA: nudge @${SLOW_NUDGE_DAYS}d, escalate @${SLOW_ESCALATE_DAYS}d). Nudge the rancher to set a pickup time.`
              : `${buyer} paid for ${product} ${d.ageDays} days ago; ${rancherName} still hasn't marked it Shipped ` +
                `(SLA: nudge @${NUDGE_DAYS}d, escalate @${ESCALATE_DAYS}d). Call the rancher or refund the buyer — ` +
                `a paid order this old is a chargeback forming.`;
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'system-error',
          summary,
          detail,
          dedupeKey: `product-sla-escalate:${d.id}`,
          dedupeWindowMs: 48 * 60 * 60 * 1000,
        });
        escalated += 1;
      } catch (e: any) {
        errors.push(`${d.id}: escalate failed (${e?.message || 'unknown'})`);
      }
    }
  }

  const notes =
    `${newOrders.length} New, ${decisions.length} stale → ${nudged} nudged, ${escalated} escalated` +
    (errors.length ? `; ${errors.length} errors: ${errors.slice(0, 3).join(' | ')}` : '');
  return {
    status: errors.length > 0 ? 'partial' : 'success',
    recordsTouched: nudged,
    notes,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('product-fulfillment-sla', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
