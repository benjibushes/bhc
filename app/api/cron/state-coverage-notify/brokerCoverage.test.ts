// WAVE A FIX 6 (2026-08-17) — PROOF, not a fix: the AZ unserved→served flip
// already fires for self-serve broker supply after PR #628. NO route change.
//
// This cron's covered-states input is getServedStates(ranchers) over an
// UNFILTERED Ranchers scan (no excludeBrokerRanchers at the read boundary —
// deliberate, and now load-bearing). getServedStates admits ranchers via
// isRancherOperationalForBuyers, which routes represented ranches through
// isBrokerRoutable (#628) — so a self-serve broker ranch's state reads as
// COVERED here with no change to this route. These tests pin exactly that,
// plus the token-only inverse, so a future "cleanup" that bolts a broker
// exclusion onto this cron's scan (or re-hides broker ranches in the shared
// helper) breaks loudly: the waitlisted-AZ-buyer letters fire only while
// this stays true.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getServedStates, getCoveredStates } from '@/lib/routingSegment';
import { selectStateCoverageTargets } from './selection';

/** Synthetic ranch (repo is PUBLIC — counts only, no real names): opted in,
 *  publicly resolvable, one sellable cut — and NONE of the Connect paperwork,
 *  like every real represented ranch. */
function selfServeBrokerRanch(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'recAZCOVERAGE001',
    'Ranch Name': 'Dry Wash Cattle',
    State: 'AZ',
    Slug: 'dry-wash-cattle',
    'Broker Rail': true,
    'Broker Self Serve': true,
    'Half Price': 2100,
    'Half Deposit': 450,
    ...over,
  };
}

test('covered states: a self-serve broker ranch makes AZ read as SERVED — the flip can fire', () => {
  assert.ok(getServedStates([selfServeBrokerRanch()] as any).has('AZ'));
});

test('covered states: a TOKEN-ONLY broker ranch covers NOTHING (the invariant)', () => {
  const tokenOnly = selfServeBrokerRanch();
  delete tokenOnly['Broker Self Serve'];
  assert.equal(getServedStates([tokenOnly] as any).size, 0);
});

test('covered states: a Connect rancher is unchanged next to broker supply', () => {
  const connect = {
    id: 'recCONNECT000042',
    'Ranch Name': 'Stone Fork Beef',
    State: 'MT',
    'Active Status': 'Active',
    'Agreement Signed': true,
    'Onboarding Status': 'Live',
    'Pricing Model': 'legacy',
  };
  const covered = getServedStates([selfServeBrokerRanch(), connect] as any);
  assert.ok(covered.has('AZ'));
  assert.ok(covered.has('MT'));
});

test('capacity-IN view agrees (broker ranches have no capacity fields → uncapped)', () => {
  assert.ok(getCoveredStates([selfServeBrokerRanch()] as any).has('AZ'));
});

test('end-to-end selection: an AZ waitlist buyer is picked once the broker ranch covers AZ', () => {
  const buyer = { id: 'recBUYER00000001', Email: 'buyer@example.com', State: 'AZ' };
  const withOptIn = selectStateCoverageTargets(
    [buyer],
    getServedStates([selfServeBrokerRanch()] as any),
  );
  assert.equal(withOptIn.length, 1);

  const tokenOnly = selfServeBrokerRanch();
  delete tokenOnly['Broker Self Serve'];
  const withoutOptIn = selectStateCoverageTargets(
    [buyer],
    getServedStates([tokenOnly] as any),
  );
  assert.equal(withoutOptIn.length, 0, 'token-only supply must never trigger the letter');
});

test('WIRING: the route feeds getServedStates an UNFILTERED Ranchers scan', () => {
  const routeSrc = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'route.ts'),
    'utf8',
  );
  assert.ok(routeSrc.includes('getServedStates(ranchers)'));
  assert.ok(!routeSrc.includes('excludeBrokerRanchers'), 'no broker exclusion at the read boundary');
  assert.ok(!routeSrc.includes('NOT({Broker Rail}'), 'no broker exclusion in a filterByFormula');
});
