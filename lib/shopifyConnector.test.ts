import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitShipTo, classifyGqlErrors, orderIdempotencyKey, matchExistingBhcOrder, bhcOrderTag } from './shopifyConnector';

// Real writer format (lib/productSettlement.ts formatShipping):
// name \n line1 [\n line2] \n "City, ST, 12345"
test('splitShipTo parses the formatShipping comma format (name skipped)', () => {
  const a = splitShipTo('Jane Doe\n123 Main St\nAustin, TX, 78701');
  assert.equal(a.address1, '123 Main St');
  assert.equal(a.city, 'Austin');
  assert.equal(a.provinceCode, 'TX');
  assert.equal(a.zip, '78701');
});

test('splitShipTo also accepts space-separated state+zip', () => {
  const a = splitShipTo('Jane Doe\n123 Main St\nAustin, TX 78701');
  assert.equal(a.city, 'Austin');
  assert.equal(a.zip, '78701');
});

test('splitShipTo keeps line2 + handles zip+4 + lowercase state', () => {
  const a = splitShipTo('Jane Doe\n456 Oak Ave\nApt 2\nDenver, co, 80202-1234');
  assert.equal(a.address1, '456 Oak Ave');
  assert.equal(a.address2, 'Apt 2');
  assert.equal(a.city, 'Denver');
  assert.equal(a.provinceCode, 'CO');
  assert.equal(a.zip, '80202-1234');
});

test('splitShipTo without name line (2 lines) uses first line as street', () => {
  const a = splitShipTo('123 Main St\nAustin, TX, 78701');
  assert.equal(a.address1, '123 Main St');
  assert.equal(a.city, 'Austin');
});

test('splitShipTo degrades to address1 blob when unparseable', () => {
  const a = splitShipTo('weird single line no commas');
  assert.equal(a.address1, 'weird single line no commas');
  assert.equal(a.city, undefined);
});

test('classifyGqlErrors: userErrors permanent, throttle/5xx transient, auth permanent', () => {
  assert.deepEqual(classifyGqlErrors({ userErrors: [{ message: 'sku bad' }] }, 200), { permanent: true, error: 'sku bad' });
  assert.equal(classifyGqlErrors(null, 429).permanent, false);
  assert.equal(classifyGqlErrors(null, 502).permanent, false);
  assert.equal(classifyGqlErrors(null, 401).permanent, true);
  assert.equal(classifyGqlErrors(null, 404).permanent, true);
  assert.equal(classifyGqlErrors({ userErrors: [] }, 200).permanent, false);
});

// ── H1(a): a STABLE, UNIQUE idempotency key per order — the same dedupToken
// (row id) always hashes to the same key (a retried orderCreate is deduped by
// Shopify), two different orders never collide EVEN when their Order Ref is
// identical (repeat buyer, same product).
test('orderIdempotencyKey is stable per dedupToken and distinct across orders', () => {
  const a1 = orderIdempotencyKey('recORDER1');
  const a2 = orderIdempotencyKey('recORDER1');
  const b = orderIdempotencyKey('recORDER2');
  assert.equal(a1, a2, 'same token → same key (retry-safe)');
  assert.notEqual(a1, b, 'different token → different key (two orders both ship)');
  assert.match(a1, /^bhc-[0-9a-f]{40}$/, 'namespaced, deterministic hex');
});

// ── BLOCKER FIX: dedup keys on the UNIQUE `BHC-oid:<dedupToken>` tag, never on
// the non-unique Order Ref. Two orders that share an Order Ref (repeat buyer of
// the same product) but differ in dedupToken must NOT false-short-circuit — else
// the 2nd order never ships (under-ship). A genuine retry of the SAME order
// (same token) MUST short-circuit onto its own prior create (no double-ship).
test('matchExistingBhcOrder finds an order by its unique BHC-oid tag (same-order retry)', () => {
  const nodes = [
    { id: 'gid://shopify/Order/1', tags: ['BHC', bhcOrderTag('recORDER1')] },
  ];
  assert.equal(matchExistingBhcOrder(nodes, 'recORDER1'), 'gid://shopify/Order/1');
});

test('BLOCKER: two orders sharing an Order Ref but different tokens do NOT collide', () => {
  // The store holds order #1 for a repeat buyer's FIRST "Beef Box — Jane Doe".
  const store = [
    { id: 'gid://shopify/Order/1', tags: ['BHC', bhcOrderTag('recORDER1')] },
  ];
  // Pushing the SECOND identical-Order-Ref order (recORDER2) must NOT match #1.
  assert.equal(matchExistingBhcOrder(store, 'recORDER2'), null, 'repeat-buyer 2nd order must still push (no under-ship)');
  // …and the 2nd order once created matches only its OWN token.
  const after = [...store, { id: 'gid://shopify/Order/2', tags: ['BHC', bhcOrderTag('recORDER2')] }];
  assert.equal(matchExistingBhcOrder(after, 'recORDER2'), 'gid://shopify/Order/2');
  assert.equal(matchExistingBhcOrder(after, 'recORDER1'), 'gid://shopify/Order/1');
});

test('matchExistingBhcOrder is case-insensitive on the tag and ignores blanks', () => {
  const nodes = [
    { id: 'gid://shopify/Order/9', tags: ['BHC', 'bhc-oid:recorder9'] }, // Shopify may return normalized case
  ];
  assert.equal(matchExistingBhcOrder(nodes, 'recORDER9'), 'gid://shopify/Order/9');
  assert.equal(matchExistingBhcOrder(nodes, ''), null, 'blank token never matches (no false short-circuit)');
  assert.equal(matchExistingBhcOrder([], 'recX'), null);
  // an order WITHOUT the oid tag (only the plain BHC tag) is never a dedup match
  assert.equal(matchExistingBhcOrder([{ id: 'gid://shopify/Order/10', tags: ['BHC'] }], 'recORDER10'), null);
});

// ── Source-shape pins (H1a/H1b): the connector must SEND the idempotency header
// on orderCreate and RUN the pre-create dedup before creating. A silent revert
// to a bare create (the double-ship regression) shows up here.
const connSrc = readFileSync(fileURLToPath(new URL('./shopifyConnector.ts', import.meta.url)), 'utf8');

test('pushOrder sends a UNIQUE-token idempotency key + stamps the unique dedup tag', () => {
  assert.match(connSrc, /Idempotency-Key/, 'orderCreate must carry an Idempotency-Key header');
  assert.match(connSrc, /orderIdempotencyKey\(order\.dedupToken\)/, 'idempotency key is keyed on the unique token, not orderRef');
  assert.match(connSrc, /\['BHC',\s*bhcOrderTag\(order\.dedupToken\)\]/, 'the created order carries plain BHC + the unique BHC-oid dedup tag');
  assert.match(connSrc, /:\s*\['BHC'\]/, "keep the plain 'BHC' tag (blank-token fallback) so #468 B3 still skips BHC-origin orders");
});

test('pushOrder runs the token-keyed pre-create dedup short-circuit before creating', () => {
  assert.match(connSrc, /findExistingBhcOrder\(cfg,\s*order\.dedupToken\)/, 'dedup search keys on the unique token, never orderRef');
  assert.match(connSrc, /return\s*{\s*ok:\s*true,\s*externalOrderId/, 'a found order short-circuits with its external id');
  assert.doesNotMatch(connSrc, /findExistingBhcOrder\([^)]*orderRef/, 'the pre-create dedup must NOT key on the non-unique orderRef');
});
