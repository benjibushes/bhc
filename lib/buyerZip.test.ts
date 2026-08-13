// lib/buyerZip.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipFromStripePayment, buyerZipPatch, stateFromStripePayment, buyerStatePatch, ZIP_OUT_OF_AREA_MESSAGE } from './buyerZip';
import { buyerZipServedBy, hasServiceZipGate } from './exclusiveZip';

// ── zipFromStripePayment ────────────────────────────────────────────────────

test('zipFromStripePayment: null / undefined / junk → null', () => {
  assert.equal(zipFromStripePayment(null), null);
  assert.equal(zipFromStripePayment(undefined), null);
  assert.equal(zipFromStripePayment('nope'), null);
  assert.equal(zipFromStripePayment(42), null);
  assert.equal(zipFromStripePayment({}), null);
});

test('zipFromStripePayment: Checkout Session shipping_details wins', () => {
  const session = {
    shipping_details: { address: { postal_code: '77002' } },
    customer_details: { address: { postal_code: '10001' } },
  };
  assert.equal(zipFromStripePayment(session), '77002');
});

test('zipFromStripePayment: Checkout Session collected_information shipping', () => {
  const session = {
    collected_information: { shipping_details: { address: { postal_code: '78701' } } },
  };
  assert.equal(zipFromStripePayment(session), '78701');
});

test('zipFromStripePayment: PaymentIntent charge shipping', () => {
  const pi = { charges: { data: [{ shipping: { address: { postal_code: '77005' } } }] } };
  assert.equal(zipFromStripePayment(pi), '77005');
});

test('zipFromStripePayment: PaymentIntent top-level shipping', () => {
  const pi = { shipping: { address: { postal_code: '59901' } } };
  assert.equal(zipFromStripePayment(pi), '59901');
});

test('zipFromStripePayment: falls back to billing_details, then customer_details', () => {
  const billing = { charges: { data: [{ billing_details: { address: { postal_code: '80014' } } }] } };
  assert.equal(zipFromStripePayment(billing), '80014');
  assert.equal(zipFromStripePayment({ customer_details: { address: { postal_code: '30301' } } }), '30301');
});

test('zipFromStripePayment: ZIP+4 is normalized to 5 digits', () => {
  assert.equal(zipFromStripePayment({ shipping: { address: { postal_code: '77002-1234' } } }), '77002');
});

test('zipFromStripePayment: leading-zero ZIP survives', () => {
  assert.equal(zipFromStripePayment({ shipping: { address: { postal_code: '01001' } } }), '01001');
});

test('zipFromStripePayment: non-US postal codes are rejected (never persisted)', () => {
  assert.equal(zipFromStripePayment({ shipping: { address: { postal_code: 'SW1A 1AA' } } }), null);
  assert.equal(zipFromStripePayment({ shipping: { address: { postal_code: 'M5V 3L9' } } }), null);
  assert.equal(zipFromStripePayment({ shipping: { address: { postal_code: '' } } }), null);
});

test('zipFromStripePayment: skips a malformed shipping ZIP and keeps looking', () => {
  // Stripe gave us a non-US shipping ZIP but a usable US billing one.
  const pi = {
    shipping: { address: { postal_code: 'M5V 3L9' } },
    charges: { data: [{ billing_details: { address: { postal_code: '77002' } } }] },
  };
  assert.equal(zipFromStripePayment(pi), '77002');
});

test('zipFromStripePayment: empty charges array is safe', () => {
  assert.equal(zipFromStripePayment({ charges: { data: [] } }), null);
  assert.equal(zipFromStripePayment({ charges: null }), null);
});

// ── buyerZipPatch ───────────────────────────────────────────────────────────

test('buyerZipPatch: no zip → empty patch (never writes a blank)', () => {
  assert.deepEqual(buyerZipPatch(null, ''), {});
  assert.deepEqual(buyerZipPatch('', ''), {});
  assert.deepEqual(buyerZipPatch(undefined, undefined), {});
});

test('buyerZipPatch: malformed zip → empty patch (never persist garbage)', () => {
  assert.deepEqual(buyerZipPatch('787', ''), {});
  assert.deepEqual(buyerZipPatch('abcde', ''), {});
  assert.deepEqual(buyerZipPatch('SW1A 1AA', ''), {});
});

test('buyerZipPatch: valid zip onto a blank row → writes normalized', () => {
  assert.deepEqual(buyerZipPatch('77002', ''), { Zip: '77002' });
  assert.deepEqual(buyerZipPatch('77002-1234', null), { Zip: '77002' });
  assert.deepEqual(buyerZipPatch(' 01001 ', undefined), { Zip: '01001' });
});

test('buyerZipPatch: a real stored ZIP is never overwritten', () => {
  assert.deepEqual(buyerZipPatch('77002', '78701'), {});
  assert.deepEqual(buyerZipPatch('77002', '77002'), {});
});

test('buyerZipPatch: a garbage stored ZIP IS healed', () => {
  assert.deepEqual(buyerZipPatch('77002', '787'), { Zip: '77002' });
  assert.deepEqual(buyerZipPatch('77002', 'n/a'), { Zip: '77002' });
});

// ── The gate decision, at the boundary the buy paths use ────────────────────
// These lock the two properties Part 2 depends on: a byte-for-byte no-op for
// every rancher alive today, and fail-closed for a gated one.

const NO_GATE_ROWS: any[] = [
  {},
  { 'Service ZIP Prefixes': '' },
  { 'Service ZIP Prefixes': null },
  { 'Service ZIP Prefixes': undefined },
  { 'Service ZIP Prefixes': '   ' },
  { 'Service ZIP Prefixes': ',,' },
  { 'Service ZIP Prefixes': 'houston' }, // garbage never widens OR opens a gate
];

test('gate no-op: a rancher with no prefixes serves every buyer, ZIP or not', () => {
  for (const rancher of NO_GATE_ROWS) {
    assert.equal(hasServiceZipGate(rancher), false);
    for (const zip of ['77002', '10001', '', null, undefined, 'garbage', '787', 12345]) {
      assert.equal(
        buyerZipServedBy(zip, rancher),
        true,
        `no-prefix rancher must serve zip=${String(zip)} (prefixes=${String(rancher['Service ZIP Prefixes'])})`,
      );
    }
  }
});

test('gate fail-closed: a gated rancher rejects missing / malformed / out-of-area ZIPs', () => {
  const gated = { 'Service ZIP Prefixes': '77' };
  assert.equal(hasServiceZipGate(gated), true);
  assert.equal(buyerZipServedBy('77002', gated), true);
  assert.equal(buyerZipServedBy('77002-1234', gated), true);
  assert.equal(buyerZipServedBy('78701', gated), false); // out of area
  assert.equal(buyerZipServedBy('', gated), false);      // no ZIP → closed
  assert.equal(buyerZipServedBy(null, gated), false);
  assert.equal(buyerZipServedBy(undefined, gated), false);
  assert.equal(buyerZipServedBy('787', gated), false);   // malformed → closed
  assert.equal(buyerZipServedBy('abcde', gated), false);
});

test('rejection copy never names another ranch or its territory', () => {
  assert.equal(typeof ZIP_OUT_OF_AREA_MESSAGE, 'string');
  assert.ok(ZIP_OUT_OF_AREA_MESSAGE.length > 0);
  assert.ok(!/\d{5}/.test(ZIP_OUT_OF_AREA_MESSAGE), 'must not leak a ZIP');
  assert.ok(!/exclusiv/i.test(ZIP_OUT_OF_AREA_MESSAGE), 'must not leak the contract');
  assert.ok(!/territor/i.test(ZIP_OUT_OF_AREA_MESSAGE), 'must not leak territory language');
});

// ── stateFromStripePayment (preference-fidelity audit 2026-08-12) ───────────

test('stateFromStripePayment: null / undefined / junk → null', () => {
  assert.equal(stateFromStripePayment(null), null);
  assert.equal(stateFromStripePayment(undefined), null);
  assert.equal(stateFromStripePayment('nope'), null);
  assert.equal(stateFromStripePayment(42), null);
  assert.equal(stateFromStripePayment({}), null);
});

test('stateFromStripePayment: shipping wins over billing/customer (same order as the ZIP harvest)', () => {
  const session = {
    shipping_details: { address: { state: 'TX' } },
    customer_details: { address: { state: 'NY' } },
  };
  assert.equal(stateFromStripePayment(session), 'TX');
});

test('stateFromStripePayment: reads every candidate node the ZIP harvest reads', () => {
  assert.equal(
    stateFromStripePayment({ collected_information: { shipping_details: { address: { state: 'MT' } } } }),
    'MT',
  );
  assert.equal(
    stateFromStripePayment({ charges: { data: [{ shipping: { address: { state: 'CO' } } }] } }),
    'CO',
  );
  assert.equal(stateFromStripePayment({ shipping: { address: { state: 'GA' } } }), 'GA');
  assert.equal(
    stateFromStripePayment({ charges: { data: [{ billing_details: { address: { state: 'FL' } } }] } }),
    'FL',
  );
  assert.equal(stateFromStripePayment({ customer_details: { address: { state: 'OH' } } }), 'OH');
});

test('stateFromStripePayment: normalizes full names + lowercase to the 2-letter code', () => {
  assert.equal(stateFromStripePayment({ shipping: { address: { state: 'Texas' } } }), 'TX');
  assert.equal(stateFromStripePayment({ shipping: { address: { state: ' montana ' } } }), 'MT');
});

test('stateFromStripePayment: an unusable candidate is SKIPPED, not short-circuited', () => {
  // Shipping carries a non-US region — billing still yields the state.
  const pi = {
    charges: {
      data: [{ shipping: { address: { state: 'Ontario' } }, billing_details: { address: { state: 'CO' } } }],
    },
  };
  assert.equal(stateFromStripePayment(pi), 'CO');
});

// ── buyerStatePatch ─────────────────────────────────────────────────────────

test('buyerStatePatch: no / unrecognizable incoming state → {} (never persist junk)', () => {
  assert.deepEqual(buyerStatePatch(null, ''), {});
  assert.deepEqual(buyerStatePatch('', ''), {});
  assert.deepEqual(buyerStatePatch('Ontario', ''), {});
  assert.deepEqual(buyerStatePatch('ZZ', ''), {});
});

test('buyerStatePatch: NEVER stomps a stored non-blank State — even a non-normalizable one', () => {
  assert.deepEqual(buyerStatePatch('TX', 'MT'), {});
  assert.deepEqual(buyerStatePatch('TX', 'Montana'), {});
  // A human-typed oddball is stronger evidence than a Stripe billing address.
  assert.deepEqual(buyerStatePatch('TX', 'somewhere rural'), {});
});

test('buyerStatePatch: fills a blank/whitespace-only State with the normalized code', () => {
  assert.deepEqual(buyerStatePatch('Texas', ''), { State: 'TX' });
  assert.deepEqual(buyerStatePatch('TX', '   '), { State: 'TX' });
  assert.deepEqual(buyerStatePatch('mt', null), { State: 'MT' });
  assert.deepEqual(buyerStatePatch('MT', undefined), { State: 'MT' });
});

test('buyerStatePatch spreads as a no-op exactly like buyerZipPatch', () => {
  const patch = { Notes: 'x', ...buyerStatePatch('Ontario', ''), ...buyerStatePatch('TX', 'MT') };
  assert.deepEqual(patch, { Notes: 'x' });
});
