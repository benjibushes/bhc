// app/api/cron/product-fulfillment-sla/route.ts
//
// FULFILLMENT SLA CHASE (backlog #112 / checkout audit 2026-07-14): a PAID
// product order stuck in Status='New' now gets chased instead of silently
// aging. Nudge the rancher (one email ever, stamped 'SLA Nudged At'), then
// escalate to the operator (Telegram, re-screams every 48h via dedupe window
// until someone acts). Selection logic is pure + tested in
// lib/productFulfillmentSla.ts.
//
// SHOP-CHAIN AUDIT (2026-08-01), two changes:
//   1. the windows ride the ranch's OWN 'Ships In Days' promise when it has
//      one (flat 3/6 only as the fallback) — a 1-day promise is chased on
//      day 2, a 14-day promise is left alone until day 15;
//   2. at the escalate threshold the BUYER finally gets told. Their money was
//      the only thing standing still and we were mailing everyone but them.
//      One note per order ever, claim-before-send with read-back verify.

import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
// The day-thresholds are no longer quoted from constants here: slaWindowFor
// returns the windows this specific order was judged against (which now ride
// the ranch's own 'Ships In Days' promise when it has one).
import { slaDecisions, slaWindowFor } from '@/lib/productFulfillmentSla';
import { selectStalePushedOrders, PUSHED_STALE_HOURS } from '@/lib/fulfillmentWebhookHealth';
import { sendEmail } from '@/lib/email';
import { sendBuyerOrderDelayNotice } from '@/lib/emailMinimal';
import { orderStatusUrlFor } from '@/lib/orderStatusLink';
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

// B2(b): "pushed but never fulfilled" webhook-health check. A pushed order that
// never got its fulfillments/* tracking webhook back sits at Status='New' with
// External Push Status='pushed' FOREVER — and the SLA loop below deliberately
// skips pushed orders, so it's invisible. This is a BHC-side webhook problem
// (registration failed, or the store's webhook is dead), NOT a rancher who
// forgot to ship, so we ring the OPERATOR, never nag the rancher. Fires ONCE
// per order (marker: 'SLA Nudged At', which the SLA loop never touches on
// pushed orders). Fully isolated: its own try/catch, so a failure here can
// never break the rancher-facing SLA chase that is this cron's real job.
async function alertStalePushedOrders(newOrders: any[]): Promise<{ alerted: number; note: string }> {
  try {
    const pushed = newOrders.filter((o) => String(o['External Push Status'] || '') === 'pushed');
    const stuck = selectStalePushedOrders(
      pushed.map((o) => ({
        id: o.id,
        status: String(o['Status'] || ''),
        externalPushStatus: String(o['External Push Status'] || ''),
        externalPushedAt: String(o['External Pushed At'] || ''),
        slaNudgedAt: String(o['SLA Nudged At'] || ''),
      })),
      new Date().toISOString(),
    );
    if (stuck.length === 0) return { alerted: 0, note: '' };

    const byId = new Map(newOrders.map((o) => [o.id, o]));
    let alerted = 0;
    for (const s of stuck) {
      const order: any = byId.get(s.id);
      if (!order) continue;
      const product = String(order['Product Name'] || 'a product');
      const rancherName = String(order['Rancher Name'] || 'the ranch');
      const ageDays = Math.floor(s.ageHours / 24);
      try {
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'system-error',
          summary: `PUSHED but NO TRACKING ${ageDays}d: ${product} (${rancherName})`,
          detail:
            `This order pushed into ${rancherName}'s Shopify ${s.ageHours}h ago (External Push Status='pushed') ` +
            `but the fulfillments/* tracking webhook never came back — it's still 'New' with no tracking. ` +
            `The store's webhook is likely dead (registration failed at connect, or app reinstalled). ` +
            `Re-run the connect for this rancher to re-register webhooks, or check the order shipped in their store and mark it Shipped by hand. ` +
            `(BHC-side webhook health — the rancher is NOT at fault; do not nudge them.)`,
          dedupeKey: `fulfillment-webhook-stuck:${s.id}`,
          dedupeWindowMs: 7 * 24 * 60 * 60 * 1000,
        });
        // Stamp the "alerted once" marker (reused 'SLA Nudged At' — safe on
        // pushed orders, see fulfillmentWebhookHealth.ts).
        await updateRecord(TABLES.RANCHER_ORDERS, s.id, { 'SLA Nudged At': new Date().toISOString() });
        alerted += 1;
      } catch (e: any) {
        console.error('[product-fulfillment-sla] webhook-health alert failed:', e?.message);
      }
    }
    return { alerted, note: `; ${alerted} pushed-but-stuck alerted (>${PUSHED_STALE_HOURS}h no tracking)` };
  } catch (e: any) {
    console.error('[product-fulfillment-sla] webhook-health check skipped (non-fatal):', e?.message);
    return { alerted: 0, note: '' };
  }
}

// ── THE RANCHER'S OWN SHIP PROMISE (shop-chain audit 2026-08-01) ────────────
// 'Ships In Days' lives on the PRODUCT, not the order, so the cron has to go
// get it. Bounded on purpose: an order younger than the tightest possible
// window (a 1-day promise + 1 grace day = 2) can never fire under ANY window,
// so only orders at least that old need a lookup — which in practice is the
// handful of genuinely-aging orders, not every open order on the platform.
// Any miss degrades to the flat 3/6 rail, exactly as before this change.
const PROMISE_LOOKUP_MIN_AGE_DAYS = 2;
const PROMISE_LOOKUP_CAP = 60;

async function loadShipPromises(orders: any[], nowMs: number): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const ids = new Set<string>();
    for (const o of orders) {
      const ordered = Date.parse(String(o['Ordered At'] || ''));
      if (Number.isNaN(ordered)) continue;
      if ((nowMs - ordered) / 86400000 < PROMISE_LOOKUP_MIN_AGE_DAYS) continue;
      const pid = String(o['Product Record ID'] || '').trim();
      if (pid) ids.add(pid);
      if (ids.size >= PROMISE_LOOKUP_CAP) break;
    }
    for (const pid of ids) {
      const prod: any = await getRecordById(TABLES.RANCHER_PRODUCTS, pid).catch(() => null);
      const days = Number(prod?.['Ships In Days']);
      if (Number.isFinite(days) && days > 0) map.set(pid, days);
    }
  } catch (e: any) {
    console.warn('[product-fulfillment-sla] ship-promise lookup skipped (flat windows):', e?.message);
  }
  return map;
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

  // B2(b): run the pushed-but-stuck webhook-health check on the SAME fetched set
  // (no extra query). Isolated + non-fatal — must run regardless of whether the
  // rancher-facing SLA chase has any work below (hence before the early return).
  const health = await alertStalePushedOrders(newOrders as any[]);
  const nowIso = new Date().toISOString();
  const promises = unpushed.length > 0 ? await loadShipPromises(unpushed, Date.parse(nowIso)) : new Map();
  const decisions = slaDecisions(
    unpushed.map((o) => ({
      id: o.id,
      status: String(o['Status'] || ''),
      orderedAt: String(o['Ordered At'] || ''),
      slaNudgedAt: String(o['SLA Nudged At'] || ''),
      // Wave C: the DEPOSIT/PICKUP markers live only in Order Ref — without
      // it the cron told ranchers to SHIP deposit-style orders on day 3.
      orderRef: String(o['Order Ref'] || ''),
      // The promise the buyer was quoted at checkout; absent ⇒ flat windows.
      promisedShipDays: promises.get(String(o['Product Record ID'] || '').trim()) ?? null,
      // One buyer "we're on it" note per order, ever.
      buyerNotifiedAt: String(o['Buyer Delay Notified At'] || ''),
    })),
    nowIso,
  );

  if (decisions.length === 0) {
    return { status: 'success', recordsTouched: health.alerted, notes: `0 stale of ${newOrders.length} New${health.note}` };
  }

  const byId = new Map((newOrders as any[]).map((o) => [o.id, o]));
  let nudged = 0;
  let escalated = 0;
  let buyersTold = 0;
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
        // Quote the windows this order was ACTUALLY judged against — a flat
        // "escalate @6d" on an order riding a 14-day promise reads like a bug.
        const w = slaWindowFor(
          d.kind,
          promises.get(String(order['Product Record ID'] || '').trim()) ?? null,
        );
        const windowNote = `SLA: nudge @${w.nudgeDays}d, escalate @${w.escalateDays}d${w.fromPromise ? ' (from the ranch’s own Ships In Days promise)' : ''}`;
        const summary =
          d.kind === 'deposit'
            ? `STALLED DEPOSIT ${d.ageDays}d: ${product} (${rancherName})`
            : d.kind === 'pickup'
              ? `STALLED PICKUP ${d.ageDays}d: ${product} (${rancherName})`
              : `UNSHIPPED ${d.ageDays}d: ${product} (${rancherName})`;
        const detail =
          d.kind === 'deposit'
            ? `${buyer} put a deposit on ${product} ${d.ageDays} days ago and the size/balance confirm still hasn't happened ` +
              `(${windowNote}). Nudge the rancher to call the buyer.`
            : d.kind === 'pickup'
              ? `${buyer} paid for ${product} ${d.ageDays} days ago and the pickup still isn't done/scheduled ` +
                `(${windowNote}). Nudge the rancher to set a pickup time.`
              : `${buyer} paid for ${product} ${d.ageDays} days ago; ${rancherName} still hasn't marked it Shipped ` +
                `(${windowNote}). Call the rancher or refund the buyer — ` +
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

      // ── TELL THE BUYER (shop-chain audit 2026-08-01) ─────────────────────
      // Until now this whole loop nudged the rancher and rang the operator
      // while the person whose money was sitting still heard nothing.
      //
      // CLAIM-BEFORE-SEND WITH READ-BACK (same rail as product-review-ask):
      // stamp 'Buyer Delay Notified At', re-read the row, and only send if
      // the stamp actually persisted. This is what makes the template safe on
      // the transactional whitelist — a failed write, or the field not
      // existing yet, yields ZERO mails rather than one every single run.
      // Isolated try/catch: this can never break the escalation above.
      if (d.notifyBuyer) {
        const buyerEmail = String(order['Buyer Email'] || '').trim();
        if (buyerEmail) {
          try {
            const stampedAt = new Date().toISOString();
            await updateRecord(TABLES.RANCHER_ORDERS, d.id, { 'Buyer Delay Notified At': stampedAt });
            const readBack: any = await getRecordById(TABLES.RANCHER_ORDERS, d.id).catch(() => null);
            if (!readBack || !String(readBack['Buyer Delay Notified At'] || '').trim()) {
              // Could not prove the one-shot throttle persisted → do NOT send.
              console.warn('[product-fulfillment-sla] buyer delay stamp did not persist — mail suppressed:', d.id);
              errors.push(`${d.id}: buyer-notice suppressed (stamp unverified)`);
            } else {
              await sendBuyerOrderDelayNotice({
                buyerEmail,
                buyerName: String(order['Buyer Name'] || ''),
                productName: product,
                rancherName,
                ageDays: d.ageDays,
                kind: d.kind,
                orderStatusUrl: orderStatusUrlFor(d.id),
              });
              buyersTold += 1;
            }
          } catch (e: any) {
            errors.push(`${d.id}: buyer notice failed (${e?.message || 'unknown'})`);
          }
        }
      }
    }
  }

  const notes =
    `${newOrders.length} New, ${decisions.length} stale → ${nudged} nudged, ${escalated} escalated, ${buyersTold} buyers told` +
    health.note +
    (errors.length ? `; ${errors.length} errors: ${errors.slice(0, 3).join(' | ')}` : '');
  return {
    status: errors.length > 0 ? 'partial' : 'success',
    recordsTouched: nudged + buyersTold,
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
