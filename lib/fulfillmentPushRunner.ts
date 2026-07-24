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

// H1(c): "has-been-attempted → skip". Pure guard the runner consults on the
// freshly-read row before pushing. A row that already holds an external order
// id, a 'pushed' stamp, or a reconcile 'cancelled' stamp must NEVER be pushed
// again (a duplicate would still physically ship even though B3 skips it in the
// orders/create webhook). 'pushing' (a prior attempt that never resolved) and
// 'failed:*' stay pushable so a manual repush can recover them; the connector's
// pre-create dedup + idempotency key make that retry safe.
export type PushDisposition = { action: 'push' } | { action: 'skip'; reason: string };

export function decidePushDisposition(order: Record<string, unknown>): PushDisposition {
  if (String(order?.['External Order Id'] || '').trim()) return { action: 'skip', reason: 'already-pushed' };
  const st = String(order?.['External Push Status'] || '').trim();
  if (st === 'pushed') return { action: 'skip', reason: 'already-pushed' };
  if (st === 'cancelled') return { action: 'skip', reason: 'cancelled' };
  return { action: 'push' };
}

// H2: post-push TOCTOU guard (pure). runFulfillmentPush reads the order once and
// gates Status==='New', but the push network window is wide enough for a refund
// to flip Status meanwhile. After a SUCCESSFUL create we re-read Status; if it's
// now terminal we must cancel the live external order instead of stamping it
// 'pushed' — otherwise the rancher ships a refunded box.
export type PostPushAction = { action: 'keep' } | { action: 'cancel'; reason: string };

export function decidePostPushAction(statusAfter: unknown): PostPushAction {
  const s = String(statusAfter || '').trim();
  if (s === 'Refunded' || s === 'Cancelled') return { action: 'cancel', reason: s };
  return { action: 'keep' };
}

export async function runFulfillmentPush(orderRowId: string): Promise<void> {
  try {
    const order = await getRecordById(TABLES.RANCHER_ORDERS, orderRowId);
    if (!order) return;
    // H1(c): belt "has-been-attempted" guard on the fresh row — a row already
    // pushed / holding an external id / reconcile-'cancelled' must never re-push.
    if (decidePushDisposition(order).action === 'skip') return;
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
      // L4: a PAID order that can't push because the product has no External SKU
      // or the order captured no ship address will silently never fulfill. Ring
      // the operator (normal urgency) so the rancher/product data gets fixed;
      // deduped per order+reason so the 2h net cron doesn't re-alarm every run.
      if (gate.reason === 'no-sku' || gate.reason === 'no-address') {
        const { sendOperatorSignal } = await import('./operatorSignal');
        await sendOperatorSignal({
          urgency: 'normal',
          kind: 'system-error',
          summary: `Paid order can't fulfill (${gate.reason}) — ${String(order['Order Ref'] || orderRowId).slice(0, 60)}`,
          detail:
            (gate.reason === 'no-sku'
              ? `The product on this paid order has no 'External SKU', so it can't be injected into the rancher's store.\n`
              : `This paid order captured no ship-to address, so it can't be injected into the rancher's store.\n`) +
            `Fix the ${gate.reason === 'no-sku' ? "product's External SKU" : 'order address'}, then set ` +
            `'Push Retry Requested At' on the order row to re-push.`,
          dedupeKey: `shopify-push-${gate.reason}-${orderRowId}`,
          dedupeWindowMs: 24 * 60 * 60 * 1000,
        }).catch(() => {});
      }
      return;
    }

    // H1(c) DURABLE PRE-STAMP: mark the row 'pushing' BEFORE the network call.
    // If the success stamp is later lost (or the process dies mid-push), the row
    // is non-blank, so the net cron's blank-status filter won't blind re-push a
    // SECOND live order. Reverted to blank on a transient failure (below) so the
    // common retryable case still sweeps. Best-effort: if the pre-stamp write
    // itself fails, the connector's pre-create dedup is the backstop.
    const preStamped = await updateRecord(TABLES.RANCHER_ORDERS, orderRowId, {
      'External Push Status': 'pushing',
    }).then(() => true).catch(() => false);

    // Revert the pre-stamp so the net cron retries — but ONLY if a refund hasn't
    // flipped Status meanwhile (leaving a refunded order blank would let the
    // cron push it; the gate's Status!=='New' check is the backstop either way).
    const revertPreStampIfNew = async () => {
      if (!preStamped) return;
      const fresh = await getRecordById(TABLES.RANCHER_ORDERS, orderRowId).catch(() => null);
      if (String(fresh?.['Status'] || '') === 'New') {
        await updateRecord(TABLES.RANCHER_ORDERS, orderRowId, { 'External Push Status': '' }).catch(() => {});
      }
    };

    let result;
    try {
      result = await getConnector(integration!.provider).pushOrder(integration!, buildPushInput(order, product));
    } catch (pushErr: any) {
      // A THROWN config error is permanent (handled by the outer catch's B1
      // path); re-throw so that single classifier owns it.
      if (classifyThrownPushError(pushErr).kind === 'permanent-config') throw pushErr;
      // Thrown transient (network reject): revert the pre-stamp so the net cron
      // retries. Safe even if Shopify DID create — the pre-create dedup finds it.
      await revertPreStampIfNew();
      console.warn(`[fulfillmentPush] transient throw for ${orderRowId}: ${pushErr?.message}`);
      return;
    }
    if (result.ok) {
      const externalOrderId = result.externalOrderId;
      // H2 POST-PUSH TOCTOU GUARD: a refund/cancel may have flipped Status during
      // the push window. Re-read; if now terminal, cancel the live external order
      // instead of stamping 'pushed' (else a refunded box ships uncancelled).
      const fresh = await getRecordById(TABLES.RANCHER_ORDERS, orderRowId).catch(() => null);
      const post = decidePostPushAction(fresh?.['Status']);
      if (post.action === 'cancel') {
        let cancelOk = false;
        let cancelErr = '';
        try {
          const res = await getConnector(integration!.provider).cancelOrder(
            integration!, externalOrderId,
            `BHC stop-ship — order ${String(order['Order Ref'] || orderRowId)} went ${post.reason} during push`.slice(0, 255),
          );
          cancelOk = res.ok;
          cancelErr = res.error || '';
        } catch (e: any) { cancelErr = e?.message || 'cancel threw'; }
        await updateRecord(TABLES.RANCHER_ORDERS, orderRowId, {
          'External Order Id': externalOrderId,
          'External Push Status': cancelOk ? 'cancelled' : `cancel-failed:${cancelErr}`.slice(0, 250),
          'External Pushed At': new Date().toISOString(),
        }).catch(() => {});
        if (!cancelOk) {
          const { sendOperatorSignal } = await import('./operatorSignal');
          await sendOperatorSignal({
            urgency: 'loud',
            kind: 'system-error',
            summary: `Shopify order shipped a REFUND — cancel FAILED — ${String(order['Order Ref'] || orderRowId).slice(0, 50)}`,
            detail:
              `A live Shopify order (${externalOrderId}) was created for an order that went ${post.reason} ` +
              `during the push, and the auto-cancel FAILED (${cancelErr}). It may still ship. ` +
              `Cancel it manually in the rancher's store now.`,
            dedupeKey: `shopify-postpush-cancel-fail-${orderRowId}`,
            dedupeWindowMs: 24 * 60 * 60 * 1000,
          }).catch(() => {});
        }
        return;
      }
      // Normal success — H1(c): WRAP the success stamp (was a bare write). On a
      // stamp-write failure, persist a non-blank fallback the net cron skips
      // (never blind re-push) AND ring the operator with the external id to
      // reconcile by hand. If even the fallback fails, the pre-stamp 'pushing'
      // still blocks the cron.
      try {
        await updateRecord(TABLES.RANCHER_ORDERS, orderRowId, {
          'External Order Id': externalOrderId,
          'External Push Status': 'pushed',
          'External Pushed At': new Date().toISOString(),
        });
      } catch (stampErr: any) {
        await updateRecord(TABLES.RANCHER_ORDERS, orderRowId, {
          'External Push Status': `pushed-unstamped:${externalOrderId}`.slice(0, 250),
        }).catch(() => {});
        const { sendOperatorSignal } = await import('./operatorSignal');
        await sendOperatorSignal({
          urgency: 'loud',
          kind: 'system-error',
          summary: `Shopify push succeeded but the stamp FAILED — ${String(order['Order Ref'] || orderRowId).slice(0, 50)}`,
          detail:
            `The order pushed to Shopify (external id ${externalOrderId}) but writing 'pushed' back to Airtable ` +
            `failed (${stampErr?.message || 'unknown'}). The row is marked so the net cron will NOT re-push ` +
            `(no double ship). Confirm the external order id on the row and clear the marker once reconciled.`,
          dedupeKey: `shopify-push-stamp-fail-${orderRowId}`,
          dedupeWindowMs: 24 * 60 * 60 * 1000,
        }).catch(() => {});
      }
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
          `(SKU/token/scopes), then set 'Push Retry Requested At' on the order row to re-push ` +
          `(the manual-repush path re-pushes regardless of the order's age).`,
        dedupeKey: `shopify-push-fail-${orderRowId}`,
        dedupeWindowMs: 24 * 60 * 60 * 1000,
      }).catch(() => {});
      return;
    }
    // Transient (throttle/5xx/network): revert the pre-stamp to blank so the net
    // cron retries the common case.
    await revertPreStampIfNew();
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
            `then set 'Push Retry Requested At' on the stuck 'failed:config' orders to re-push them ` +
            `(the manual-repush path re-pushes regardless of the order's age).`,
          dedupeKey: 'shopify-push-config-fail',
          dedupeWindowMs: 60 * 60 * 1000,
        });
      } catch { /* best-effort — alerting never crashes the runner */ }
      return;
    }
    console.error('[fulfillmentPush] error:', e?.message);
  }
}
