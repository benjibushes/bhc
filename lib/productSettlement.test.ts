import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeSettlementMoney } from './productSettlement';

// ── L1: BHC Margin must NOT double-count quantity. metadata.marginCents is
// ALREADY the whole-order application fee (grossFeeCents = (display−base)×qty,
// net of any absorbed Stripe fee) — multiplying it by quantity again inflated
// multi-unit margin ~qty×. The invariant the admin P&L relies on:
//   Buyer Paid − Rancher Payout === BHC Margin   (fee absorption = 0).

test('L1: qty>1 with metadata.marginCents present — Buyer Paid − Rancher Payout === BHC Margin', () => {
  const pi = {
    id: 'pi_multi',
    metadata: {
      displayCents: '10000', // $100/unit
      baseCents: '8000',     // $80/unit
      shippingCents: '1500', // $15 flat
      quantity: '3',
      marginCents: '6000',   // whole-order fee = (10000−8000)×3, no absorption
    },
  };
  const m = computeSettlementMoney(pi);
  assert.equal(m.paidCents, 10000 * 3 + 1500);          // 31500
  assert.equal(m.rancherPayoutCents, 8000 * 3 + 1500);  // 25500
  assert.equal(m.totalMarginCents, 6000);               // NOT 6000×3
  // the P&L invariant holds for a qty>1 order (the bug produced 18000 here)
  assert.equal(m.paidCents - m.rancherPayoutCents, m.totalMarginCents);
});

test('L1: legacy PI without metadata.marginCents keeps the per-unit ×quantity fallback', () => {
  const pi = {
    id: 'pi_legacy',
    metadata: { displayCents: '10000', baseCents: '8000', quantity: '2' }, // no marginCents/shipping
  };
  const m = computeSettlementMoney(pi);
  assert.equal(m.shippingCents, 0);
  assert.equal(m.paidCents, 20000);
  assert.equal(m.rancherPayoutCents, 16000);
  assert.equal(m.totalMarginCents, (10000 - 8000) * 2); // fallback IS per-unit → keeps ×qty
  assert.equal(m.paidCents - m.rancherPayoutCents, m.totalMarginCents);
});

test('L1: single-unit unchanged, and negative margin clamps to 0 in the fallback', () => {
  const single = computeSettlementMoney({ id: 'x', metadata: { displayCents: '9000', baseCents: '7000', quantity: '1', marginCents: '2000' } });
  assert.equal(single.totalMarginCents, 2000);
  assert.equal(single.paidCents - single.rancherPayoutCents, single.totalMarginCents);
  // inverted-margin legacy (no metadata fee) never records a negative fee
  const inverted = computeSettlementMoney({ id: 'y', metadata: { displayCents: '5000', baseCents: '7000', quantity: '2' } });
  assert.equal(inverted.totalMarginCents, 0);
});

// ── Source-shape pins: the settle path must consume computeSettlementMoney's
// total (never re-multiply) for the recorded 'BHC Margin' and the operator
// "You keep" lines — a silent revert to `marginCents * quantity` reappears here.
const src = readFileSync(fileURLToPath(new URL('./productSettlement.ts', import.meta.url)), 'utf8');

test('L1: BHC Margin records totalMarginCents, never a re-multiplied margin', () => {
  assert.match(src, /'BHC Margin':\s*totalMarginCents\s*\/\s*100/, "record the total fee, don't ×quantity again");
  assert.doesNotMatch(src, /marginCents\s*\*\s*quantity/, 'no per-unit×qty margin anywhere (the double-count bug)');
});

// ── L3: refund reconcile must be idempotent under concurrent charge.refunded.
test('L3: reconcile is wrapped in a PI-keyed claimOnce + a durable Stock Restored At marker', () => {
  assert.match(src, /claimOnce\(`reconcile-refund:\$\{piId\}`/, 'PI-keyed claim serializes concurrent refunds');
  assert.match(src, /Stock Restored At/, 'durable idempotency marker gates restore/cancel');
});

// ── Locked-rate margin audit (2026-08-03): settlement must NEVER re-derive the
// margin. Every cent a settled order records comes from PI metadata stamped at
// checkout-mint time, which itself reads the STORED Display Price /
// Rancher Base off the product row (app/api/checkout/product + lib/
// productBuyGates both read the row; lib/productCheckout stamps the metadata).
// So fixing a locked-rate rancher's stored Base fixes every future charge —
// and nothing between mint and settlement can quietly reapply a category rate.
test('settlement pays the stored (metadata) base — no category-margin re-derivation', () => {
  // The numbers a locked-10% rancher's row stores after the fix: $375 display,
  // $337.50 base. Settlement must pay exactly that base — not display×0.85.
  const m = computeSettlementMoney({
    id: 'pi_lockedrate',
    metadata: { displayCents: '37500', baseCents: '33750', quantity: '1', marginCents: '3750' },
  });
  assert.equal(m.rancherPayoutCents, 33750);
  assert.equal(m.totalMarginCents, 3750);
  assert.equal(m.paidCents - m.rancherPayoutCents, m.totalMarginCents);
  // Source pin: this module never imports the category-margin machinery.
  assert.doesNotMatch(
    src,
    /MARGIN_BY_CATEGORY|deriveProductPricing|rancherProductInput/,
    'settlement must not re-derive margin from the category table',
  );
});
