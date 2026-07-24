// Validates + persists a rancher's Shopify connection, registers the
// fulfillment webhooks, and (sync mode) reports what a catalog import would
// do. Called from the /connectstore Telegram command — kept here so the
// telegram route stays thin and this is unit-reachable.
//
// Credentials arrive plaintext ONCE (Ben pastes them), are encrypted
// immediately, and only ciphertext is persisted. The reply reminds Ben to
// clear the chat message.

import { encryptSecret, decryptSecret } from './integrationCrypto';
import { parseIntegration, getConnector, type IntegrationConfig } from './fulfillmentConnector';
import { updateRecord, TABLES } from './airtable';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

const WEBHOOK_SUB = `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
    webhookSubscription { id }
    userErrors { message }
  }
}`;

export interface ConnectStoreInput {
  rancherId: string;
  shop: string;
  token: string;
  apiSecret: string;
  mode: 'sync' | 'manual';
  markupPercent: number | null;
  category?: string | null;
  /**
   * Which door the connect came through. The OAuth callback already sends its
   * own "Store INSTALLED" ping after this returns, so it passes 'oauth' to opt
   * OUT of the clean-connect ping below (avoids a double notification). The
   * live token-paste doors (Telegram /connectstore, rancher dashboard) leave
   * this undefined → they GET the ping, which is the supply-stall fix: nobody
   * was told a catalog was sitting unapproved (batch F, audit #9).
   */
  source?: 'oauth' | 'token-paste';
}

// Per-topic consequence copy for the webhook-registration-failure alert.
// Broadened (batch F, audit #14) from #468's fulfillment+orders-only version:
// ANY topic that fails to register (except a benign "already exists" on a
// re-connect) now names itself AND the concrete breakage it causes, so a lone
// APP_UNINSTALLED or PRODUCTS_* failure is no longer silent.
const WEBHOOK_FAILURE_CONSEQUENCE: Record<string, string> = {
  FULFILLMENTS_CREATE:
    "tracking will NOT flow back — orders stay New forever and the SLA loop can't see them",
  FULFILLMENTS_UPDATE:
    'tracking updates will NOT flow back — shipment status on live orders goes stale',
  ORDERS_CREATE:
    'direct sales on their store will NOT decrement BHC stock in real time — oversell risk until the 6h catalog cron',
  APP_UNINSTALLED:
    'no real-time uninstall backstop — if they remove the app, synced listings can stay live on /shop with a dead fulfillment rail (shop/redact lags ~48h and NEVER fires for custom-app installs)',
  PRODUCTS_UPDATE:
    'price/stock edits on their store will NOT sync in real time — /shop can show a stale price or oversell until the catalog cron reconciles',
  PRODUCTS_DELETE:
    'products deleted on their store will NOT be pulled off /shop in real time — risk of selling a deleted product until the catalog cron reconciles',
};

// Turn ["ORDERS_CREATE: throttled", "APP_UNINSTALLED: scope"] into a named,
// consequence-annotated block for the operator alert. Exported for tests.
export function describeWebhookFailures(webhookFailures: string[]): string {
  return webhookFailures
    .map((f) => {
      const topic = f.split(':')[0].trim();
      const consequence =
        WEBHOOK_FAILURE_CONSEQUENCE[topic] || `real-time ${topic} events will not reach BHC`;
      return `• ${topic} — ${consequence}`;
    })
    .join('\n');
}

export async function connectShopifyStore(input: ConnectStoreInput): Promise<{ ok: boolean; report: string[] }> {
  // Markup preservation (audit open-item close, 2026-07-21): a re-connect
  // that omits markup must NOT silently wipe a stored markup — sync would
  // quietly stop repricing. Inherit the existing value; an explicit number
  // always wins.
  let markupPercent = input.markupPercent;
  let category = input.category || null;
  // Captured for the clean-connect operator ping below; reused if the markup
  // inherit already fetched the row so we don't double-read Airtable.
  let rancherName: string | null = null;
  if (markupPercent == null || !category) {
    try {
      const { getRecordById, TABLES: T } = await import('./airtable');
      const existingRow: any = await getRecordById(T.RANCHERS, input.rancherId).catch(() => null);
      if (existingRow) {
        rancherName = String(existingRow['Ranch Name'] || existingRow['Operator Name'] || '') || null;
      }
      const existing = parseIntegration(existingRow?.['Fulfillment Integration']);
      if (existing) {
        if (markupPercent == null && typeof existing.markupPercent === 'number') markupPercent = existing.markupPercent;
        // Category preservation (GTM audit): a re-connect without the
        // category token must not dump merch back into the beef sections.
        if (!category && existing.category) category = existing.category;
      }
    } catch { /* inherit is best-effort */ }
  }
  const cfg: IntegrationConfig = {
    v: 1,
    provider: 'shopify',
    shop: input.shop.toLowerCase().trim(),
    encToken: encryptSecret(input.token.trim()),
    encApiSecret: encryptSecret(input.apiSecret.trim()),
    mode: input.mode,
    markupPercent,
    locationId: null,
    category,
  };
  if (!parseIntegration(JSON.stringify(cfg))) {
    return { ok: false, report: ['Invalid shop domain — need something like ranch-name.myshopify.com'] };
  }

  const connector = getConnector('shopify');
  const valid = await connector.validateConfig(cfg);
  if (!valid.ok) return { ok: false, report: [`Validation failed: ${valid.detail}`] };
  const report: string[] = [valid.detail];

  // Register fulfillment webhooks (+ catalog webhooks for sync mode).
  // Duplicate-address userErrors (re-running /connectstore) are reported,
  // not fatal — the subscription already exists. APP_UNINSTALLED is the only
  // real-time uninstall signal (shop/redact lags ~48h and never fires for
  // custom-app installs) — without it, synced listings stay live on /shop
  // with a dead fulfillment rail (audit 2026-07-21).
  const topics = [
    'FULFILLMENTS_CREATE',
    'FULFILLMENTS_UPDATE',
    'APP_UNINSTALLED',
    // ORDERS_CREATE (B3): a DIRECT sale on the rancher's own store decrements
    // BHC 'Orders Left' in real time, closing the up-to-6h oversell window
    // before the catalog cron / products/update would catch up. Always on — the
    // handler no-ops safely when a SKU has no BHC row or unlimited stock.
    'ORDERS_CREATE',
    ...(input.mode === 'sync' ? ['PRODUCTS_UPDATE', 'PRODUCTS_DELETE'] : []),
  ];
  const webhookFailures: string[] = [];
  for (const topic of topics) {
    try {
      const res: any = await fetch(`https://${cfg.shop}/admin/api/2026-01/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': decryptSecret(cfg.encToken),
        },
        body: JSON.stringify({
          query: WEBHOOK_SUB,
          variables: { topic, sub: { callbackUrl: `${SITE_URL}/api/webhooks/shopify`, format: 'JSON' } },
        }),
      }).then((r) => r.json());
      // Top-level GraphQL errors (throttle, scope, coercion) come back HTTP
      // 200 with data:null — they are failures too (audit 2026-07-21).
      const topErrs = res?.errors;
      const errs = res?.data?.webhookSubscriptionCreate?.userErrors;
      const msg = topErrs?.length
        ? String(topErrs[0]?.message || 'graphql error')
        : errs?.length ? String(errs[0].message) : 'registered';
      report.push(`webhook ${topic}: ${msg}`);
      // "address ... already exists" = re-connect, fine. Anything else is a
      // real failure of that leg.
      if (msg !== 'registered' && !/taken|already/i.test(msg)) webhookFailures.push(`${topic}: ${msg}`);
    } catch (e: any) {
      const msg = String(e?.message || 'network').slice(0, 80);
      report.push(`webhook ${topic}: FAILED (${msg})`);
      webhookFailures.push(`${topic}: ${msg}`);
    }
  }
  // Review 2026-07-21 + B2(a)/B3 + #468 + batch F (audit #14): a saved config
  // with ANY dead webhook means orders push fine but the loop rots invisibly in
  // a topic-specific way — tracking stops (FULFILLMENTS), oversell opens
  // (ORDERS_CREATE / PRODUCTS_*), or the uninstall backstop is gone
  // (APP_UNINSTALLED). #468 alerted only when FULFILLMENTS or ORDERS_CREATE
  // failed; broaden to fire on ANY non-"already-exists" topic failure and NAME
  // each failed topic + its consequence, so a lone APP_UNINSTALLED / PRODUCTS_*
  // failure is no longer silent. Save anyway (token is good, push works) but
  // ring Ben LOUD + actionable — re-running /connectstore or /storelink
  // re-registers.
  if (webhookFailures.length > 0) {
    const failedTopics = webhookFailures.map((f) => f.split(':')[0].trim());
    try {
      const { sendOperatorSignal } = await import('./operatorSignal');
      await sendOperatorSignal({
        urgency: 'loud',
        kind: 'system-error',
        summary: `Store connected but ${failedTopics.length} webhook(s) FAILED — ${cfg.shop} (${failedTopics.join(', ')})`,
        detail:
          `${describeWebhookFailures(webhookFailures)}\n\n` +
          `Raw errors:\n${webhookFailures.join('\n')}\n\n` +
          `Order push still works. Re-run the connect for this rancher to re-register the webhooks.`,
        dedupeKey: `shopify-webhook-reg-fail-${cfg.shop}`,
        dedupeWindowMs: 60 * 60 * 1000,
      });
    } catch {
      /* best-effort */
    }
  }

  await updateRecord(TABLES.RANCHERS, input.rancherId, {
    'Fulfillment Integration': JSON.stringify(cfg),
  });
  report.push(`Saved — ${input.mode} mode${markupPercent != null ? `, ${markupPercent}% markup${input.markupPercent == null ? ' (kept from previous connection)' : ''}` : ''}.`);

  if (input.mode === 'sync') {
    let syncPendingCount: number | null = null;
    try {
      const { syncShopifyCatalog } = await import('./shopifyCatalogSync');
      const dry = await syncShopifyCatalog(input.rancherId, { dryRun: true });
      // imported = rows that WOULD be created; every new sync row imports
      // unapproved (Active false), so this is the count waiting on /approvestore.
      syncPendingCount = dry.imported;
      report.push(`Catalog dry-run: ${dry.report.join('; ')}`);
      report.push(
        'Imported products start OFF the marketplace — BHC reviews and approves each one before it displays (curation gate).',
      );
    } catch {
      report.push('Catalog dry-run unavailable (sync engine ships in PR-E) — connection itself is saved.');
    }

    // Supply-stall fix (batch F, audit #9): a CLEAN token-paste sync connect
    // left NOBODY pinged that a catalog is now sitting unapproved — the
    // products stay OFF /shop until someone happens to run /approvestore, so
    // supply stalls invisibly. Mirror the OAuth "Store INSTALLED" ping so the
    // operator knows to approve. Fire only on a CLEAN connect (all webhooks
    // registered — a failed connect already rang the loud alert above, no point
    // also cheering) and only when the caller didn't opt out (the OAuth callback
    // passes source:'oauth' because it sends its own install ping).
    if (webhookFailures.length === 0 && input.source !== 'oauth') {
      if (rancherName == null) {
        try {
          const { getRecordById, TABLES: T } = await import('./airtable');
          const row: any = await getRecordById(T.RANCHERS, input.rancherId).catch(() => null);
          rancherName = row ? String(row['Ranch Name'] || row['Operator Name'] || '') : '';
        } catch {
          rancherName = '';
        }
      }
      const label = rancherName || cfg.shop;
      const hasCount = typeof syncPendingCount === 'number' && syncPendingCount > 0;
      const pendingPhrase = hasCount
        ? `${syncPendingCount} product${syncPendingCount === 1 ? '' : 's'} pending /approvestore`
        : 'catalog pending approval';
      try {
        const { sendOperatorSignal } = await import('./operatorSignal');
        await sendOperatorSignal({
          urgency: 'normal',
          kind: 'audit',
          summary: `🔌 Store connected — ${pendingPhrase} for ${label}`,
          detail:
            `${cfg.shop} connected in sync mode (token paste).\n` +
            (hasCount
              ? `${syncPendingCount} synced product(s) are OFF /shop until approved. Run /approvestore ${label} to publish the catalog.`
              : 'Synced products import OFF /shop (curation gate). Run /approvestore once the catalog import lands.'),
          dedupeKey: `shopify-connect-pending-${cfg.shop}`,
          dedupeWindowMs: 10 * 60 * 1000,
        });
      } catch {
        /* best-effort */
      }
    }
  }
  return { ok: true, report };
}
