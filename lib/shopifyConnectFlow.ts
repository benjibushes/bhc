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
}

export async function connectShopifyStore(input: ConnectStoreInput): Promise<{ ok: boolean; report: string[] }> {
  // Markup preservation (audit open-item close, 2026-07-21): a re-connect
  // that omits markup must NOT silently wipe a stored markup — sync would
  // quietly stop repricing. Inherit the existing value; an explicit number
  // always wins.
  let markupPercent = input.markupPercent;
  let category = input.category || null;
  if (markupPercent == null || !category) {
    try {
      const { getRecordById, TABLES: T } = await import('./airtable');
      const existingRow: any = await getRecordById(T.RANCHERS, input.rancherId).catch(() => null);
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

  // Register fulfillment webhooks (+ catalog webhook for sync mode).
  // Duplicate-address userErrors (re-running /connectstore) are reported,
  // not fatal — the subscription already exists.
  const topics = ['FULFILLMENTS_CREATE', 'FULFILLMENTS_UPDATE', ...(input.mode === 'sync' ? ['PRODUCTS_UPDATE'] : [])];
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
  // Review 2026-07-21: a saved config with DEAD fulfillment webhooks means
  // orders push fine but tracking never flows back and the SLA cron nags a
  // rancher whose store already shipped. Save anyway (token is good, push
  // works) but ring Ben — re-running /connectstore or /storelink re-registers.
  if (webhookFailures.some((f) => f.startsWith('FULFILLMENTS'))) {
    try {
      const { sendOperatorSignal } = await import('./operatorSignal');
      await sendOperatorSignal({
        urgency: 'loud',
        kind: 'system-error',
        summary: `Store connected but fulfillment webhooks FAILED — ${cfg.shop}`,
        detail:
          `${webhookFailures.join('\n')}\n` +
          `Order push works; tracking will NOT flow back until webhooks register. Re-run the connect for this rancher.`,
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
    try {
      const { syncShopifyCatalog } = await import('./shopifyCatalogSync');
      const dry = await syncShopifyCatalog(input.rancherId, { dryRun: true });
      report.push(`Catalog dry-run: ${dry.report.join('; ')}`);
      report.push(
        'Imported products start OFF the marketplace — BHC reviews and approves each one before it displays (curation gate).',
      );
    } catch {
      report.push('Catalog dry-run unavailable (sync engine ships in PR-E) — connection itself is saved.');
    }
  }
  return { ok: true, report };
}
