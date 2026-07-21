import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import {
  isValidShopDomain,
  mintInstallLinkToken,
  verifyInstallLinkToken,
  mintOauthState,
  verifyOauthState,
  verifyOauthCallbackHmac,
  buildAuthorizeUrl,
  parsePendingIntegration,
  SHOPIFY_OAUTH_SCOPES,
} from './shopifyOauth';
import { mintDepositGrantToken } from './campaignReserve';

// ── shop domain ────────────────────────────────────────────────────────────

test('shop domain: valid forms pass', () => {
  assert.equal(isValidShopDomain('x.myshopify.com'), true);
  assert.equal(isValidShopDomain('3gapis-dx.myshopify.com'), true);
  assert.equal(isValidShopDomain('Ranch-1.myshopify.com'), true);
});

test('shop domain: spoofs and junk fail (anchored both ends)', () => {
  assert.equal(isValidShopDomain('x.myshopify.com.evil.com'), false);
  assert.equal(isValidShopDomain('evil.com/x.myshopify.com'), false);
  assert.equal(isValidShopDomain('https://x.myshopify.com'), false);
  assert.equal(isValidShopDomain('x.myshopify.co'), false);
  assert.equal(isValidShopDomain('-bad.myshopify.com'), false);
  assert.equal(isValidShopDomain(''), false);
  assert.equal(isValidShopDomain(null), false);
  assert.equal(isValidShopDomain('a'.repeat(120) + '.myshopify.com'), false);
});

// ── tokens ─────────────────────────────────────────────────────────────────

test('install link token roundtrip + purpose isolation', () => {
  const t = mintInstallLinkToken({ rancherId: 'rec4pnnjfp2nTaS1V' });
  const v = verifyInstallLinkToken(t);
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.payload.rancherId, 'rec4pnnjfp2nTaS1V');
  // A deposit-grant token must not open the install flow.
  const cross = verifyInstallLinkToken(
    mintDepositGrantToken({ consumerId: 'recC', referralId: 'recR' }),
  );
  assert.equal(cross.ok, false);
  // Nor may an install link act as oauth state (different purpose).
  assert.equal(verifyOauthState(t).ok, false);
});

test('oauth state roundtrip; missing nonce/rancher rejected at mint', () => {
  const t = mintOauthState({ rancherId: 'recA', nonce: 'n123' });
  const v = verifyOauthState(t);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.payload.rancherId, 'recA');
    assert.equal(v.payload.nonce, 'n123');
  }
  assert.throws(() => mintOauthState({ rancherId: '', nonce: 'x' }));
  assert.throws(() => mintOauthState({ rancherId: 'recA', nonce: '' }));
  assert.equal(verifyOauthState('garbage').ok, false);
  assert.equal(verifyOauthState(null).ok, false);
});

// ── callback HMAC (docs example shape) ─────────────────────────────────────

function signQuery(query: Record<string, string>, secret: string): string {
  const msg = Object.keys(query)
    .filter((k) => k !== 'hmac')
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&');
  return createHmac('sha256', secret).update(msg, 'utf8').digest('hex');
}

test('callback hmac: valid signature passes', () => {
  const secret = 'my_client_secret';
  const query: Record<string, string> = {
    code: '0907a61c0c8d55e99db179b68161bc00',
    shop: 'some-shop.myshopify.com',
    state: 'abc',
    timestamp: '1337178173',
  };
  query.hmac = signQuery(query, secret);
  assert.equal(verifyOauthCallbackHmac(query, secret), true);
});

test('callback hmac: tampered param / wrong secret / missing hmac fail', () => {
  const secret = 'my_client_secret';
  const query: Record<string, string> = {
    code: 'abc',
    shop: 'some-shop.myshopify.com',
    state: 's',
    timestamp: '1',
  };
  query.hmac = signQuery(query, secret);
  assert.equal(verifyOauthCallbackHmac({ ...query, shop: 'evil.myshopify.com' }, secret), false);
  assert.equal(verifyOauthCallbackHmac(query, 'other_secret'), false);
  const { hmac: _drop, ...noHmac } = query;
  assert.equal(verifyOauthCallbackHmac(noHmac as any, secret), false);
  assert.equal(verifyOauthCallbackHmac(query, ''), false);
});

test('callback hmac: extra unexpected params are covered by the signature', () => {
  // Docs: params are subject to change — verification must include whatever
  // arrives, not a hardcoded list.
  const secret = 's';
  const query: Record<string, string> = {
    code: 'c',
    shop: 'x.myshopify.com',
    state: 's',
    timestamp: '1',
    host: 'aGVsbG8',
  };
  query.hmac = signQuery(query, secret);
  assert.equal(verifyOauthCallbackHmac(query, secret), true);
  assert.equal(verifyOauthCallbackHmac({ ...query, host: 'tampered' }, secret), false);
});

// ── authorize URL ──────────────────────────────────────────────────────────

test('authorize URL carries client_id, scopes, redirect, state — encoded', () => {
  const url = buildAuthorizeUrl({
    shop: 'x.myshopify.com',
    clientId: 'cid123',
    redirectUri: 'https://www.buyhalfcow.com/api/shopify/oauth/callback',
    state: 'sta+te',
  });
  const u = new URL(url);
  assert.equal(u.origin, 'https://x.myshopify.com');
  assert.equal(u.pathname, '/admin/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), 'cid123');
  assert.equal(u.searchParams.get('scope'), SHOPIFY_OAUTH_SCOPES);
  assert.equal(u.searchParams.get('redirect_uri'), 'https://www.buyhalfcow.com/api/shopify/oauth/callback');
  assert.equal(u.searchParams.get('state'), 'sta+te');
});

// ── pending config ─────────────────────────────────────────────────────────

const pendingGood = JSON.stringify({
  v: 1, provider: 'shopify', pending: true, shop: '3gapis-dx.myshopify.com',
  clientId: 'cid', encClientSecret: 'v1:a:b:c', mode: 'sync', markupPercent: 25,
});

test('pending config parses; completed config is NOT pending', () => {
  const p = parsePendingIntegration(pendingGood);
  assert.equal(p?.shop, '3gapis-dx.myshopify.com');
  assert.equal(p?.mode, 'sync');
  assert.equal(p?.markupPercent, 25);
  const completed = JSON.stringify({
    v: 1, provider: 'shopify', shop: 'x.myshopify.com',
    encToken: 'v1:a:b:c', encApiSecret: 'v1:a:b:c', mode: 'manual',
  });
  assert.equal(parsePendingIntegration(completed), null);
});

test('pending config rejects malformed / bad shop / missing creds', () => {
  assert.equal(parsePendingIntegration(''), null);
  assert.equal(parsePendingIntegration('{nope'), null);
  assert.equal(
    parsePendingIntegration(JSON.stringify({ v: 1, provider: 'shopify', pending: true, shop: 'evil.com', clientId: 'c', encClientSecret: 'e', mode: 'sync' })),
    null,
  );
  assert.equal(
    parsePendingIntegration(JSON.stringify({ v: 1, provider: 'shopify', pending: true, shop: 'x.myshopify.com', clientId: '', encClientSecret: 'e', mode: 'sync' })),
    null,
  );
});

test('pending config never satisfies the ACTIVE connector parser', () => {
  // The live-money invariant: a half-installed store must leave the connector
  // inert. parseIntegration requires encToken, pending has none.
  const { parseIntegration } = require('./fulfillmentConnector');
  assert.equal(parseIntegration(pendingGood), null);
});

test('public-app state carries pub/mode/markup/shop and roundtrips', () => {
  const t = mintOauthState({ rancherId: 'recA', nonce: 'n1', pub: true, mode: 'sync', markupPercent: 25, shop: 'x.myshopify.com' });
  const v = verifyOauthState(t);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.payload.pub, true);
    assert.equal(v.payload.mode, 'sync');
    assert.equal(v.payload.markupPercent, 25);
    assert.equal(v.payload.shop, 'x.myshopify.com');
  }
  const plain = verifyOauthState(mintOauthState({ rancherId: 'recA', nonce: 'n1' }));
  if (plain.ok) {
    assert.equal(plain.payload.pub, false);
    assert.equal(plain.payload.mode, undefined);
  }
});
