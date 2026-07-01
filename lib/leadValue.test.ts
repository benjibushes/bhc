import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadValueUsd } from './leadValue';

test('no signal → base value (never 0, so Meta value-bidding works)', () => {
  assert.equal(leadValueUsd(), 15);
  assert.equal(leadValueUsd({}), 15);
  assert.ok(leadValueUsd() > 0);
});

test('scales up with intent score', () => {
  assert.equal(leadValueUsd({ intentScore: 10 }), 15);
  assert.equal(leadValueUsd({ intentScore: 25 }), 20);
  assert.equal(leadValueUsd({ intentScore: 50 }), 30);
  assert.equal(leadValueUsd({ intentScore: 90 }), 45);
});

test('ready-to-buy + basket size add on top', () => {
  assert.equal(leadValueUsd({ intentScore: 90, readyToBuy: true }), 60);
  assert.equal(leadValueUsd({ intentScore: 90, orderType: 'Whole' }), 70);
  assert.equal(leadValueUsd({ intentScore: 90, readyToBuy: true, orderType: 'whole cow' }), 85);
  assert.equal(leadValueUsd({ orderType: 'Half' }), 27);
  assert.equal(leadValueUsd({ orderType: 'Quarter' }), 20);
});

test('monotonic: higher intent never yields lower value', () => {
  const a = leadValueUsd({ intentScore: 20 });
  const b = leadValueUsd({ intentScore: 60 });
  const c = leadValueUsd({ intentScore: 95 });
  assert.ok(a <= b && b <= c);
});

test('handles null/garbage inputs safely', () => {
  assert.equal(leadValueUsd({ intentScore: null, orderType: null, readyToBuy: null }), 15);
  assert.equal(leadValueUsd({ intentScore: NaN as any }), 15);
});
