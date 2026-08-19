// lib/publicRepresentGuard.test.ts
//
// /api/partner/represent is anonymous. It deduped by email against ANY row in
// Ranchers and flipped the match onto the broker rail, overwriting identity
// fields with attacker-supplied strings.
//
// That is a kill switch, not a data-quality bug: referralRailForRancher
// returns 'ambiguous' for broker-flagged + Connect footprint, and the deposit
// route REFUSES to charge on 'ambiguous'. One unauthenticated POST naming a
// live rancher's email takes them offline for payments.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRepresent } from './publicRepresentGuard';
// Imported for real so the guard and the rail definition cannot drift apart —
// if 'ambiguous' ever stops meaning "refuse to charge", these pins say so.
import { referralRailForRancher } from './brokerRail';

// ── the attack ─────────────────────────────────────────────────────────────

test('a live Connect rancher can NOT be flipped onto the broker rail anonymously', () => {
  const connectRancher = {
    id: 'recLIVE',
    fields: { 'Ranch Name': 'TX PRIME', 'Stripe Connect Account Id': 'acct_123', 'Pricing Model': 'tier_v2' },
  };
  const d = decideRepresent(connectRancher);
  assert.equal(d.action, 'refuse-connect');
  assert.equal((d as any).rancherId, 'recLIVE');
});

test('...and this is exactly the state that would have bricked their checkout', () => {
  // What the old code would have produced: broker flag ON, Connect intact.
  const bricked = { 'Broker Rail': true, 'Stripe Connect Account Id': 'acct_123' };
  assert.equal(
    referralRailForRancher(bricked),
    'ambiguous',
    "the deposit route refuses to charge on 'ambiguous' — this is the outage",
  );
});

test('every flavour of Connect footprint is refused, not just an account id', () => {
  for (const fields of [
    { 'Stripe Connect Account Id': 'acct_1' },
    { 'Stripe Connect Status': 'active' },
    { 'Stripe Connect Status': 'restricted' },
    { 'Pricing Model': 'tier_v2' },
  ]) {
    assert.equal(decideRepresent({ id: 'rec1', fields }).action, 'refuse-connect', JSON.stringify(fields));
  }
});

test('a Connect row that is ALREADY broker-flagged still needs a human, not another anonymous write', () => {
  const d = decideRepresent({ id: 'rec1', fields: { 'Broker Rail': true, 'Stripe Connect Status': 'active' } });
  assert.equal(d.action, 'refuse-connect', 'an ambiguous row must not be made more ambiguous');
});

// ── the legitimate paths must survive ──────────────────────────────────────

test('no existing row still creates a fresh broker rancher', () => {
  assert.deepEqual(decideRepresent(null), { action: 'create' });
});

test("a bare prospect row Ben hand-entered is still upgraded (the rail's whole point)", () => {
  const d = decideRepresent({ id: 'recPROSPECT', fields: { 'Ranch Name': 'Some Ranch' } });
  assert.equal(d.action, 'upgrade');
  assert.equal((d as any).rancherId, 'recPROSPECT');
});

test('an already-represented ranch re-submitting is idempotent, not an error', () => {
  const d = decideRepresent({ id: 'recBROKER', fields: { 'Broker Rail': true } });
  assert.equal(d.action, 'already-broker');
});

test('a Connect Status of "none" is not a footprint', () => {
  // 'none' is the explicit not-connected marker — treating it as a footprint
  // would refuse every ordinary prospect and kill the rail.
  assert.equal(decideRepresent({ id: 'r', fields: { 'Stripe Connect Status': 'none' } }).action, 'upgrade');
  assert.equal(decideRepresent({ id: 'r', fields: { 'Stripe Connect Status': '' } }).action, 'upgrade');
});

test('both Airtable record shapes are read (flattened and {id,fields})', () => {
  const flat = { id: 'r', 'Stripe Connect Account Id': 'acct_9' };
  const nested = { id: 'r', fields: { 'Stripe Connect Account Id': 'acct_9' } };
  assert.equal(decideRepresent(flat).action, 'refuse-connect');
  assert.equal(decideRepresent(nested).action, 'refuse-connect');
});
