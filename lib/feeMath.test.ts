// Tests for the net-your-number absorption math. This is money-path — the
// invariants here are the ones the rancher pitch sells: absorption never
// raises the fee, never drops platform net below the floor, and never goes
// negative.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripeFeeEstimateCents, absorbStripeFee } from './feeMath';

test('stripeFeeEstimateCents: 2.9% + 30¢', () => {
  assert.equal(stripeFeeEstimateCents(0), 0);
  assert.equal(stripeFeeEstimateCents(10000), 320); // $100 → $3.20
  assert.equal(stripeFeeEstimateCents(75000), 2205); // $750 deposit → $22.05
  assert.equal(stripeFeeEstimateCents(1359), 69); // $13.59 jerky → 39+30
});

test('absorb: healthy product margin absorbs the full estimate', () => {
  // $199 sampler, base $169.15 → gross fee $29.85, total $199
  const r = absorbStripeFee({ grossFeeCents: 2985, totalChargeCents: 19900 });
  const est = stripeFeeEstimateCents(19900); // 607
  assert.equal(r.feeCents, 2985 - est);
  assert.equal(r.absorbedCents, est);
  assert.ok(r.feeCents >= Math.round(19900 * 0.02)); // above floor
});

test('absorb: shipping is in the total (fee applies to full charge)', () => {
  // $95 box + $25 shipping: gross margin on product only, est on $120
  const r = absorbStripeFee({ grossFeeCents: 1425, totalChargeCents: 12000 });
  assert.equal(r.absorbedCents, stripeFeeEstimateCents(12000));
  assert.equal(r.feeCents + r.absorbedCents, 1425);
});

test('absorb: thin margin gets PARTIAL absorption down to the floor', () => {
  // Ranch-tier style: $750 deposit, 3% gross fee = $22.50; est $22.05;
  // floor = max($1, 2% of $750=$15) = $15 → fee stays $15, absorbed $7.50
  const r = absorbStripeFee({ grossFeeCents: 2250, totalChargeCents: 75000 });
  assert.equal(r.feeCents, 1500);
  assert.equal(r.absorbedCents, 750);
});

test('absorb: fee never increases, never negative, floor capped at gross', () => {
  // Gross below the would-be floor: fee unchanged, nothing absorbed
  const tiny = absorbStripeFee({ grossFeeCents: 40, totalChargeCents: 75000 });
  assert.equal(tiny.feeCents, 40);
  assert.equal(tiny.absorbedCents, 0);
  // Zero gross: no-op
  assert.deepEqual(absorbStripeFee({ grossFeeCents: 0, totalChargeCents: 10000 }), { feeCents: 0, absorbedCents: 0 });
  // Small ticket: $13.59, gross $2.04, est 69¢, floor min(gross, max(100, 27)) = $1
  const jerky = absorbStripeFee({ grossFeeCents: 204, totalChargeCents: 1359 });
  assert.equal(jerky.feeCents, Math.max(100, 204 - 69));
  assert.ok(jerky.feeCents <= 204 && jerky.feeCents >= 100);
});

test('absorb: invariants hold across a sweep', () => {
  for (const total of [500, 1359, 9500, 19900, 37500, 75000, 250000]) {
    for (const rate of [0.03, 0.07, 0.1, 0.15, 0.25]) {
      const gross = Math.round(total * rate);
      const r = absorbStripeFee({ grossFeeCents: gross, totalChargeCents: total });
      assert.ok(r.feeCents >= 0, 'fee >= 0');
      assert.ok(r.feeCents <= gross, 'fee <= gross');
      assert.equal(r.feeCents + r.absorbedCents, gross, 'conservation');
    }
  }
});
