// lib/cockpitDialList.test.ts
//
// Wave 1B — the cockpit's merged dial list. Pins the merge priorities, the
// supply gate (uncovered-state buyers collapse into recruit signals), and the
// row cap. Cockpit CRM-parity (§3.5 C2) adds the promise/deal/action fusion,
// the dedupe rules, and the C1 write-back gates. All names are synthetic
// fixtures (public repo).

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCockpitDialList } from './cockpitDialList';
import type { RankedDialCandidate } from './callbackQueue';
import type { RankedStuckRancherRow } from './stuckRancherQueue';
import type { DueFollowUp } from './followUpQueue';
import type { RankedCloseQueueRow } from './closeQueue';
import type { NBAItem } from './nextBestAction';

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

// ─── C2 fusion ──────────────────────────────────────────────────────────────

const promise = (id: string, daysOverdue = 0, state = 'TX'): DueFollowUp => ({
  id,
  name: `Test Promise ${id}`,
  email: `${id}@example.com`,
  phone: '5550001111',
  state,
  notes: 'wants a quarter in fall',
  dueAt: '2026-08-01',
  daysOverdue,
});

const deal = (id: string, score: number, lastChasedAt = ''): RankedCloseQueueRow =>
  ({
    id,
    status: 'Negotiation',
    buyerName: `Test Deal Buyer ${id}`,
    buyerState: 'TX',
    buyerEmail: `${id}@example.com`,
    buyerPhone: '5552223333',
    rancherName: 'Test Ranch',
    hasRancher: true,
    rancherCanCapture: true,
    intentScore: 80,
    saleAmount: 2000,
    budgetRange: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    introSentAt: '2026-08-01T00:00:00.000Z',
    lastChasedAt,
    score,
    signals: {} as any,
    points: {} as any,
    topReason: 'dealValue',
    why: `deal-why-${id}`,
    estValue: 2000,
    estFee: 200,
    daysSinceTouch: 5,
  }) as RankedCloseQueueRow;

test('promise ranks below a callback, above deposit-opened; deal rides its score', () => {
  const rows = buildCockpitDialList({
    buyers: [buyer('b-cb', 'callback'), buyer('b-dep', 'deposit-opened')],
    stuckRanchers: [],
    coveredStates: new Set(['TX']),
    followUpsDue: [promise('p1')],
    closeQueue: [deal('d1', 60)], // 25 + 0.5*60 = 55
  });
  assert.deepEqual(
    rows.map((r) => r.id),
    ['b-cb', 'p1', 'b-dep', 'd1'],
  );
  assert.equal(rows[1].kind, 'promise');
  assert.equal(rows[1].outcomeKind, 'promise');
  assert.equal(rows[3].kind, 'deal');
  assert.equal(rows[3].outcomeKind, 'deal');
  assert.match(rows[1].why, /due today/);
});

test('dedupe: a promise for a buyer already listed folds in instead of duplicating', () => {
  const rows = buildCockpitDialList({
    buyers: [buyer('b1', 'qualified-no-deal')], // priority 45
    stuckRanchers: [],
    coveredStates: new Set(['TX']),
    followUpsDue: [promise('b1', 2)],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'buyer');
  assert.equal(rows[0].priority, 85); // upgraded to the promise band
  assert.match(rows[0].why, /2d overdue/);
});

test('dedupe: a deal whose referral is already a deposit-opened row is dropped', () => {
  const b = { ...buyer('b1', 'deposit-opened'), referralId: 'ref1' };
  const rows = buildCockpitDialList({
    buyers: [b],
    stuckRanchers: [],
    coveredStates: new Set(['TX']),
    closeQueue: [deal('ref1', 90)],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'buyer');
  assert.equal(rows[0].referralId, 'ref1');
});

test('NBA items annotate matching rows; unmatched p1 items become top action rows', () => {
  const nba: NBAItem[] = [
    {
      priority: 1,
      type: 'call',
      subject: 'Test Caller · TX',
      reason: 'Cal call in 40 min',
      action: 'Pull buyer Airtable + jump on call',
      entityType: 'cal',
      entityId: 'cal-1',
    },
    {
      priority: 1,
      type: 'call',
      subject: 'Test Buyer b1 · TX',
      reason: 'Lead score 90',
      action: 'Phone outreach — hot lead',
      entityType: 'consumer',
      entityId: 'b1',
    },
    {
      priority: 3,
      type: 'recruit',
      subject: 'Recruit supply in MT',
      reason: 'skip me',
      action: 'skip me',
      entityType: 'rancher',
    },
  ];
  const rows = buildCockpitDialList({
    buyers: [buyer('b1', 'qualified-no-deal')],
    stuckRanchers: [],
    coveredStates: new Set(['TX']),
    nba,
  });
  // Unmatched cal item tops the list at 97; matched consumer item annotates
  // b1 instead of adding a row; NBA recruit items never duplicate the list's
  // own recruit computation.
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'action');
  assert.match(rows[0].why, /Cal call/);
  assert.equal(rows[1].id, 'b1');
  assert.equal(rows[1].nba, 'Phone outreach — hot lead');
  assert.equal(rows[0].outcomeKind, undefined); // no outcome buttons on action rows
});

// ─── C1 write-back gates ────────────────────────────────────────────────────

const NOW = Date.parse('2026-08-10T18:00:00.000Z');

test('buyer deferred to a future date is off the list until due', () => {
  const deferred = { ...buyer('b1', 'deposit-opened'), nextFollowUpAt: '2026-08-17' };
  const dueToday = { ...buyer('b2', 'deposit-opened'), nextFollowUpAt: '2026-08-10' };
  const rows = buildCockpitDialList({
    buyers: [deferred, dueToday],
    stuckRanchers: [],
    coveredStates: new Set(['TX']),
    now: NOW,
    today: '2026-08-10',
  });
  assert.deepEqual(
    rows.map((r) => r.id),
    ['b2'],
  );
});

test('deposit-opened buyer whose referral was chased today is off the list', () => {
  const chased = {
    ...buyer('b1', 'deposit-opened'),
    referralId: 'ref1',
    lastChasedAt: '2026-08-10T15:00:00.000Z', // 3h ago
  };
  const stale = {
    ...buyer('b2', 'deposit-opened'),
    referralId: 'ref2',
    lastChasedAt: '2026-08-08T15:00:00.000Z', // 51h ago
  };
  const rows = buildCockpitDialList({
    buyers: [chased, stale],
    stuckRanchers: [],
    coveredStates: new Set(['TX']),
    now: NOW,
  });
  assert.deepEqual(
    rows.map((r) => r.id),
    ['b2'],
  );
});

test('deal chased today is off the list; rancher touched within 48h is off the list', () => {
  const touched = { ...rancher('r1', 80), lastTouchAt: '2026-08-09T18:00:00.000Z' }; // 24h
  const untouched = rancher('r2', 80);
  const rows = buildCockpitDialList({
    buyers: [],
    stuckRanchers: [touched, untouched],
    coveredStates: new Set(['TX']),
    closeQueue: [deal('d-fresh', 70, '2026-08-10T12:00:00.000Z'), deal('d-old', 70, '2026-08-01T12:00:00.000Z')],
    now: NOW,
  });
  assert.deepEqual(
    rows.map((r) => r.id).sort(),
    ['d-old', 'r2'].sort(),
  );
});

test('without now/today the gates stay off (legacy callers unchanged)', () => {
  const deferred = { ...buyer('b1', 'deposit-opened'), nextFollowUpAt: '2099-01-01' };
  const touched = { ...rancher('r1', 80), lastTouchAt: '2026-08-10T17:59:00.000Z' };
  const rows = buildCockpitDialList({
    buyers: [deferred],
    stuckRanchers: [touched],
    coveredStates: new Set(['TX']),
  });
  assert.equal(rows.length, 2);
});
