// POST /api/admin/sell-links — WEIGHT-PRICED (range) broker mints.
//
// Pins brokerMintGate's range shape: a hanging-weight cut returns the floor
// as tierPrice plus tierPriceMax (so the console's copy can say "estimated
// $floor–$max, final price set by hanging weight"), while an exact cut keeps
// the exact return shape — no tierPriceMax key at all. The deposit is EXACT
// in both modes.
//
// Kept in its OWN file so the pre-existing route tests stay unmodified.
// Synthetic ranch names and record ids throughout — the repo is PUBLIC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brokerMintGate } from './route';

function weightRancher(over: Record<string, any> = {}) {
  return {
    id: 'recBROKERWEIGHT1',
    'Ranch Name': 'Granite Hollow Beef',
    'Broker Rail': true,
    'Half Price': 2025,
    'Half Price Max': 2363,
    'Half Deposit': 200,
    ...over,
  };
}

test('a WEIGHT-PRICED mint quotes floor + ceiling, deposit exact', () => {
  const gate = brokerMintGate(weightRancher(), 'half');
  assert.equal(gate.ok, true);
  if (!gate.ok) return;
  assert.equal(gate.tierPrice, 2025); // FLOOR
  assert.equal(gate.tierPriceMax, 2363); // ceiling
  assert.equal(gate.deposit, 200); // EXACT — the commission
});

test('an EXACT mint keeps the exact return shape — no tierPriceMax key', () => {
  const gate = brokerMintGate(weightRancher({ 'Half Price Max': undefined }), 'half');
  assert.equal(gate.ok, true);
  if (!gate.ok) return;
  assert.equal(gate.tierPrice, 2025);
  assert.equal(gate.deposit, 200);
  assert.ok(!('tierPriceMax' in gate), 'exact-mode gate must not grow a tierPriceMax key');
});

test('Max ≤ floor mints exact', () => {
  const gate = brokerMintGate(weightRancher({ 'Half Price Max': 2000 }), 'half');
  assert.equal(gate.ok, true);
  if (!gate.ok) return;
  assert.ok(!('tierPriceMax' in gate));
});

test('a ceiling cannot rescue a refused mint — deposit ≥ floor still refuses', () => {
  const gate = brokerMintGate(weightRancher({ 'Half Deposit': 2025 }), 'half');
  assert.equal(gate.ok, false);
  if (gate.ok) return;
  assert.equal(gate.status, 409);
});
