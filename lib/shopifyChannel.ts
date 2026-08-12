// Sales-channel plumbing (Shopify App Store review 128658, rule 4.5.1).
// Three jobs, all best-effort and FAIL-SOFT — none of them may ever break the
// fulfillment connect, the catalog sync, or the order push (money rails):
//
//   1. Channel connections — channelCreate binds an OAuth-installed shop to
//      the deployed 'buyhalfcow-us' channel specification (channel_config
//      extension, version buyhalfcow-5) so the shop gets its BuyHalfCow
//      channel, product feeds, and order-attribution definition. Idempotent:
//      an existing connection short-circuits (channels query is app-scoped —
//      a channel app can only see its own connections).
//   2. ResourceFeedback (checklist 5.7.3) — per-product publish feedback so
//      merchants see "why isn't this listed" in THEIR admin, not just ours.
//   3. Disconnect cleanup (checklist 5.7.12) — unregister our webhooks and
//      delete the channel connection when a rancher self-serve disconnects.
//
// API version: the channel-connection / attribution / feedback APIs need
// 2026-07+ (shopify.dev order-attribution Requirements). The order-push
// connector (lib/shopifyConnector) stays on its own pinned 2026-01 —
// deliberately untouched.

import type { IntegrationConfig } from './fulfillmentConnector';
import { decryptSecret } from './integrationCrypto';

export const CHANNEL_API_VERSION = '2026-07';

/** Handle of the channel specification deployed in the channel_config
 *  extension (extension release buyhalfcow-5). channelCreate's
 *  specificationHandle must match it exactly. */
export const CHANNEL_SPECIFICATION_HANDLE = 'buyhalfcow-us';

async function gql(
  cfg: IntegrationConfig,
  query: string,
  variables: any,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`https://${cfg.shop}/admin/api/${CHANNEL_API_VERSION}/graphql.json`, {
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

// ---------------------------------------------------------------------------
// Channel connections
// ---------------------------------------------------------------------------

/** Deterministic per-rancher channel handle: same rancher → same handle on
 *  every (re-)connect, so channelCreate can never mint duplicates and the
 *  handle survives as a stable order-attribution identity. */
export function channelHandleForRancher(rancherId: string): string {
  const id = String(rancherId || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  return `${CHANNEL_SPECIFICATION_HANDLE}-${id || 'account'}`;
}

/** Shopify wording for "this connection already exists" varies — treat any
 *  taken/exists flavor as the idempotent success it is. */
export function isAlreadyExistsChannelError(msg: unknown): boolean {
  return /taken|already|exist|duplicate/i.test(String(msg || ''));
}

const CHANNELS_QUERY = `query { channels(first: 25) { nodes { id handle } } }`;

const CHANNEL_CREATE = `mutation ChannelCreate($input: ChannelCreateInput!) {
  channelCreate(input: $input) {
    channel { id handle }
    userErrors { field message code }
  }
}`;

const CHANNEL_DELETE = `mutation ChannelDelete($id: ID!) {
  channelDelete(id: $id) {
    deletedId
    userErrors { field message }
  }
}`;

export interface ChannelEnsureResult {
  ok: boolean;
  existing?: boolean;
  handle?: string;
  error?: string;
}

/** Create the shop's BuyHalfCow channel connection if it doesn't exist yet.
 *  Callers treat a failure as report-and-continue — never fatal. */
export async function ensureChannelConnection(
  cfg: IntegrationConfig,
  rancherId: string,
  accountName: string,
): Promise<ChannelEnsureResult> {
  // Idempotency: our app's existing connections on this shop (the channels
  // query never returns other apps' channels). Any hit means connected.
  try {
    const list = await gql(cfg, CHANNELS_QUERY, {});
    const nodes = list.body?.data?.channels?.nodes;
    if (list.status === 200 && Array.isArray(nodes) && nodes.length > 0) {
      return { ok: true, existing: true, handle: String(nodes[0]?.handle || '') };
    }
  } catch { /* list is best-effort — fall through to create */ }

  const handle = channelHandleForRancher(rancherId);
  try {
    const { status, body } = await gql(cfg, CHANNEL_CREATE, {
      input: {
        handle,
        specificationHandle: CHANNEL_SPECIFICATION_HANDLE,
        accountId: String(rancherId),
        accountName: String(accountName || cfg.shop).slice(0, 80),
      },
    });
    const payload = body?.data?.channelCreate;
    const userErrors = payload?.userErrors;
    if (status === 200 && payload?.channel?.id && !(userErrors?.length)) {
      return { ok: true, handle: String(payload.channel.handle || handle) };
    }
    const topErrs = body?.errors;
    const msg = (
      Array.isArray(userErrors) && userErrors.length
        ? userErrors.map((e: any) => e.message).join('; ')
        : Array.isArray(topErrs) && topErrs.length
          ? String(topErrs[0]?.message || 'graphql error')
          : `http ${status}`
    ).slice(0, 300);
    if (isAlreadyExistsChannelError(msg)) return { ok: true, existing: true, handle };
    return { ok: false, error: msg };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || 'network').slice(0, 300) };
  }
}

/** Delete every channel connection our app holds on this shop (self-serve
 *  disconnect, 5.7.12). Best-effort — errors are counted, never thrown. */
export async function deleteChannelConnections(
  cfg: IntegrationConfig,
): Promise<{ deleted: number; errors: number }> {
  let deleted = 0;
  let errors = 0;
  try {
    const list = await gql(cfg, CHANNELS_QUERY, {});
    const nodes = list.body?.data?.channels?.nodes;
    if (list.status !== 200 || !Array.isArray(nodes)) return { deleted, errors: errors + 1 };
    for (const node of nodes) {
      if (!node?.id) continue;
      try {
        const { status, body } = await gql(cfg, CHANNEL_DELETE, { id: String(node.id) });
        const ue = body?.data?.channelDelete?.userErrors;
        if (status === 200 && !(ue?.length)) deleted++;
        else errors++;
      } catch {
        errors++;
      }
    }
  } catch {
    errors++;
  }
  return { deleted, errors };
}

// ---------------------------------------------------------------------------
// ResourceFeedback (checklist 5.7.3)
// ---------------------------------------------------------------------------

/** What happened to one variant during a catalog sync pass. */
export type VariantListOutcome = 'listed' | 'no-sku' | 'guard-blocked';

export interface ProductFeedbackDecision {
  state: 'ACCEPTED' | 'REQUIRES_ACTION';
  /** REQUIRES_ACTION only. ResourceFeedback shows ONE message and caps it —
   *  keep it under 100 chars, actionable, and merchant-facing. */
  message?: string;
}

// Merchant-facing feedback copy. NEVER include product names/prices here —
// the message renders in THEIR admin, but this repo is public and the copy
// must stay generic anyway.
const MSG_NO_SKU = 'Not listed on BuyHalfCow: add a SKU to each variant — SKUs are required to list.';
const MSG_GUARD = 'Not listed on BuyHalfCow: shares and under-$5 items sell via the deposit flow instead.';

/** Decide the per-product feedback from its variants' sync outcomes.
 *  Any variant listed → ACCEPTED (clears a prior requires-action banner);
 *  everything blocked → REQUIRES_ACTION with the dominant reason;
 *  no variants at all → no feedback. */
export function productFeedbackDecision(
  outcomes: VariantListOutcome[],
): ProductFeedbackDecision | null {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return null;
  if (outcomes.some((o) => o === 'listed')) return { state: 'ACCEPTED' };
  const guard = outcomes.filter((o) => o === 'guard-blocked').length;
  const noSku = outcomes.filter((o) => o === 'no-sku').length;
  return { state: 'REQUIRES_ACTION', message: guard >= noSku ? MSG_GUARD : MSG_NO_SKU };
}

export interface ProductFeedbackTask {
  /** gid://shopify/Product/… exactly as the catalog query returned it. */
  productGid: string;
  /** The product's own updatedAt — Shopify uses it to drop stale feedback. */
  productUpdatedAt: string;
  decision: ProductFeedbackDecision;
}

/** Hard per-sync ceiling on feedback mutations, so a 2,000-SKU catalog can't
 *  turn every 6h sync into an API hammering. REQUIRES_ACTION always wins the
 *  budget; ACCEPTED clears fill the remainder. Typical rancher catalogs are
 *  well under the cap, so both set AND clear land every run. */
export const FEEDBACK_SEND_CAP = 40;

export function pickFeedbackToSend(
  tasks: ProductFeedbackTask[],
  cap: number = FEEDBACK_SEND_CAP,
): ProductFeedbackTask[] {
  const list = Array.isArray(tasks) ? tasks : [];
  const action = list.filter((t) => t?.decision?.state === 'REQUIRES_ACTION');
  const accepted = list.filter((t) => t?.decision?.state === 'ACCEPTED');
  return [...action, ...accepted].slice(0, Math.max(0, cap));
}

const PRODUCT_FEEDBACK_CREATE = `mutation($input: ProductResourceFeedbackInput!) {
  productResourceFeedbackCreate(input: $input) {
    userErrors { field message }
  }
}`;

/** Report one product's publish state into the merchant's admin. Best-effort:
 *  a failure is returned, never thrown, and callers never fail a sync on it. */
export async function sendProductResourceFeedback(
  cfg: IntegrationConfig,
  task: ProductFeedbackTask,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { status, body } = await gql(cfg, PRODUCT_FEEDBACK_CREATE, {
      input: {
        productId: task.productGid,
        state: task.decision.state,
        ...(task.decision.state === 'REQUIRES_ACTION' && task.decision.message
          ? { messages: [task.decision.message] }
          : {}),
        feedbackGeneratedAt: new Date().toISOString(),
        productUpdatedAt: task.productUpdatedAt,
      },
    });
    const ue = body?.data?.productResourceFeedbackCreate?.userErrors;
    if (status === 200 && !(ue?.length)) return { ok: true };
    const msg = Array.isArray(ue) && ue.length
      ? ue.map((e: any) => e.message).join('; ')
      : `http ${status}`;
    return { ok: false, error: msg.slice(0, 200) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || 'network').slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Webhook unregistration (self-serve disconnect, 5.7.12)
// ---------------------------------------------------------------------------

/** Is this callback URL one of OURS? The webhookSubscriptions query is
 *  app-scoped already; the path check is belt-and-suspenders so we never
 *  touch a subscription that isn't the BHC receiver (matches every deploy
 *  host — prod, preview — by path, not hostname). */
export function isBhcCallbackUrl(url: unknown): boolean {
  return String(url || '').includes('/api/webhooks/shopify');
}

const WEBHOOK_LIST = `query {
  webhookSubscriptions(first: 100) {
    nodes {
      id
      endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
    }
  }
}`;

const WEBHOOK_DELETE = `mutation($id: ID!) {
  webhookSubscriptionDelete(id: $id) {
    deletedWebhookSubscriptionId
    userErrors { message }
  }
}`;

/** Delete every BHC webhook subscription on this shop. Best-effort — errors
 *  counted, never thrown (a revoked token just yields zero deletions). */
export async function unregisterBhcWebhooks(
  cfg: IntegrationConfig,
): Promise<{ deleted: number; errors: number }> {
  let deleted = 0;
  let errors = 0;
  try {
    const list = await gql(cfg, WEBHOOK_LIST, {});
    const nodes = list.body?.data?.webhookSubscriptions?.nodes;
    if (list.status !== 200 || !Array.isArray(nodes)) return { deleted, errors: errors + 1 };
    for (const node of nodes) {
      if (!node?.id) continue;
      if (!isBhcCallbackUrl(node?.endpoint?.callbackUrl)) continue;
      try {
        const { status, body } = await gql(cfg, WEBHOOK_DELETE, { id: String(node.id) });
        const ue = body?.data?.webhookSubscriptionDelete?.userErrors;
        if (status === 200 && !(ue?.length)) deleted++;
        else errors++;
      } catch {
        errors++;
      }
    }
  } catch {
    errors++;
  }
  return { deleted, errors };
}
