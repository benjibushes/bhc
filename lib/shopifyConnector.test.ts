import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitShipTo, classifyGqlErrors, orderIdempotencyKey, matchExistingBhcOrder } from './shopifyConnector';

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

// ── H1(a): a STABLE idempotency key per order — the same orderRef always
// hashes to the same key (a retried orderCreate is deduped by Shopify), two
// different orders never collide.
test('orderIdempotencyKey is stable per orderRef and distinct across orders', () => {
  const a1 = orderIdempotencyKey('Beef Box — Jane Doe');
  const a2 = orderIdempotencyKey('Beef Box — Jane Doe');
  const b = orderIdempotencyKey('Beef Box — John Roe');
  assert.equal(a1, a2, 'same orderRef → same key (retry-safe)');
  assert.notEqual(a1, b, 'different orderRef → different key');
  assert.match(a1, /^bhc-[0-9a-f]{40}$/, 'namespaced, deterministic hex');
});

// ── H1(b): pre-create dedup — a lost-response retry must FIND the order the
// prior attempt already created (BHC-tagged, orderRef in the note) instead of
// creating a live duplicate (double physical ship).
test('matchExistingBhcOrder finds a BHC-tagged order whose note carries the orderRef', () => {
  const nodes = [
    { id: 'gid://shopify/Order/1', note: 'BuyHalfCow order Beef Box — Jane Doe — paid via BHC, fulfill as normal.', tags: ['BHC'] },
  ];
  assert.equal(matchExistingBhcOrder(nodes, 'Beef Box — Jane Doe'), 'gid://shopify/Order/1');
});

test('matchExistingBhcOrder ignores non-BHC, note-mismatch, and blank orderRef', () => {
  const nodes = [
    { id: 'gid://shopify/Order/2', note: 'BuyHalfCow order Beef Box — Jane Doe', tags: ['other'] }, // not BHC-tagged
    { id: 'gid://shopify/Order/3', note: 'BuyHalfCow order Pork Box — Someone Else', tags: ['BHC'] }, // wrong order
  ];
  assert.equal(matchExistingBhcOrder(nodes, 'Beef Box — Jane Doe'), null);
  assert.equal(matchExistingBhcOrder(nodes, ''), null, 'blank orderRef never matches (no false short-circuit)');
  assert.equal(matchExistingBhcOrder([], 'anything'), null);
});

// ── Source-shape pins (H1a/H1b): the connector must SEND the idempotency header
// on orderCreate and RUN the pre-create dedup before creating. A silent revert
// to a bare create (the double-ship regression) shows up here.
const connSrc = readFileSync(fileURLToPath(new URL('./shopifyConnector.ts', import.meta.url)), 'utf8');

test('pushOrder sends a stable Idempotency-Key header on orderCreate', () => {
  assert.match(connSrc, /Idempotency-Key/, 'orderCreate must carry an Idempotency-Key header');
  assert.match(connSrc, /orderIdempotencyKey\(/, 'header value comes from the stable key helper');
});

test('pushOrder runs the pre-create dedup short-circuit before creating', () => {
  assert.match(connSrc, /findExistingBhcOrder|matchExistingBhcOrder/, 'must look for an existing order first');
  assert.match(connSrc, /return\s*{\s*ok:\s*true,\s*externalOrderId/, 'a found order short-circuits with its external id');
});
