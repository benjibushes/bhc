// Pins for the anonymous opt-out gate (lib/prospectOptOut.ts).
//
// WHAT THESE PROTECT: POST /api/prospects/remove is unauthenticated by design
// — a rancher whose listing we built from public info must be able to retract
// it in one tap. Before this gate it resolved its target by SLUG ALONE, and
// every slug on the platform is public, so the same anonymous POST could set
// Verification Status='Removed' on a signed, paid, live partner — which stops
// their buyer routing (lib/rancherEligibility) AND locks them out of their own
// magic-link login (app/api/auth/rancher/verify).
//
// The two properties that must BOTH hold forever:
//   1. a genuine unclaimed prospect can still opt out anonymously;
//   2. nothing carrying a real relationship can be touched by that door.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prospectOptOutVerdict } from './prospectOptOut';

/** A scraped listing: the ONLY shape the anonymous door may act on. */
function prospect(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'recProspect000001',
    'Ranch Name': 'Pin Creek Cattle',
    Slug: 'pin-creek-cattle',
    State: 'MT',
    'Verification Status': 'Prospect',
    'Page Live': true,
    ...over,
  };
}

// ── 1. The legal-compliance path still works ───────────────────────────────

test('a genuine unclaimed prospect can still opt out anonymously', () => {
  assert.deepEqual(prospectOptOutVerdict(prospect()), { decision: 'allow' });
});

test('blank and Pending Onboarding Active Status are still prospect-shaped', () => {
  assert.equal(prospectOptOutVerdict(prospect({ 'Active Status': '' })).decision, 'allow');
  assert.equal(
    prospectOptOutVerdict(prospect({ 'Active Status': 'Pending Onboarding' })).decision,
    'allow',
  );
});

test('an already-removed row is an idempotent no-op, not an error', () => {
  assert.deepEqual(
    prospectOptOutVerdict(prospect({ 'Verification Status': 'Removed' })),
    { decision: 'already-removed' },
  );
});

// ── 2. Nothing with a real relationship can be reached ─────────────────────

test('a Verified partner cannot be removed by the anonymous door', () => {
  const v = prospectOptOutVerdict(prospect({ 'Verification Status': 'Verified' }));
  assert.equal(v.decision, 'refuse');
});

test('the enum-OBJECT shape of Verification Status is honored (fails closed)', () => {
  // Airtable returns single-selects as { name } on expanded reads. A gate that
  // only understands the bare string would read '' here and wave a live
  // partner through — the exact fail-open this module exists to prevent.
  const v = prospectOptOutVerdict(prospect({ 'Verification Status': { name: 'Verified' } }));
  assert.equal(v.decision, 'refuse');
  const removed = prospectOptOutVerdict(prospect({ 'Verification Status': { name: 'Removed' } }));
  assert.equal(removed.decision, 'already-removed');
});

test('a represented (broker-rail) ranch cannot be removed even while it reads as Prospect', () => {
  // Broker ranches carry an EMPTY Active Status by design and route off
  // isBrokerRoutable — every "is this live?" heuristic waves them through, so
  // the rail flag itself has to be a gate.
  const v = prospectOptOutVerdict(prospect({ 'Broker Rail': true }));
  assert.equal(v.decision, 'refuse');
  assert.equal((v as any).reason, 'broker-rail');
  assert.equal(
    prospectOptOutVerdict(prospect({ 'Broker Rail': 'true' })).decision,
    'refuse',
    'checkbox may arrive as the string "true"',
  );
});

test('a signed agreement blocks removal', () => {
  assert.equal(prospectOptOutVerdict(prospect({ 'Agreement Signed': true })).decision, 'refuse');
});

test('any explicit account lifecycle state blocks removal', () => {
  for (const s of ['Active', 'At Capacity', 'Paused', 'Non-Compliant']) {
    assert.equal(
      prospectOptOutVerdict(prospect({ 'Active Status': s })).decision,
      'refuse',
      `Active Status=${s} must not be removable anonymously`,
    );
  }
});

test('a live onboarding or any Stripe Connect state blocks removal', () => {
  assert.equal(prospectOptOutVerdict(prospect({ 'Onboarding Status': 'Live' })).decision, 'refuse');
  for (const c of ['active', 'onboarding', 'restricted']) {
    assert.equal(
      prospectOptOutVerdict(prospect({ 'Stripe Connect Status': c })).decision,
      'refuse',
      `Stripe Connect Status=${c} means identity docs were handed over — not a scraped listing`,
    );
  }
});

test('a blank / unknown / non-record target fails CLOSED', () => {
  assert.equal(prospectOptOutVerdict(null).decision, 'refuse');
  assert.equal(prospectOptOutVerdict(undefined).decision, 'refuse');
  assert.equal(prospectOptOutVerdict('recSomething').decision, 'refuse');
  assert.equal(prospectOptOutVerdict(prospect({ 'Verification Status': '' })).decision, 'refuse');
  assert.equal(
    prospectOptOutVerdict(prospect({ 'Verification Status': 'Not Started' })).decision,
    'refuse',
  );
});
