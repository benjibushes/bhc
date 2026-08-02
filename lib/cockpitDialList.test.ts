// lib/cockpitDialList.test.ts
//
// Wave 1B — the cockpit's merged dial list. Pins the merge priorities, the
// supply gate (uncovered-state buyers collapse into recruit signals), and the
// row cap. All names are synthetic fixtures (public repo).

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCockpitDialList } from './cockpitDialList';
import type { RankedDialCandidate } from './callbackQueue';
import type { RankedStuckRancherRow } from './stuckRancherQueue';

const buyer = (
  id: string,
  tier: RankedDialCandidate['tier'],
  state = 'TX',
  phone = '5551230000',
): RankedDialCandidate =>
  ({
    id,
    name: `Test Buyer ${id}`,
    state,
    phone,
    tier,
    tierRank: 0,
    reason: '',
    signalAgeDays: 1,
  }) as RankedDialCandidate;

const rancher = (id: string, score: number, state = 'GA'): RankedStuckRancherRow =>
  ({
    id,
    ranchName: `Test Ranch ${id}`,
    operatorName: `Test Operator ${id}`,
    state,
    email: '',
    phone: '5559870000',
    emailOptOut: false,
    activeStatus: 'Pending',
    verificationStatus: '',
    onboardingStatus: 'Docs Sent',
    agreementSigned: false,
    pageLive: false,
    pricingModel: 'tier_v2',
    connectAccountId: '',
    connectStatus: '',
    hasSlug: false,
    maxPrice: 0,
    hasPaymentLink: false,
    stuckEscalatedAt: '2026-07-01T00:00:00.000Z',
    stuckEscalatedBucket: 'docs-sent',
    lastTouchAt: '',
    buyersWaiting: 10,
    servedStates: [state],
    score,
    signals: { demand: 0, proximity: 0 },
    points: { demand: 0, proximity: 0 },
    topReason: 'demand',
    why: `why-${id}`,
    bucket: 'docs-sent',
    missing: [`step-${id}`],
    daysStuck: 3,
    proximity: 0.25,
    bucketDrifted: false,
    neverWorked: true,
  }) as RankedStuckRancherRow;

test('callback buyer outranks everything, including a perfect-score rancher', () => {
  const rows = buildCockpitDialList({
    buyers: [buyer('b1', 'callback')],
    stuckRanchers: [rancher('r1', 100)],
    coveredStates: new Set(['TX']),
  });
  assert.equal(rows[0].kind, 'buyer');
  assert.equal(rows[0].id, 'b1');
});

test('high-scored stuck rancher outranks a deposit-opened buyer; low-scored does not', () => {
  const rows = buildCockpitDialList({
    buyers: [buyer('b1', 'deposit-opened')],
    stuckRanchers: [rancher('r-hot', 90), rancher('r-cold', 40)],
    coveredStates: new Set(['TX']),
  });
  // r-hot: 30 + 0.6*90 = 84 > 75 (deposit-opened) > r-cold: 30 + 0.6*40 = 54
  assert.deepEqual(
    rows.map((r) => r.id),
    ['r-hot', 'b1', 'r-cold'],
  );
});

test('uncovered-state buyers collapse into one recruit signal per state', () => {
  const rows = buildCockpitDialList({
    buyers: [
      buyer('b1', 'callback', 'FL'),
      buyer('b2', 'qualified-no-deal', 'FL'),
      buyer('b3', 'qualified-no-deal', 'MT'),
    ],
    stuckRanchers: [],
    coveredStates: new Set(['TX']),
  });
  const recruits = rows.filter((r) => r.kind === 'recruit');
  assert.equal(recruits.length, 2);
  const fl = recruits.find((r) => r.state === 'FL');
  assert.ok(fl);
  assert.equal(fl!.buyersBehind, 2);
  assert.match(fl!.why, /callback request/);
  assert.equal(fl!.phone, '');
  // No raw dial rows for the gated buyers.
  assert.equal(rows.filter((r) => r.kind === 'buyer').length, 0);
});

test('buyer with no parseable state stays dialable (never gated)', () => {
  const rows = buildCockpitDialList({
    buyers: [buyer('b1', 'qualified-no-deal', '')],
    stuckRanchers: [],
    coveredStates: new Set(['TX']),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'buyer');
});

test('caps at the limit and keeps each source ranker order on ties', () => {
  const buyers = Array.from({ length: 8 }, (_, i) => buyer(`b${i}`, 'qualified-no-deal'));
  const ranchers = Array.from({ length: 8 }, (_, i) => rancher(`r${i}`, 50));
  const rows = buildCockpitDialList({
    buyers,
    stuckRanchers: ranchers,
    coveredStates: new Set(['TX']),
  });
  assert.equal(rows.length, 10);
  // Equal-priority buyers preserve rankDialQueue's order.
  const buyerIds = rows.filter((r) => r.kind === 'buyer').map((r) => r.id);
  assert.deepEqual(buyerIds, buyerIds.slice().sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
});
