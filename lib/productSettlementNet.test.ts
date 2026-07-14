import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productPisNeedingSettlement } from './productSettlementNet';

const pi = (id: string, status = 'succeeded', type = 'product_purchase') => ({
  id,
  status,
  metadata: { type },
});

test('selects succeeded product PIs missing an order row', () => {
  const out = productPisNeedingSettlement(
    [pi('pi_a'), pi('pi_b'), pi('pi_c')],
    new Set(['pi_b']),
  );
  assert.deepEqual(out.map((p) => p.id), ['pi_a', 'pi_c']);
});

test('skips non-succeeded, non-product, and malformed PIs', () => {
  const out = productPisNeedingSettlement(
    [
      pi('pi_processing', 'processing'),
      pi('pi_deposit', 'succeeded', 'buyer_deposit'),
      { id: '', status: 'succeeded', metadata: { type: 'product_purchase' } },
      { id: 'pi_nometa', status: 'succeeded', metadata: null },
      null as any,
      pi('pi_good'),
    ],
    new Set(),
  );
  assert.deepEqual(out.map((p) => p.id), ['pi_good']);
});

test('empty inputs → empty output', () => {
  assert.deepEqual(productPisNeedingSettlement([], new Set()), []);
  assert.deepEqual(productPisNeedingSettlement(undefined as any, new Set()), []);
});
