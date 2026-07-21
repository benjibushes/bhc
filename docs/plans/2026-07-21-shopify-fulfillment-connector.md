# Fulfillment Connector (Shopify v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BHC-paid product orders are injected as pre-paid orders into a distributor's own Shopify store for fulfillment, with two onboarding modes (full catalog sync OR manual SKU entry), encrypted per-rancher credentials, tracking flowing back automatically, and refunds cancelling the external order.

**Architecture:** Adapter pattern (`FulfillmentConnector` interface, Shopify = provider #1). Push is an inline best-effort side effect at the end of `settleProductPurchase` + a net-cron sweep for misses (the repo's canonical retry pair — no queue). Reverse leg is a HMAC-verified webhook stamping tracking onto Rancher Orders. Catalog sync is a mapper (pure, tested) + cron + `products/update` webhook trigger.

**Tech Stack:** Next.js App Router route handlers, TypeScript, Airtable (`lib/airtable.ts`), Shopify GraphQL Admin API (2026-01, custom-app offline token `shpat_`), node:crypto AES-256-GCM, node:test via tsx.

**Authored against:** main `d168df8` (2026-07-21). Re-verify file:line anchors before editing — main moves.

**Business model (locked by Ben 2026-07-21):** BHC brings the customer and charges the buyer; margin is taken upfront via the existing Stripe Connect direct charge (`application_fee_amount` = BHC margin, `lib/productCheckout.ts:58` money math unchanged). The distributor gets paid instantly and fulfills through whatever connector they choose. Per-operation choice: sync their store OR manually enter SKUs. Approved decisions: Shopify sends the shipment email (`sendFulfillmentReceipt: true`, BHC suppresses `product_shipped` for connected orders); v1 auth = per-store custom-app token; pilot = merch.buyhalfcow.com before any rancher store.

---

## Pre-merge Airtable actions (rule 1: field exists before code writes it)

Create on base `appgLT4z009iwAfhs` BEFORE merging PR-A (Airtable MCP `create_field` or setup endpoint):

| Table | Field | Type |
|---|---|---|
| Ranchers (`tblCUuBEQyOJIQBHo` — VERIFY id via list_tables first) | `Fulfillment Integration` | multilineText (JSON) |
| Rancher Products | `External SKU` | singleLineText |
| Rancher Products | `External Product Id` | singleLineText |
| Rancher Products | `Sync Managed` | checkbox (icon check, greenBright) |
| Rancher Products | `Last Synced At` | dateTime (iso/24hour/utc) |
| Rancher Orders | `External Order Id` | singleLineText |
| Rancher Orders | `External Push Status` | singleLineText |
| Rancher Orders | `External Pushed At` | dateTime (iso/24hour/utc) |

Also add env (Vercel prod + `.env.local` + test script): `INTEGRATION_TOKEN_KEY` = 32 random bytes base64 (`openssl rand -base64 32`). Add `INTEGRATION_TOKEN_KEY=test-key-ci-32-bytes-aaaaaaaaaaaaa=` style value to the `npm test` env prefix in `package.json:10` (must decode to 32 bytes — generate a real one).

## `Fulfillment Integration` JSON schema (v1)

```json
{
  "v": 1,
  "provider": "shopify",
  "shop": "example.myshopify.com",
  "encToken": "v1:<ivB64>:<tagB64>:<ctB64>",
  "encApiSecret": "v1:<ivB64>:<tagB64>:<ctB64>",
  "mode": "sync",
  "markupPercent": 30,
  "locationId": null
}
```
`mode`: `"sync"` (catalog imported + kept fresh) | `"manual"` (rancher/Ben types `External SKU` on hand-created Rancher Products rows). `encApiSecret` = the custom app's API secret key — signs webhook HMACs. `markupPercent` = Display Price = ceil(Rancher Base × (1+markup/100)) − .01; `null` means sync never touches Display Price after first import.

---

### Task 1: AES-GCM crypto helper

**Files:**
- Create: `lib/integrationCrypto.ts`
- Test: `lib/integrationCrypto.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/integrationCrypto.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret } from './integrationCrypto';

test('roundtrip', () => {
  const ct = encryptSecret('shpat_abc123');
  assert.notEqual(ct, 'shpat_abc123');
  assert.ok(ct.startsWith('v1:'));
  assert.equal(decryptSecret(ct), 'shpat_abc123');
});

test('unique IV per call', () => {
  assert.notEqual(encryptSecret('same'), encryptSecret('same'));
});

test('tampered ciphertext throws', () => {
  const ct = encryptSecret('secret');
  const parts = ct.split(':');
  parts[3] = Buffer.from('tampered-payload').toString('base64');
  assert.throws(() => decryptSecret(parts.join(':')));
});

test('malformed input throws', () => {
  assert.throws(() => decryptSecret('not-a-token'));
  assert.throws(() => decryptSecret('v2:a:b:c'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `INTEGRATION_TOKEN_KEY=$(openssl rand -base64 32) npx tsx --test lib/integrationCrypto.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

```ts
// lib/integrationCrypto.ts
//
// AES-256-GCM at-rest encryption for per-rancher integration credentials
// (Shopify admin tokens etc). REQUIRED because the Airtable base is shared
// with ~/bhc-prospects-dashboard — plaintext third-party tokens in a shared
// base are an unacceptable exposure class. Key is platform-global env
// (INTEGRATION_TOKEN_KEY, 32 bytes base64), fail-loud like lib/secrets.ts.
// Format: v1:<iv b64>:<authTag b64>:<ciphertext b64>

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

function key(): Buffer {
  const raw = process.env.INTEGRATION_TOKEN_KEY || '';
  if (!raw) throw new Error('INTEGRATION_TOKEN_KEY unset');
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('INTEGRATION_TOKEN_KEY must be 32 bytes base64');
  return k;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(token: string): string {
  const [v, ivB64, tagB64, ctB64, extra] = String(token || '').split(':');
  if (v !== 'v1' || !ivB64 || !tagB64 || !ctB64 || extra !== undefined) {
    throw new Error('integrationCrypto: malformed token');
  }
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
```

- [ ] **Step 4: Run test to verify it passes** (same command) Expected: PASS
- [ ] **Step 5: Add `INTEGRATION_TOKEN_KEY` to the `npm test` env prefix in package.json:10, run full `npm test`, verify baseline+4 pass**
- [ ] **Step 6: Commit** `git add lib/integrationCrypto.ts lib/integrationCrypto.test.ts package.json && git commit -m "feat(connector): AES-GCM helper for per-rancher integration credentials"`

### Task 2: Integration config parse + connector contract

**Files:**
- Create: `lib/fulfillmentConnector.ts`
- Test: `lib/fulfillmentConnector.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/fulfillmentConnector.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntegration } from './fulfillmentConnector';

const good = JSON.stringify({ v: 1, provider: 'shopify', shop: 'x.myshopify.com', encToken: 'v1:a:b:c', encApiSecret: 'v1:a:b:c', mode: 'manual', markupPercent: 30 });

test('parses valid config', () => {
  const cfg = parseIntegration(good);
  assert.equal(cfg?.provider, 'shopify');
  assert.equal(cfg?.shop, 'x.myshopify.com');
  assert.equal(cfg?.mode, 'manual');
});

test('null on blank / malformed / wrong version / unknown provider / bad shop', () => {
  assert.equal(parseIntegration(''), null);
  assert.equal(parseIntegration(undefined), null);
  assert.equal(parseIntegration('{not json'), null);
  assert.equal(parseIntegration(JSON.stringify({ v: 2, provider: 'shopify' })), null);
  assert.equal(parseIntegration(JSON.stringify({ v: 1, provider: 'ebay', shop: 'x.myshopify.com', encToken: 'x', encApiSecret: 'x', mode: 'manual' })), null);
  assert.equal(parseIntegration(JSON.stringify({ v: 1, provider: 'shopify', shop: 'https://evil.com', encToken: 'x', encApiSecret: 'x', mode: 'manual' })), null);
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx tsx --test lib/fulfillmentConnector.test.ts`

- [ ] **Step 3: Implementation**

```ts
// lib/fulfillmentConnector.ts
//
// Provider-agnostic fulfillment connector contract + per-rancher config
// parsing. JSON-in-multiline-text on Ranchers.'Fulfillment Integration' —
// same defensive-parse pattern as Push Subscriptions (lib/rancherPush.ts:34).
// Providers register here; settlement/crons/webhooks speak only this
// interface, never a provider SDK.

export interface IntegrationConfig {
  v: 1;
  provider: 'shopify';
  shop: string;              // *.myshopify.com host, no scheme
  encToken: string;          // AES-GCM (lib/integrationCrypto)
  encApiSecret: string;      // custom app API secret (webhook HMAC)
  mode: 'sync' | 'manual';
  markupPercent?: number | null;
  locationId?: string | null;
}

export interface PushLineItem { sku: string; quantity: number; title: string }
export interface PushOrderInput {
  orderRef: string;          // BHC Rancher Orders 'Order Ref' — becomes external note/tag
  buyerName: string;
  buyerEmail: string;
  shipToAddress: string;     // free-text from checkout; provider does best-effort split
  lineItems: PushLineItem[];
}
export type PushResult =
  | { ok: true; externalOrderId: string }
  | { ok: false; permanent: boolean; error: string };

export interface FulfillmentConnector {
  provider: IntegrationConfig['provider'];
  validateConfig(cfg: IntegrationConfig): Promise<{ ok: boolean; detail: string }>;
  pushOrder(cfg: IntegrationConfig, order: PushOrderInput): Promise<PushResult>;
  cancelOrder(cfg: IntegrationConfig, externalOrderId: string, staffNote: string): Promise<{ ok: boolean; error?: string }>;
}

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function parseIntegration(raw: unknown): IntegrationConfig | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || obj.v !== 1 || obj.provider !== 'shopify') return null;
  const shop = String(obj.shop || '').toLowerCase().trim();
  if (!SHOP_RE.test(shop)) return null;
  if (!obj.encToken || !obj.encApiSecret) return null;
  if (obj.mode !== 'sync' && obj.mode !== 'manual') return null;
  return {
    v: 1, provider: 'shopify', shop,
    encToken: String(obj.encToken), encApiSecret: String(obj.encApiSecret),
    mode: obj.mode,
    markupPercent: typeof obj.markupPercent === 'number' ? obj.markupPercent : null,
    locationId: obj.locationId ? String(obj.locationId) : null,
  };
}

// Registry — settlement code does getConnector(cfg.provider).
import type {} from './integrationCrypto'; // (no side effects; keeps import graph explicit)
export function getConnector(provider: IntegrationConfig['provider']): FulfillmentConnector {
  // Lazy require so tests of pure parsing never load provider code.
  if (provider === 'shopify') {
    const { shopifyConnector } = require('./shopifyConnector');
    return shopifyConnector;
  }
  throw new Error(`Unknown fulfillment provider: ${provider}`);
}
```

- [ ] **Step 4: Run test → PASS. Full `npm test` → PASS.**
- [ ] **Step 5: Commit** `git commit -m "feat(connector): provider-agnostic contract + per-rancher config parsing"`

### Task 3: Shopify connector

**Files:**
- Create: `lib/shopifyConnector.ts`
- Test: `lib/shopifyConnector.test.ts` (pure parts: error taxonomy, address split, gql builders — NOT live calls)

- [ ] **Step 1: Failing tests**

```ts
// lib/shopifyConnector.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitShipTo, classifyGqlErrors } from './shopifyConnector';

test('splitShipTo best-effort parses multi-line address', () => {
  const a = splitShipTo('Jane Doe\n123 Main St\nAustin, TX 78701');
  assert.equal(a.address1, '123 Main St');
  assert.equal(a.city, 'Austin');
  assert.equal(a.provinceCode, 'TX');
  assert.equal(a.zip, '78701');
});

test('splitShipTo degrades to address1 blob when unparseable', () => {
  const a = splitShipTo('weird single line no commas');
  assert.equal(a.address1, 'weird single line no commas');
});

test('classifyGqlErrors: userErrors are permanent, throttle/5xx transient', () => {
  assert.deepEqual(classifyGqlErrors({ userErrors: [{ message: 'sku bad' }] }, 200), { permanent: true, error: 'sku bad' });
  assert.equal(classifyGqlErrors(null, 429).permanent, false);
  assert.equal(classifyGqlErrors(null, 502).permanent, false);
  assert.equal(classifyGqlErrors(null, 401).permanent, true);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implementation**

```ts
// lib/shopifyConnector.ts
//
// FulfillmentConnector provider #1. All calls = GraphQL Admin API 2026-01
// with the rancher's custom-app offline token (decrypted per call, never
// cached, never logged). Push = orderCreate financialStatus PAID with
// inventory decrement + Shopify-owned fulfillment email (Ben decision
// 2026-07-21: sendFulfillmentReceipt true / sendReceipt false — BHC already
// sent product_receipt). Cancel = orderCancel restock:true notify:false
// (BHC refunded via Stripe; no refundMethod — no Shopify payment exists).

import type { FulfillmentConnector, IntegrationConfig, PushOrderInput, PushResult } from './fulfillmentConnector';
import { decryptSecret } from './integrationCrypto';

const API_VERSION = '2026-01';

async function gql(cfg: IntegrationConfig, query: string, variables: any): Promise<{ status: number; body: any }> {
  const res = await fetch(`https://${cfg.shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': decryptSecret(cfg.encToken),
    },
    body: JSON.stringify({ query, variables }),
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* transient */ }
  return { status: res.status, body };
}

export function classifyGqlErrors(payload: any, httpStatus: number): { permanent: boolean; error: string } {
  if (httpStatus === 429 || httpStatus >= 500) return { permanent: false, error: `http ${httpStatus}` };
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) return { permanent: true, error: `http ${httpStatus} (token/scope/shop)` };
  const ue = payload?.userErrors;
  if (Array.isArray(ue) && ue.length) return { permanent: true, error: ue.map((e: any) => e.message).join('; ').slice(0, 300) };
  return { permanent: false, error: `unclassified http ${httpStatus}` };
}

export function splitShipTo(blob: string): { address1: string; address2?: string; city?: string; provinceCode?: string; zip?: string } {
  const lines = String(blob || '').split('\n').map((l) => l.trim()).filter(Boolean);
  // Last line like "City, ST 12345" — the format our checkout collects.
  const m = lines[lines.length - 1]?.match(/^(.+?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (lines.length >= 2 && m) {
    const street = lines.slice(lines.length === 2 ? 0 : 1, lines.length - 1);
    return { address1: street[0] || lines[0], address2: street[1], city: m[1], provinceCode: m[2].toUpperCase(), zip: m[3] };
  }
  return { address1: lines.join(', ') || String(blob || '') };
}

const VARIANT_BY_SKU = `query($q: String!) { productVariants(first: 1, query: $q) { nodes { id sku } } }`;

async function resolveVariantId(cfg: IntegrationConfig, sku: string): Promise<string | null> {
  const { status, body } = await gql(cfg, VARIANT_BY_SKU, { q: `sku:${JSON.stringify(sku)}` });
  if (status !== 200) return null;
  const node = body?.data?.productVariants?.nodes?.[0];
  return node && node.sku === sku ? String(node.id) : null;
}

const ORDER_CREATE = `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    userErrors { field message }
    order { id name }
  }
}`;

const ORDER_CANCEL = `mutation($orderId: ID!, $restock: Boolean!, $reason: OrderCancelReason!, $staffNote: String, $notifyCustomer: Boolean) {
  orderCancel(orderId: $orderId, restock: $restock, reason: $reason, staffNote: $staffNote, notifyCustomer: $notifyCustomer) {
    job { id }
    orderCancelUserErrors { message }
  }
}`;

export const shopifyConnector: FulfillmentConnector = {
  provider: 'shopify',

  async validateConfig(cfg) {
    const { status, body } = await gql(cfg, `query { shop { name currencyCode } }`, {});
    if (status !== 200 || !body?.data?.shop?.name) {
      return { ok: false, detail: `shop query failed (http ${status}) — check domain + Admin token + read scopes` };
    }
    return { ok: true, detail: `connected to "${body.data.shop.name}" (${body.data.shop.currencyCode})` };
  },

  async pushOrder(cfg, order): Promise<PushResult> {
    // Resolve every SKU first — a miss is PERMANENT (operator must fix SKU).
    const lineItems: any[] = [];
    for (const li of order.lineItems) {
      const variantId = await resolveVariantId(cfg, li.sku);
      if (!variantId) return { ok: false, permanent: true, error: `SKU not found in store: ${li.sku}` };
      lineItems.push({ variantId, quantity: li.quantity });
    }
    const ship = splitShipTo(order.shipToAddress);
    const [firstName, ...rest] = order.buyerName.trim().split(/\s+/);
    const { status, body } = await gql(cfg, ORDER_CREATE, {
      order: {
        lineItems,
        financialStatus: 'PAID',
        sourceName: 'BuyHalfCow',
        tags: ['BHC'],
        note: `BuyHalfCow order ${order.orderRef} — paid via BHC, fulfill as normal.`,
        email: order.buyerEmail,
        shippingAddress: {
          firstName: firstName || order.buyerName, lastName: rest.join(' ') || undefined,
          address1: ship.address1, address2: ship.address2,
          city: ship.city, provinceCode: ship.provinceCode, zip: ship.zip, countryCode: 'US',
        },
      },
      options: {
        inventoryBehaviour: 'DECREMENT_OBEYING_POLICY',
        sendReceipt: false,          // BHC already sent product_receipt
        sendFulfillmentReceipt: true, // Shopify owns the tracking email (Ben decision)
      },
    });
    const payload = body?.data?.orderCreate;
    const oid = payload?.order?.id;
    if (status === 200 && oid && !(payload?.userErrors?.length)) return { ok: true, externalOrderId: String(oid) };
    const cls = classifyGqlErrors(payload, status);
    return { ok: false, ...cls };
  },

  async cancelOrder(cfg, externalOrderId, staffNote) {
    const { status, body } = await gql(cfg, ORDER_CANCEL, {
      orderId: externalOrderId, restock: true, reason: 'OTHER',
      staffNote: staffNote.slice(0, 255), notifyCustomer: false,
    });
    const errs = body?.data?.orderCancel?.orderCancelUserErrors;
    if (status === 200 && !(errs?.length)) return { ok: true };
    return { ok: false, error: (errs?.map((e: any) => e.message).join('; ') || `http ${status}`).slice(0, 300) };
  },
};
```

- [ ] **Step 4: Run tests → PASS. `npx tsc --noEmit` → clean. Full `npm test` → PASS.**
- [ ] **Step 5: Commit.** Then **PR-A ships**: create the 8 Airtable fields (table above) FIRST, then tsc/test/`next build`/PR/squash-merge/verify per repo gates.

### Task 4: Push-eligibility gate (pure) + Rancher Orders → PushOrderInput builder

**Files:**
- Create: `lib/fulfillmentPush.ts`
- Test: `lib/fulfillmentPush.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// lib/fulfillmentPush.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectPushableOrder, buildPushInput } from './fulfillmentPush';

const cfg = { v: 1, provider: 'shopify', shop: 'x.myshopify.com', encToken: 'e', encApiSecret: 'e', mode: 'manual' } as any;
const baseOrder = {
  id: 'recORDER', 'Order Ref': 'BHC-1234', Status: 'New', Quantity: 2,
  'Buyer Name': 'Jane Doe', 'Buyer Email': 'j@x.com', 'Ship To Address': '123 Main St\nAustin, TX 78701',
  'External Push Status': '', 'External Order Id': '',
};
const product = { id: 'recPROD', 'External SKU': 'BEEF-BOX-10', 'Product Name': 'Beef Box' };

test('happy path is pushable', () => {
  assert.equal(selectPushableOrder({ order: baseOrder, product, integration: cfg }).ok, true);
});

test('blocked: no integration / no SKU / deposit-style ref / pickup ref / already pushed / refunded', () => {
  assert.equal(selectPushableOrder({ order: baseOrder, product, integration: null }).ok, false);
  assert.equal(selectPushableOrder({ order: baseOrder, product: { ...product, 'External SKU': '' }, integration: cfg }).ok, false);
  assert.equal(selectPushableOrder({ order: { ...baseOrder, 'Order Ref': 'DEPOSIT — BHC-1' }, product, integration: cfg }).ok, false);
  assert.equal(selectPushableOrder({ order: { ...baseOrder, 'Order Ref': 'PICKUP — BHC-1' }, product, integration: cfg }).ok, false);
  assert.equal(selectPushableOrder({ order: { ...baseOrder, 'External Order Id': 'gid://shopify/Order/1' }, product, integration: cfg }).ok, false);
  assert.equal(selectPushableOrder({ order: { ...baseOrder, Status: 'Refunded' }, product, integration: cfg }).ok, false);
});

test('buildPushInput maps fields + quantity', () => {
  const input = buildPushInput(baseOrder, product);
  assert.equal(input.orderRef, 'BHC-1234');
  assert.deepEqual(input.lineItems, [{ sku: 'BEEF-BOX-10', quantity: 2, title: 'Beef Box' }]);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implementation**

```ts
// lib/fulfillmentPush.ts
//
// Pure gate + mapper between a Rancher Orders row and the connector's
// PushOrderInput. Deposit-style / pickup nature lives ONLY in the
// 'Order Ref' prefix (same source lib/productFulfillmentSla.ts orderKind
// reads) — those orders must NEVER reach an external store: a deposit is
// not a shippable SKU and a pickup needs no logistics.

import type { IntegrationConfig, PushOrderInput } from './fulfillmentConnector';

export function selectPushableOrder(input: {
  order: any; product: any; integration: IntegrationConfig | null;
}): { ok: true } | { ok: false; reason: string } {
  const { order, product, integration } = input;
  if (!integration) return { ok: false, reason: 'no-integration' };
  const ref = String(order?.['Order Ref'] || '');
  if (ref.startsWith('DEPOSIT')) return { ok: false, reason: 'deposit-style' };
  if (ref.startsWith('PICKUP')) return { ok: false, reason: 'pickup' };
  if (String(order?.Status || '') !== 'New') return { ok: false, reason: `status-${order?.Status || 'blank'}` };
  if (String(order?.['External Order Id'] || '').trim()) return { ok: false, reason: 'already-pushed' };
  if (String(order?.['External Push Status'] || '').trim() === 'pushed') return { ok: false, reason: 'already-pushed' };
  if (!String(product?.['External SKU'] || '').trim()) return { ok: false, reason: 'no-sku' };
  if (!String(order?.['Ship To Address'] || '').trim()) return { ok: false, reason: 'no-address' };
  return { ok: true };
}

export function buildPushInput(order: any, product: any): PushOrderInput {
  return {
    orderRef: String(order['Order Ref'] || order.id),
    buyerName: String(order['Buyer Name'] || 'Customer'),
    buyerEmail: String(order['Buyer Email'] || ''),
    shipToAddress: String(order['Ship To Address'] || ''),
    lineItems: [{
      sku: String(product['External SKU']).trim(),
      quantity: Math.max(1, Number(order['Quantity'] || 1)),
      title: String(product['Product Name'] || 'Product'),
    }],
  };
}
```

- [ ] **Step 4: Run → PASS. Commit.**

### Task 5: Wire push into settlement + stamp truth

**Files:**
- Modify: `lib/productSettlement.ts` (side-effect zone after inventory decrement, ~:370, BEFORE Meta CAPI — re-locate at build time)
- Create: `lib/fulfillmentPushRunner.ts` (shared by settlement + net cron)

- [ ] **Step 1: Implementation of the shared runner (test via its pure deps, already covered)**

```ts
// lib/fulfillmentPushRunner.ts
//
// One idempotent push attempt for one settled Rancher Orders row. Loads
// rancher + product, runs the pure gate, calls the connector, and stamps
// the outcome on the ROW (rule 2: money-path truth persisted, not logged):
//   External Push Status: 'pushed' | 'skipped:<reason>' | 'failed:<error>'
//   External Order Id / External Pushed At on success.
// Never throws. Transient failures leave status blank/'failed:*transient*'
// so the net cron retries; permanent ones stamp failed + loud signal.

import { getRecordById, updateRecord, TABLES } from './airtable';
import { parseIntegration, getConnector } from './fulfillmentConnector';
import { selectPushableOrder, buildPushInput } from './fulfillmentPush';

export async function runFulfillmentPush(orderRowId: string): Promise<void> {
  try {
    const order = await getRecordById(TABLES.RANCHER_ORDERS, orderRowId);
    if (!order) return;
    const rancher = order['Rancher Record ID']
      ? await getRecordById(TABLES.RANCHERS, String(order['Rancher Record ID'])).catch(() => null) : null;
    const product = order['Product Record ID']
      ? await getRecordById(TABLES.RANCHER_PRODUCTS, String(order['Product Record ID'])).catch(() => null) : null;
    const integration = parseIntegration(rancher?.['Fulfillment Integration']);
    const gate = selectPushableOrder({ order, product, integration });
    if (!gate.ok) {
      // Only stamp terminal skips (so the sweep stops re-inspecting); leave
      // 'no-integration' UNSTAMPED — Ben may connect the store later.
      if (gate.reason !== 'no-integration' && !String(order['External Push Status'] || '')) {
        await updateRecord(TABLES.RANCHER_ORDERS, orderRowId, { 'External Push Status': `skipped:${gate.reason}` }).catch(() => {});
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
      await updateRecord(TABLES.RANCHER_ORDERS, orderRowId, { 'External Push Status': `failed:${result.error}`.slice(0, 250) }).catch(() => {});
      const { sendOperatorSignal } = await import('./operatorSignal');
      await sendOperatorSignal({
        urgency: 'loud', kind: 'system-error',
        summary: `Shopify push FAILED (permanent) — order ${order['Order Ref']}`,
        detail: `${result.error} — order will NOT auto-fulfill; fix SKU/token then clear External Push Status to retry.`,
        dedupeKey: `shopify-push-fail-${orderRowId}`, dedupeWindowMs: 24 * 60 * 60 * 1000,
      }).catch(() => {});
    }
    // transient: leave unstamped → net cron retries
  } catch (e: any) {
    console.error('[fulfillmentPush] error:', e?.message);
  }
}
```

- [ ] **Step 2: In `lib/productSettlement.ts`, after the inventory-decrement block, add the fire-and-forget call (mirror the CAPI block style):**

```ts
  // Fulfillment connector push (2026-07: Shopify v1) — best-effort, never
  // blocks settlement. Gates + outcome stamps live in the runner.
  try {
    const { runFulfillmentPush } = await import('./fulfillmentPushRunner');
    await runFulfillmentPush(createdOrderRowId); // use the row id variable in scope at this point
  } catch (e: any) {
    console.error('[settleProduct] fulfillment push skipped:', e?.message);
  }
```

- [ ] **Step 3: Suppress BHC's product_shipped for connected orders** — in `app/api/rancher/orders/route.ts` mark-shipped POST and in the reverse-leg webhook (Task 7): when `External Push Status === 'pushed'`, skip `product_shipped` email (Shopify's `sendFulfillmentReceipt` owns it). Guard: `const externallyFulfilled = String(order['External Push Status'] || '') === 'pushed';`
- [ ] **Step 4: `npx tsc --noEmit` + full `npm test` → PASS. Commit.**

### Task 6: Net cron + refund cancel leg

**Files:**
- Create: `app/api/cron/fulfillment-push-net/route.ts` (clone the shape of `app/api/cron/product-settlement-net/route.ts`: requireCron + withCronRun('fulfillment-push-net') + maintenance gate)
- Modify: `lib/productSettlement.ts` `reconcileProductOrderRefund` (~:447)
- Modify: `vercel.json` (add `{"path": "/api/cron/fulfillment-push-net", "schedule": "40 */2 * * *"}` — verify minute free at build time)
- Modify: `lib/cronIntrospection.ts` EXPECTED_CRONS list (repo's cron-coverage test fails otherwise — learned on #419)

- [ ] **Step 1: Cron handler core (inside withCronRun realHandler):**

```ts
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const rows = (await getAllRecords(
    TABLES.RANCHER_ORDERS,
    `AND({Status} = "New", {External Push Status} = "", IS_AFTER({Ordered At}, "${cutoff}"))`,
  )) as any[];
  let pushed = 0;
  for (const row of rows.slice(0, 20)) {
    await runFulfillmentPush(row.id);           // idempotent: gate re-checks stamps
    const after = await getRecordById(TABLES.RANCHER_ORDERS, row.id).catch(() => null);
    if (String(after?.['External Push Status'] || '') === 'pushed') pushed++;
  }
  return { status: 'ok', recordsTouched: pushed, notes: `${rows.length} candidates, ${pushed} pushed` };
```

- [ ] **Step 2: Refund cancel leg — inside `reconcileProductOrderRefund`'s FULL-refund branch only (the partial branch at ~:472 leaves the order live and must not cancel):**

```ts
      // Cancel the pushed external order so the rancher's store stops
      // fulfilling a refunded deal (restock:true puts their inventory back).
      const externalId = String(order['External Order Id'] || '').trim();
      if (externalId) {
        try {
          const rancher = await getRecordById(TABLES.RANCHERS, String(order['Rancher Record ID']));
          const integration = parseIntegration(rancher?.['Fulfillment Integration']);
          if (integration) {
            const res = await getConnector(integration.provider).cancelOrder(
              integration, externalId, `BHC refund — ${order['Order Ref']}`);
            await updateRecord(TABLES.RANCHER_ORDERS, order.id, {
              'External Push Status': res.ok ? 'cancelled' : `cancel-failed:${res.error}`.slice(0, 250),
            }).catch(() => {});
            if (!res.ok) {
              const { sendOperatorSignal } = await import('./operatorSignal');
              await sendOperatorSignal({
                urgency: 'loud', kind: 'payout',
                summary: `External order CANCEL FAILED — ${order['Order Ref']}`,
                detail: `Shopify order ${externalId} may still ship after refund. ${res.error}`,
                dedupeKey: `shopify-cancel-fail-${order.id}`, dedupeWindowMs: 24 * 60 * 60 * 1000,
              }).catch(() => {});
            }
          }
        } catch (e: any) { console.error('[refund] external cancel error:', e?.message); }
      }
```

- [ ] **Step 3: tsc + tests + REAL `next build` → PR-B ships (repo gates).**

### Task 7: Reverse leg — Shopify fulfillment webhook

**Files:**
- Create: `app/api/webhooks/shopify/route.ts`
- Create: `lib/shopifyWebhookVerify.ts` + test

- [ ] **Step 1: Failing test (HMAC verify, pure)**

```ts
// lib/shopifyWebhookVerify.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { verifyShopifyHmac } from './shopifyWebhookVerify';

test('valid signature passes, wrong secret / tampered body fail, malformed header fails', () => {
  const body = '{"id":1}'; const secret = 'shhh';
  const sig = createHmac('sha256', secret).update(body, 'utf8').digest('base64');
  assert.equal(verifyShopifyHmac(body, sig, secret), true);
  assert.equal(verifyShopifyHmac(body, sig, 'wrong'), false);
  assert.equal(verifyShopifyHmac(body + 'x', sig, secret), false);
  assert.equal(verifyShopifyHmac(body, null, secret), false);
  assert.equal(verifyShopifyHmac(body, 'not-base64!!!!', secret), false);
});
```

- [ ] **Step 2: Implementation**

```ts
// lib/shopifyWebhookVerify.ts
import { createHmac, timingSafeEqual } from 'crypto';

export function verifyShopifyHmac(rawBody: string, headerSig: string | null, secret: string): boolean {
  if (!headerSig || !secret) return false;
  try {
    const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
    const given = Buffer.from(headerSig, 'base64');
    return given.length === digest.length && timingSafeEqual(digest, given);
  } catch { return false; }
}
```

- [ ] **Step 3: Route** — `app/api/webhooks/shopify/route.ts`:

```ts
// POST /api/webhooks/shopify — fulfillment events from connected stores.
// Topics: fulfillments/create, fulfillments/update (registered at connect
// time, Task 8). HMAC = custom app's API secret (per-rancher, encrypted in
// Fulfillment Integration). Shop resolved from X-Shopify-Shop-Domain, then
// the rancher row is found by FIND(shop) over the JSON field.
// Stamps: Tracking Number / Shipped At / Status 'Shipped' — idempotent, and
// SUPPRESSES product_shipped (Shopify sent its own fulfillment email).

import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { parseIntegration } from '@/lib/fulfillmentConnector';
import { verifyShopifyHmac } from '@/lib/shopifyWebhookVerify';
import { decryptSecret } from '@/lib/integrationCrypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function POST(request: Request) {
  const raw = await request.text();
  const shop = String(request.headers.get('x-shopify-shop-domain') || '').toLowerCase();
  const topic = String(request.headers.get('x-shopify-topic') || '');
  if (!shop) return NextResponse.json({ ok: true, skipped: 'no shop header' });

  const ranchers = (await getAllRecords(
    TABLES.RANCHERS,
    `FIND("${escapeAirtableValue(shop)}", {Fulfillment Integration})`,
  ).catch(() => [])) as any[];
  const rancher = ranchers.find((r) => parseIntegration(r['Fulfillment Integration'])?.shop === shop);
  const integration = rancher ? parseIntegration(rancher['Fulfillment Integration']) : null;
  if (!integration) return NextResponse.json({ ok: true, skipped: 'unknown shop' });

  if (!verifyShopifyHmac(raw, request.headers.get('x-shopify-hmac-sha256'), decryptSecret(integration.encApiSecret))) {
    console.warn(`[shopify-webhook] HMAC fail for ${shop}`);
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  if (topic !== 'fulfillments/create' && topic !== 'fulfillments/update') {
    return NextResponse.json({ ok: true, skipped: topic });
  }
  let payload: any; try { payload = JSON.parse(raw); } catch { return NextResponse.json({ ok: true, skipped: 'bad json' }); }
  const externalOrderId = payload?.order_id ? `gid://shopify/Order/${payload.order_id}` : '';
  const tracking = (payload?.tracking_numbers?.[0] || payload?.tracking_number || '').toString();
  if (!externalOrderId) return NextResponse.json({ ok: true, skipped: 'no order_id' });

  const orders = (await getAllRecords(
    TABLES.RANCHER_ORDERS,
    `{External Order Id} = "${escapeAirtableValue(externalOrderId)}"`,
  ).catch(() => [])) as any[];
  for (const order of orders) {
    const updates: Record<string, any> = {};
    if (tracking && !String(order['Tracking Number'] || '').trim()) updates['Tracking Number'] = tracking;
    if (String(order['Status'] || '') === 'New') { updates['Status'] = 'Shipped'; updates['Shipped At'] = new Date().toISOString(); }
    if (Object.keys(updates).length) await updateRecord(TABLES.RANCHER_ORDERS, order.id, updates).catch(() => {});
    // NOTE: deliberately NOT sending product_shipped — sendFulfillmentReceipt
    // covered the buyer. SLA cron stops via Status='Shipped'.
  }
  return NextResponse.json({ ok: true, processed: topic, matched: orders.length });
}
```

- [ ] **Step 4: tsc + tests + REAL `next build` → PR-C ships.**

### Task 8: Onboarding — `/connectstore` Telegram flow + webhook registration

**Files:**
- Modify: `app/api/webhooks/telegram/route.ts` (new command `/connectstore <rancher name|email> <shop> <token> <apiSecret> [sync|manual] [markup%]` — surgical, follow `/onboard` command's structure)
- Create: `lib/shopifyConnectFlow.ts` (the logic, so the telegram route stays thin)

- [ ] **Step 1: `lib/shopifyConnectFlow.ts`:**

```ts
// Validates + persists a rancher's Shopify connection, registers webhooks.
// Returns operator-facing report lines (telegram-safe).
import { encryptSecret } from './integrationCrypto';
import { parseIntegration, getConnector, type IntegrationConfig } from './fulfillmentConnector';
import { updateRecord, TABLES } from './airtable';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
const WEBHOOK_SUB = `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
    webhookSubscription { id } userErrors { message }
  }
}`;

export async function connectShopifyStore(input: {
  rancherId: string; shop: string; token: string; apiSecret: string;
  mode: 'sync' | 'manual'; markupPercent: number | null;
}): Promise<{ ok: boolean; report: string[] }> {
  const cfg: IntegrationConfig = {
    v: 1, provider: 'shopify', shop: input.shop.toLowerCase().trim(),
    encToken: encryptSecret(input.token), encApiSecret: encryptSecret(input.apiSecret),
    mode: input.mode, markupPercent: input.markupPercent, locationId: null,
  };
  if (!parseIntegration(JSON.stringify(cfg))) return { ok: false, report: ['Invalid shop domain — need *.myshopify.com'] };

  const connector = getConnector('shopify');
  const valid = await connector.validateConfig(cfg);
  if (!valid.ok) return { ok: false, report: [`Validation failed: ${valid.detail}`] };

  // Register fulfillment webhooks (idempotent enough: duplicate-address
  // userErrors are reported, not fatal).
  const { decryptSecret } = await import('./integrationCrypto');
  const report = [valid.detail];
  for (const topic of ['FULFILLMENTS_CREATE', 'FULFILLMENTS_UPDATE', ...(input.mode === 'sync' ? ['PRODUCTS_UPDATE'] : [])]) {
    const res = await fetch(`https://${cfg.shop}/admin/api/2026-01/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': decryptSecret(cfg.encToken) },
      body: JSON.stringify({ query: WEBHOOK_SUB, variables: { topic, sub: { callbackUrl: `${SITE_URL}/api/webhooks/shopify`, format: 'JSON' } } }),
    }).then((r) => r.json()).catch(() => null);
    const errs = res?.data?.webhookSubscriptionCreate?.userErrors;
    report.push(`webhook ${topic}: ${errs?.length ? errs[0].message : 'registered'}`);
  }
  await updateRecord(TABLES.RANCHERS, input.rancherId, { 'Fulfillment Integration': JSON.stringify(cfg) });
  report.push(`Saved (${input.mode} mode${input.markupPercent != null ? `, ${input.markupPercent}% markup` : ''}).`);
  return { ok: true, report };
}
```

- [ ] **Step 2: Telegram command wiring** — in the message-command block of `app/api/webhooks/telegram/route.ts` (find where `/onboard` is parsed), add `/connectstore`; resolve rancher by name/email the same way `/setuppage` does; call `connectShopifyStore`; reply with the report; delete Ben's message afterward if the chat API allows (token hygiene — the token was pasted into chat; note in reply: "rotate the token if this chat is ever exposed").
- [ ] **Step 3: SKU dry-run for sync-mode connects:** after saving, if mode=sync, immediately run Task 9's `syncShopifyCatalog(rancherId, { dryRun: true })` and append its report ("14 products importable, 2 skipped: no SKU").
- [ ] **Step 4: tsc + tests + build → PR-D ships.** (Smoke-test gate extension from the original plan doc §5 PR-D rides here too: add a `shopify-auth` gate to `lib/paymentPathSmoke.ts` `runPaymentPathSmoke` for ranchers with an integration — `validateConfig` ok → gate passes.)

### Task 9: Catalog sync engine (sync mode)

**Files:**
- Create: `lib/shopifyCatalogSync.ts` (mapper pure + engine)
- Test: `lib/shopifyCatalogSync.test.ts` (mapper only)
- Create: `app/api/cron/shopify-catalog-sync/route.ts` (every 6h; also invoked single-product from the PRODUCTS_UPDATE webhook topic in Task 7's route — add topic branch calling `syncOneProduct`)
- Modify: `vercel.json` + `lib/cronIntrospection.ts`

- [ ] **Step 1: Failing mapper tests**

```ts
// lib/shopifyCatalogSync.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapVariantToProductFields, computeDisplayPrice } from './shopifyCatalogSync';

test('markup pricing: base 100, 30% → 129.99', () => {
  assert.equal(computeDisplayPrice(100, 30), 129.99);
});
test('null markup returns null (leave Display Price alone)', () => {
  assert.equal(computeDisplayPrice(100, null), null);
});
test('variant maps to Rancher Products fields', () => {
  const f = mapVariantToProductFields({
    product: { id: 'gid://shopify/Product/1', title: 'Beef Box', status: 'ACTIVE', description: 'Good beef', featuredMedia: { preview: { image: { url: 'https://cdn/x.jpg' } } } },
    variant: { id: 'gid://shopify/ProductVariant/2', title: '10 lb', sku: 'BOX-10', price: '95.00', inventoryQuantity: 12 },
    markupPercent: 30,
  });
  assert.equal(f['Product Name'], 'Beef Box — 10 lb');
  assert.equal(f['External SKU'], 'BOX-10');
  assert.equal(f['Rancher Base'], 95);
  assert.equal(f['Display Price'], 123.49);
  assert.equal(f['Orders Left'], 12);
  assert.equal(f['Sync Managed'], true);
  assert.equal(f['Active'], true);
});
test('zero inventory or non-ACTIVE product maps Active:false', () => {
  const f = mapVariantToProductFields({ product: { id: 'p', title: 'X', status: 'DRAFT' }, variant: { id: 'v', title: 'Default Title', sku: 'S', price: '10', inventoryQuantity: 0 }, markupPercent: null });
  assert.equal(f['Active'], false);
});
```

- [ ] **Step 2: Implementation (mapper + engine):**

```ts
// lib/shopifyCatalogSync.ts
//
// Sync-mode import: rancher's Shopify catalog → Rancher Products rows.
// Dedupe key = (Rancher Record ID, External SKU). 'Sync Managed' marks rows
// this engine owns — it NEVER touches hand-created rows, and hand edits to
// Display Price survive when markupPercent is null. Variants without a SKU
// are skipped (reported) — SKU is the join key for order push.

import { getAllRecords, createRecord, updateRecord, TABLES, escapeAirtableValue } from './airtable';
import { parseIntegration } from './fulfillmentConnector';
import { decryptSecret } from './integrationCrypto';

export function computeDisplayPrice(base: number, markupPercent: number | null): number | null {
  if (markupPercent == null) return null;
  return Math.ceil(base * (1 + markupPercent / 100)) - 0.01;
}

export function mapVariantToProductFields(input: { product: any; variant: any; markupPercent: number | null }): Record<string, any> {
  const { product, variant, markupPercent } = input;
  const base = Number(variant.price || 0);
  const name = variant.title && variant.title !== 'Default Title'
    ? `${product.title} — ${variant.title}` : String(product.title || 'Product');
  const qty = Number(variant.inventoryQuantity ?? 0);
  const display = computeDisplayPrice(base, markupPercent);
  return {
    'Product Name': name,
    'External SKU': String(variant.sku || '').trim(),
    'External Product Id': String(product.id || ''),
    'Rancher Base': base,
    ...(display != null ? { 'Display Price': display } : {}),
    'Orders Left': Math.max(0, qty),
    'Active': product.status === 'ACTIVE' && qty > 0,
    'Sync Managed': true,
    'Last Synced At': new Date().toISOString(),
    ...(product?.featuredMedia?.preview?.image?.url ? { 'Image URL': product.featuredMedia.preview.image.url } : {}),
    ...(product?.description ? { 'Description': String(product.description).slice(0, 2000) } : {}),
  };
}

const PRODUCTS_PAGE = `query($cursor: String) {
  products(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title status description
      featuredMedia { preview { image { url } } }
      variants(first: 50) { nodes { id title sku price inventoryQuantity } }
    }
  }
}`;

export async function syncShopifyCatalog(rancherId: string, opts?: { dryRun?: boolean }): Promise<{ imported: number; updated: number; skippedNoSku: number; report: string[] }> {
  const { getRecordById } = await import('./airtable');
  const rancher = await getRecordById(TABLES.RANCHERS, rancherId);
  const cfg = parseIntegration(rancher?.['Fulfillment Integration']);
  if (!cfg || cfg.mode !== 'sync') return { imported: 0, updated: 0, skippedNoSku: 0, report: ['not in sync mode'] };
  const rancherName = String(rancher['Ranch Name'] || rancher['Operator Name'] || '');

  const existing = (await getAllRecords(
    TABLES.RANCHER_PRODUCTS,
    `{Rancher Record ID} = "${escapeAirtableValue(rancherId)}"`,
  )) as any[];
  const bySku = new Map(existing.filter((r) => String(r['External SKU'] || '').trim()).map((r) => [String(r['External SKU']).trim(), r]));

  let imported = 0, updated = 0, skippedNoSku = 0, cursor: string | null = null;
  do {
    const res: any = await fetch(`https://${cfg.shop}/admin/api/2026-01/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': decryptSecret(cfg.encToken) },
      body: JSON.stringify({ query: PRODUCTS_PAGE, variables: { cursor } }),
    }).then((r) => r.json());
    const page = res?.data?.products;
    if (!page) break;
    for (const product of page.nodes || []) {
      for (const variant of product.variants?.nodes || []) {
        if (!String(variant.sku || '').trim()) { skippedNoSku++; continue; }
        const fields = mapVariantToProductFields({ product, variant, markupPercent: cfg.markupPercent ?? null });
        const row = bySku.get(fields['External SKU']);
        if (opts?.dryRun) { row ? updated++ : imported++; continue; }
        if (row) {
          if (row['Sync Managed'] === true) { await updateRecord(TABLES.RANCHER_PRODUCTS, row.id, fields); updated++; }
        } else {
          await createRecord(TABLES.RANCHER_PRODUCTS, { ...fields, 'Rancher Record ID': rancherId, 'Rancher Name': rancherName });
          imported++;
        }
      }
    }
    cursor = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return { imported, updated, skippedNoSku, report: [`imported ${imported}, updated ${updated}, no-SKU skipped ${skippedNoSku}`] };
}
```

- [ ] **Step 3: Cron** — `app/api/cron/shopify-catalog-sync/route.ts`: standard pattern; find sync-mode ranchers via `FIND('"mode":"sync"', {Fulfillment Integration})`, loop `syncShopifyCatalog`, report per-rancher counts. `vercel.json` schedule `55 */6 * * *` (verify free). Add PRODUCTS_UPDATE branch in the Task-7 webhook route → targeted `syncShopifyCatalog(rancherId)` (full resync is cheap at these catalog sizes; per-product surgical sync is YAGNI).
- [ ] **Step 4: The Stripe-price landmine:** synced rows have no `Stripe Price Id` — CONFIRM at build time that `app/api/checkout/product/buy/route.ts:82-86` lazily creates Stripe Product/Price when blank (investigation says it writes the trio at buy time). If it errors on blank instead, add the lazy-create there. This is a MUST-VERIFY, not an assumption.
- [ ] **Step 5: tsc + tests + REAL build → PR-E ships.**

### Task 10: Pilot proof (merch store) — no code, runbook

- [ ] Create custom app in merch.buyhalfcow.com admin (Settings → Apps → Develop apps): scopes `write_orders, read_orders, read_products` (+ `write_products` NOT needed), install, copy Admin token + API secret.
- [ ] `/connectstore` against a TEST rancher row (create one, Active off) in manual mode; put a real merch SKU in a test Rancher Products row.
- [ ] Buy the product through BHC checkout with a real card ($ smallest item), verify: Shopify order appears PAID + tagged BHC + inventory decremented; fulfill it in Shopify admin with a tracking number; verify BHC row flips Shipped + tracking within a minute; verify buyer got exactly ONE receipt (BHC) and ONE shipping email (Shopify).
- [ ] Refund via Stripe; verify Shopify order auto-cancels + restocks and `External Push Status` = 'cancelled'.
- [ ] Only after all four proofs: first distributor conversation.

---

## Self-review notes (done at authoring)
- Spec coverage: upfront-margin model (unchanged rail, stated), two modes (Task 2 config + Task 9 sync / manual via `External SKU`), customizable per-operation (markup, mode, provider registry), refund leg (Task 6), tracking leg (Task 7), onboarding (Task 8), pilot (Task 10). Gap deliberately deferred: multi-line-item carts (rail is single-product per PI today — connector maps 1 line item; revisit when cart exists).
- Types consistent: `IntegrationConfig`/`PushOrderInput`/`PushResult` defined Task 2, consumed Tasks 3-9 with same names.
- Every Airtable field written by code appears in the pre-merge creation table.
- Known must-verifies at build time: side-effect insertion point in `productSettlement.ts` (~:370), lazy Stripe price creation (Task 9 Step 4), free cron minutes, Ranchers table id.
