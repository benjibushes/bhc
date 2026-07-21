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
}

export async function connectShopifyStore(input: ConnectStoreInput): Promise<{ ok: boolean; report: string[] }> {
  const cfg: IntegrationConfig = {
    v: 1,
    provider: 'shopify',
    shop: input.shop.toLowerCase().trim(),
    encToken: encryptSecret(input.token.trim()),
    encApiSecret: encryptSecret(input.apiSecret.trim()),
    mode: input.mode,
    markupPercent: input.markupPercent,
    locationId: null,
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
      const errs = res?.data?.webhookSubscriptionCreate?.userErrors;
      report.push(`webhook ${topic}: ${errs?.length ? errs[0].message : 'registered'}`);
    } catch (e: any) {
      report.push(`webhook ${topic}: FAILED (${String(e?.message || 'network').slice(0, 80)})`);
    }
  }

  await updateRecord(TABLES.RANCHERS, input.rancherId, {
    'Fulfillment Integration': JSON.stringify(cfg),
  });
  report.push(`Saved — ${input.mode} mode${input.markupPercent != null ? `, ${input.markupPercent}% markup` : ''}.`);

  if (input.mode === 'sync') {
    try {
      const { syncShopifyCatalog } = await import('./shopifyCatalogSync');
      const dry = await syncShopifyCatalog(input.rancherId, { dryRun: true });
      report.push(`Catalog dry-run: ${dry.report.join('; ')}`);
      report.push('Run /syncstore <rancher> to import for real.');
    } catch {
      report.push('Catalog dry-run unavailable (sync engine ships in PR-E) — connection itself is saved.');
    }
  }
  return { ok: true, report };
}
