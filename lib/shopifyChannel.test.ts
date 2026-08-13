import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_SPECIFICATION_HANDLE,
  channelHandleForRancher,
  isAlreadyExistsChannelError,
  productFeedbackDecision,
  pickFeedbackToSend,
  isBhcCallbackUrl,
  FEEDBACK_SEND_CAP,
  type ProductFeedbackTask,
} from './shopifyChannel';
import { parseIntegration } from './fulfillmentConnector';

// ── channelHandleForRancher ─────────────────────────────────────────────────

test('channelHandleForRancher is deterministic and spec-prefixed', () => {
  const h1 = channelHandleForRancher('recAbC123XyZ');
  const h2 = channelHandleForRancher('recAbC123XyZ');
  assert.equal(h1, h2);
  assert.ok(h1.startsWith(`${CHANNEL_SPECIFICATION_HANDLE}-`));
  assert.equal(h1, 'buyhalfcow-us-recabc123xyz');
});

test('channelHandleForRancher sanitizes to handle-safe chars', () => {
  const h = channelHandleForRancher('rec_A!B c/D');
  assert.match(h, /^[a-z0-9-]+$/);
});

test('channelHandleForRancher never emits a bare spec handle on blank input', () => {
  // A blank id must not collide the connection handle with the specification
  // handle itself (or with another blank-id rancher's — but blank never
  // reaches it in practice; this is the defensive floor).
  assert.equal(channelHandleForRancher(''), 'buyhalfcow-us-account');
});

// ── isAlreadyExistsChannelError ─────────────────────────────────────────────

test('isAlreadyExistsChannelError treats taken/exists flavors as idempotent success', () => {
  assert.equal(isAlreadyExistsChannelError('Handle has already been taken'), true);
  assert.equal(isAlreadyExistsChannelError('Channel already exists for this account'), true);
  assert.equal(isAlreadyExistsChannelError('duplicate handle'), true);
  assert.equal(isAlreadyExistsChannelError('Access denied for channelCreate'), false);
  assert.equal(isAlreadyExistsChannelError(''), false);
  assert.equal(isAlreadyExistsChannelError(null), false);
});

// ── productFeedbackDecision ─────────────────────────────────────────────────

test('productFeedbackDecision: no variants → no feedback', () => {
  assert.equal(productFeedbackDecision([]), null);
});

test('productFeedbackDecision: any listed variant → ACCEPTED with no message', () => {
  const d = productFeedbackDecision(['no-sku', 'listed', 'guard-blocked']);
  assert.equal(d?.state, 'ACCEPTED');
  assert.equal(d?.message, undefined);
});

test('productFeedbackDecision: all no-sku → REQUIRES_ACTION with the SKU message', () => {
  const d = productFeedbackDecision(['no-sku', 'no-sku']);
  assert.equal(d?.state, 'REQUIRES_ACTION');
  assert.match(String(d?.message), /SKU/);
});

test('productFeedbackDecision: all guard-blocked → REQUIRES_ACTION with the deposit-flow message', () => {
  const d = productFeedbackDecision(['guard-blocked']);
  assert.equal(d?.state, 'REQUIRES_ACTION');
  assert.match(String(d?.message), /deposit/i);
});

test('productFeedbackDecision: mixed blocked reasons pick the dominant one', () => {
  const skuDominant = productFeedbackDecision(['no-sku', 'no-sku', 'guard-blocked']);
  assert.match(String(skuDominant?.message), /SKU/);
  const guardDominant = productFeedbackDecision(['guard-blocked', 'guard-blocked', 'no-sku']);
  assert.match(String(guardDominant?.message), /deposit/i);
});

test('productFeedbackDecision messages stay within the feedback API length cap', () => {
  // ResourceFeedback messages are capped (~100 chars) — an over-long message
  // makes the whole mutation error and the merchant sees NOTHING.
  for (const outcomes of [['no-sku'], ['guard-blocked']] as const) {
    const d = productFeedbackDecision([...outcomes]);
    assert.ok(String(d?.message).length <= 100, `message too long: ${d?.message}`);
  }
});

// ── pickFeedbackToSend ──────────────────────────────────────────────────────

function task(state: 'ACCEPTED' | 'REQUIRES_ACTION', n: number): ProductFeedbackTask {
  return {
    productGid: `gid://shopify/Product/${n}`,
    productUpdatedAt: '2026-08-01T00:00:00Z',
    decision: state === 'ACCEPTED' ? { state } : { state, message: 'x' },
  };
}

test('pickFeedbackToSend prioritizes REQUIRES_ACTION over ACCEPTED under the cap', () => {
  const tasks = [task('ACCEPTED', 1), task('REQUIRES_ACTION', 2), task('ACCEPTED', 3), task('REQUIRES_ACTION', 4)];
  const picked = pickFeedbackToSend(tasks, 3);
  assert.equal(picked.length, 3);
  assert.equal(picked[0].decision.state, 'REQUIRES_ACTION');
  assert.equal(picked[1].decision.state, 'REQUIRES_ACTION');
  assert.equal(picked[2].decision.state, 'ACCEPTED');
});

test('pickFeedbackToSend sends everything when under the cap', () => {
  const tasks = [task('ACCEPTED', 1), task('REQUIRES_ACTION', 2)];
  assert.equal(pickFeedbackToSend(tasks).length, 2);
  assert.ok(FEEDBACK_SEND_CAP >= 2);
});

test('pickFeedbackToSend hard-caps and tolerates garbage', () => {
  const tasks = Array.from({ length: 100 }, (_, i) => task('ACCEPTED', i));
  assert.equal(pickFeedbackToSend(tasks).length, FEEDBACK_SEND_CAP);
  assert.deepEqual(pickFeedbackToSend(null as any), []);
  assert.deepEqual(pickFeedbackToSend(tasks, 0), []);
});

// ── isBhcCallbackUrl ────────────────────────────────────────────────────────

test('isBhcCallbackUrl matches the BHC receiver path on any deploy host', () => {
  assert.equal(isBhcCallbackUrl('https://www.buyhalfcow.com/api/webhooks/shopify'), true);
  assert.equal(isBhcCallbackUrl('https://preview-abc.vercel.app/api/webhooks/shopify'), true);
  assert.equal(isBhcCallbackUrl('https://example.com/api/webhooks/other'), false);
  assert.equal(isBhcCallbackUrl(undefined), false);
  assert.equal(isBhcCallbackUrl(null), false);
});

// ── parseIntegration installSource passthrough ──────────────────────────────

test('parseIntegration passes installSource through (oauth / token-paste / garbage→null)', () => {
  const base = {
    v: 1,
    provider: 'shopify',
    shop: 'x.myshopify.com',
    encToken: 'enc',
    encApiSecret: 'enc2',
    mode: 'sync',
  };
  assert.equal(parseIntegration(JSON.stringify({ ...base, installSource: 'oauth' }))?.installSource, 'oauth');
  assert.equal(
    parseIntegration(JSON.stringify({ ...base, installSource: 'token-paste' }))?.installSource,
    'token-paste',
  );
  assert.equal(parseIntegration(JSON.stringify({ ...base, installSource: 'evil' }))?.installSource, null);
  assert.equal(parseIntegration(JSON.stringify(base))?.installSource, null);
});
