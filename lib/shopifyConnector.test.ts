import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitShipTo, classifyGqlErrors } from './shopifyConnector';

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
