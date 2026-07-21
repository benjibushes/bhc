// One idempotent push attempt for one settled Rancher Orders row. Loads
// rancher + product, runs the pure gate, calls the connector, and stamps
// the outcome on the ROW (rule 2: money-path truth persisted, not logged):
//   External Push Status: 'pushed' | 'skipped:<reason>' | 'failed:<error>'
//   External Order Id / External Pushed At on success.
// Never throws. Transient failures leave the status BLANK so the
// fulfillment-push-net cron retries; permanent ones stamp failed:* + ring
// the operator (a paid order that will NOT auto-fulfill needs a human).

import { getRecordById, updateRecord, TABLES } from './airtable';
import { parseIntegration, getConnector } from './fulfillmentConnector';
import { selectPushableOrder, buildPushInput } from './fulfillmentPush';

export async function runFulfillmentPush(orderRowId: string): Promise<void> {
  try {
    const order = await getRecordById(TABLES.RANCHER_ORDERS, orderRowId);
    if (!order) return;
    const rancher = order['Rancher Record ID']
      ? await getRecordById(TABLES.RANCHERS, String(order['Rancher Record ID'])).catch(() => null)
      : null;
    const product = order['Product Record ID']
      ? await getRecordById(TABLES.RANCHER_PRODUCTS, String(order['Product Record ID'])).catch(() => null)
      : null;
    const integration = parseIntegration(rancher?.['Fulfillment Integration']);
    const gate = selectPushableOrder({ order, product, integration });
    if (!gate.ok) {
      // Stamp terminal skips so the net cron stops re-inspecting them — but
      // leave 'no-integration' UNSTAMPED: Ben may connect the store later and
      // the sweep should then pick these up (3-day window).
      if (gate.reason !== 'no-integration' && !String(order['External Push Status'] || '').trim()) {
        await updateRecord(TABLES.RANCHER_ORDERS, orderRowId, {
          'External Push Status': `skipped:${gate.reason}`,
        }).catch(() => {});
      }
      return;
    }

    const result = await getConnector(integration!.provider).pushOrder(integration!, buildPushInput(order, product));
    if (result.ok) {
      await updateRecord(TABLES.RANCHER_ORDERS, orderRowId, {
        'External Order Id': result.externalOrderId,
        'External Push Status': 'pushed',
        'External Pushed At': new Date().toISOString(),
      });
      return;
    }
    if (result.permanent) {
      await updateRecord(TABLES.RANCHER_ORDERS, orderRowId, {
        'External Push Status': `failed:${result.error}`.slice(0, 250),
      }).catch(() => {});
      const { sendOperatorSignal } = await import('./operatorSignal');
      await sendOperatorSignal({
        urgency: 'loud',
        kind: 'system-error',
        summary: `Shopify push FAILED — order ${String(order['Order Ref'] || orderRowId).slice(0, 60)}`,
        detail:
          `${result.error}\n` +
          `The order will NOT auto-fulfill in the rancher's store. Fix the cause ` +
          `(SKU/token/scopes), then clear 'External Push Status' on the order row to retry.`,
        dedupeKey: `shopify-push-fail-${orderRowId}`,
        dedupeWindowMs: 24 * 60 * 60 * 1000,
      }).catch(() => {});
      return;
    }
    // Transient (throttle/5xx/network): leave unstamped — net cron retries.
    console.warn(`[fulfillmentPush] transient failure for ${orderRowId}: ${result.error}`);
  } catch (e: any) {
    console.error('[fulfillmentPush] error:', e?.message);
  }
}
