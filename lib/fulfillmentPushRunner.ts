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
import { isIntegrationConfigError } from './integrationCrypto';

// Pure classification of an error THROWN out of the push attempt (as opposed to
// a returned PushResult). A config-class crypto error (missing/rotated
// INTEGRATION_TOKEN_KEY, undecryptable token) is PERMANENT — it fails on every
// retry, so leaving 'External Push Status' blank makes the net cron retry every
// 2h forever with no alert (B1: the fulfillment loop dies invisibly). Anything
// else thrown here (Airtable read failure, fetch network reject) is TRANSIENT
// and must stay retryable. A Shopify 4xx/5xx is a returned PushResult, not a
// throw, so it never reaches this classifier — classifyGqlErrors owns that.
export type ThrownPushOutcome =
  | { kind: 'permanent-config'; stampStatus: 'failed:config' }
  | { kind: 'transient' };

export function classifyThrownPushError(e: unknown): ThrownPushOutcome {
  if (isIntegrationConfigError(e)) return { kind: 'permanent-config', stampStatus: 'failed:config' };
  return { kind: 'transient' };
}

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
    // B1: a THROWN config/crypto error (rotated/missing INTEGRATION_TOKEN_KEY,
    // undecryptable token) is PERMANENT — stamp it so the net cron stops the
    // silent every-2h retry, and ring the operator LOUD. The cause is a
    // platform-global env var, not this one order, so the alert dedupes on a
    // GLOBAL key (all orders in a run collapse to one alarm, re-screams hourly
    // until the key is restored).
    if (classifyThrownPushError(e).kind === 'permanent-config') {
      await updateRecord(TABLES.RANCHER_ORDERS, orderRowId, {
        'External Push Status': 'failed:config',
      }).catch(() => {});
      try {
        const { sendOperatorSignal } = await import('./operatorSignal');
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'system-error',
          summary: 'Shopify push failed: INTEGRATION_TOKEN_KEY missing/invalid — fulfillment is DOWN',
          detail:
            `${e?.message || 'integration crypto error'}\n` +
            `Every connected store's order push throws on decrypt — paid orders will NOT auto-fulfill. ` +
            `Restore INTEGRATION_TOKEN_KEY in Vercel (32-byte base64, must match what encrypted the tokens), ` +
            `then clear 'External Push Status' on the stuck 'failed:config' orders to retry.`,
          dedupeKey: 'shopify-push-config-fail',
          dedupeWindowMs: 60 * 60 * 1000,
        });
      } catch { /* best-effort — alerting never crashes the runner */ }
      return;
    }
    console.error('[fulfillmentPush] error:', e?.message);
  }
}
