// lib/trackingLink.test.ts
//
// D3 (2026-07-01) — pure carrier→tracking-URL helper for the buyer-facing
// shipment surface (/member order card + the shipped email). Written
// red-first: these tests define the contract before the implementation.
//
// Runner: JWT_SECRET=test-secret-ci npx tsx --test lib/trackingLink.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carrierTrackingUrl } from './trackingLink';

// ── Known carriers (case-insensitive contains-match) ────────────────────────

test('UPS carrier produces a ups.com tracking URL', () => {
  assert.equal(
    carrierTrackingUrl('UPS', '1Z999AA10123456784'),
    'https://www.ups.com/track?tracknum=1Z999AA10123456784',
  );
});

test('carrier match is case-insensitive and contains-based', () => {
  assert.equal(
    carrierTrackingUrl('ups ground', '1Z999AA10123456784'),
    'https://www.ups.com/track?tracknum=1Z999AA10123456784',
  );
  assert.equal(
    carrierTrackingUrl('FedEx Home Delivery', '123456789012'),
    'https://www.fedex.com/fedextrack/?trknbr=123456789012',
  );
});

test('FedEx carrier produces a fedex.com tracking URL', () => {
  assert.equal(
    carrierTrackingUrl('FedEx', '123456789012'),
    'https://www.fedex.com/fedextrack/?trknbr=123456789012',
  );
});

test('USPS carrier produces a tools.usps.com tracking URL', () => {
  assert.equal(
    carrierTrackingUrl('USPS', '9400111899223857268499'),
    'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223857268499',
  );
});

test('USPS with punctuation still matches usps, not ups', () => {
  assert.equal(
    carrierTrackingUrl('U.S.P.S.', '9400111899223857268499'),
    'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223857268499',
  );
});

// ── Tracking-number normalization ────────────────────────────────────────────

test('spaces inside the tracking number are stripped', () => {
  assert.equal(
    carrierTrackingUrl('usps', '9400 1118 9922 3857 2684 99'),
    'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223857268499',
  );
});

test('surrounding whitespace on carrier and tracking is tolerated', () => {
  assert.equal(
    carrierTrackingUrl('  UPS  ', '  1Z999AA10123456784  '),
    'https://www.ups.com/track?tracknum=1Z999AA10123456784',
  );
});

// ── Unknown carrier → Google search fallback ─────────────────────────────────

test('unknown carrier falls back to a Google search URL with carrier + number', () => {
  const url = carrierTrackingUrl('Old Dominion', 'OD1234567890');
  assert.equal(
    url,
    `https://www.google.com/search?q=${encodeURIComponent('Old Dominion tracking OD1234567890')}`,
  );
});

test('missing carrier with a valid tracking number still yields a search URL', () => {
  const url = carrierTrackingUrl('', '1Z999AA10123456784');
  assert.equal(
    url,
    `https://www.google.com/search?q=${encodeURIComponent('tracking 1Z999AA10123456784')}`,
  );
});

// ── Empty / garbage → null (never render a broken link) ─────────────────────

test('empty tracking number returns null', () => {
  assert.equal(carrierTrackingUrl('UPS', ''), null);
  assert.equal(carrierTrackingUrl('UPS', '   '), null);
});

test('non-string / nullish tracking returns null', () => {
  assert.equal(carrierTrackingUrl('UPS', null as any), null);
  assert.equal(carrierTrackingUrl('UPS', undefined as any), null);
  assert.equal(carrierTrackingUrl('UPS', 12345 as any), null);
});

test('too-short tracking number is treated as garbage', () => {
  assert.equal(carrierTrackingUrl('UPS', 'abc'), null);
});

test('tracking numbers with URL-hostile characters are rejected', () => {
  assert.equal(carrierTrackingUrl('UPS', '<script>alert(1)</script>'), null);
  assert.equal(carrierTrackingUrl('UPS', 'https://evil.example/steal'), null);
});

test('absurdly long tracking strings are rejected', () => {
  assert.equal(carrierTrackingUrl('UPS', 'A'.repeat(200)), null);
});

test('hyphenated tracking numbers are accepted', () => {
  assert.equal(
    carrierTrackingUrl('fedex', '61299-99887-12345'),
    'https://www.fedex.com/fedextrack/?trknbr=61299-99887-12345',
  );
});
