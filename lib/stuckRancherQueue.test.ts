import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveStuckBucket,
  missingSteps,
  proximityToPayable,
  daysStuck,
  isParked,
  scoreStuckRancher,
  rankStuckRancherQueue,
  WEIGHTS,
  DEMAND_CEILING,
  PROXIMITY,
  DEFAULT_STUCK_QUEUE_LIMIT,
  BUCKET_LABEL,
  type StuckRancherRow,
} from './stuckRancherQueue';

// A fixed "now" keeps every days-stuck assertion deterministic.
const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function row(over: Partial<StuckRancherRow> = {}): StuckRancherRow {
  return {
    id: 'rec1',
    ranchName: 'Test Ranch',
    operatorName: 'Test Operator',
    state: 'TX',
    email: 'r@example.com',
    phone: '+15125550000',
    emailOptOut: false,
    activeStatus: '',
    verificationStatus: '',
    onboardingStatus: '',
    agreementSigned: false,
    pageLive: false,
    pricingModel: 'tier_v2',
    connectAccountId: '',
    connectStatus: '',
    hasSlug: false,
    maxPrice: 0,
    hasPaymentLink: false,
    stuckEscalatedAt: daysAgo(5),
    stuckEscalatedBucket: 'new-applicant',
    lastTouchAt: '',
    buyersWaiting: 0,
    servedStates: ['TX'],
    ...over,
  };
}

// ── weights + constants ────────────────────────────────────────────────────

test('weights sum to 100 so a score reads as a percentage', () => {
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
});

test('demand outweighs proximity — the market is the prize', () => {
  assert.ok(WEIGHTS.demand > WEIGHTS.proximity);
});

test('every bucket has a human label', () => {
  for (const key of Object.keys(BUCKET_LABEL)) {
    assert.ok(BUCKET_LABEL[key as keyof typeof BUCKET_LABEL].length > 0);
  }
});

// ── bucket derivation mirrors the cron ladders ─────────────────────────────

test('connect-stuck: has a Connect account, not active, page not live', () => {
  const r = row({ connectAccountId: 'acct_1', connectStatus: 'onboarding', pageLive: false });
  assert.equal(deriveStuckBucket(r), 'connect-stuck');
});

test('live-no-deposits: tier_v2, page live, Connect not active', () => {
  const r = row({ pricingModel: 'tier_v2', pageLive: true, connectStatus: 'onboarding' });
  assert.equal(deriveStuckBucket(r), 'live-no-deposits');
});

test('live-no-deposits does not fire for a legacy rancher with a live page', () => {
  const r = row({ pricingModel: 'legacy', pageLive: true, connectStatus: '', agreementSigned: true });
  assert.notEqual(deriveStuckBucket(r), 'live-no-deposits');
});

test('connect-stuck wins over live-no-deposits when the page is not live', () => {
  // Cron ladder order: connect-stuck is checked first.
  const r = row({ connectAccountId: 'acct_1', connectStatus: 'onboarding', pageLive: false, agreementSigned: true });
  assert.equal(deriveStuckBucket(r), 'connect-stuck');
});

test('signed-no-page: signed the agreement, page still down', () => {
  const r = row({ agreementSigned: true, pageLive: false, pricingModel: 'legacy' });
  assert.equal(deriveStuckBucket(r), 'signed-no-page');
});

test('call-complete and docs-sent read off Onboarding Status', () => {
  assert.equal(deriveStuckBucket(row({ onboardingStatus: 'Call Complete' })), 'call-complete');
  assert.equal(deriveStuckBucket(row({ onboardingStatus: 'Docs Sent' })), 'docs-sent');
});

test('new-applicant: no Onboarding Status at all', () => {
  assert.equal(deriveStuckBucket(row({ onboardingStatus: '' })), 'new-applicant');
});

test('resolved: stamped stuck but every condition has cleared', () => {
  const r = row({
    onboardingStatus: 'Live',
    agreementSigned: true,
    pageLive: true,
    pricingModel: 'tier_v2',
    connectAccountId: 'acct_1',
    connectStatus: 'active',
  });
  assert.equal(deriveStuckBucket(r), 'resolved');
});

test('Connect status matching is case-insensitive', () => {
  const r = row({ pageLive: true, pricingModel: 'TIER_V2', connectStatus: 'Active', agreementSigned: true, onboardingStatus: 'Live' });
  assert.equal(deriveStuckBucket(r), 'resolved');
});

// ── missing steps ──────────────────────────────────────────────────────────

test('signed-no-page lists every concrete gap', () => {
  const r = row({ agreementSigned: true, pricingModel: 'legacy', hasSlug: false, maxPrice: 0, hasPaymentLink: false });
  const m = missingSteps(r);
  assert.equal(m.length, 3);
  assert.ok(m.some((s) => s.includes('slug')));
  assert.ok(m.some((s) => s.includes('price')));
  assert.ok(m.some((s) => s.includes('payment link')));
});

test('signed-no-page asks a tier_v2 rancher for Stripe, never a payment link', () => {
  const r = row({ agreementSigned: true, pricingModel: 'tier_v2', hasSlug: true, maxPrice: 1200, connectStatus: 'onboarding' });
  const m = missingSteps(r);
  assert.deepEqual(m, ['Connect your bank with Stripe']);
});

test('signed-no-page with nothing missing says go-live sync will flip them', () => {
  const r = row({ agreementSigned: true, pricingModel: 'legacy', hasSlug: true, maxPrice: 1200, hasPaymentLink: true });
  assert.match(missingSteps(r)[0], /go-live sync/);
});

test('docs-sent says the setup link was never opened', () => {
  assert.match(missingSteps(row({ onboardingStatus: 'Docs Sent' }))[0], /never opened the setup link/i);
});

test('every live bucket produces at least one actionable step', () => {
  const cases: StuckRancherRow[] = [
    row({ connectAccountId: 'acct_1', connectStatus: 'onboarding' }),
    row({ pageLive: true, connectStatus: 'onboarding' }),
    row({ agreementSigned: true }),
    row({ onboardingStatus: 'Call Complete' }),
    row({ onboardingStatus: 'Docs Sent' }),
    row({ onboardingStatus: '' }),
  ];
  for (const c of cases) assert.ok(missingSteps(c).length > 0, deriveStuckBucket(c));
});

// ── proximity ──────────────────────────────────────────────────────────────

test('proximity ladder ranks live-no-deposits above a never-started applicant', () => {
  const live = proximityToPayable(row({ pageLive: true, connectStatus: 'onboarding' }));
  const fresh = proximityToPayable(row({ onboardingStatus: '' }));
  assert.equal(live, PROXIMITY.liveNoDeposits);
  assert.equal(fresh, PROXIMITY.newApplicant);
  assert.ok(live > fresh);
});

test('proximity ladder is monotonically ordered', () => {
  const ordered = [
    PROXIMITY.connectActiveNoPage,
    PROXIMITY.liveNoDeposits,
    PROXIMITY.connectStarted,
    PROXIMITY.signedWithPrice,
    PROXIMITY.signed,
    PROXIMITY.callComplete,
    PROXIMITY.docsSent,
    PROXIMITY.newApplicant,
    PROXIMITY.resolved,
  ];
  for (let i = 1; i < ordered.length; i++) assert.ok(ordered[i] < ordered[i - 1], `rung ${i}`);
});

test('a signed rancher with a price beats a signed rancher without one', () => {
  assert.ok(
    proximityToPayable(row({ agreementSigned: true, maxPrice: 1400 })) >
      proximityToPayable(row({ agreementSigned: true, maxPrice: 0 })),
  );
});

// ── days stuck ─────────────────────────────────────────────────────────────

test('daysStuck counts whole days from the escalation stamp', () => {
  assert.equal(daysStuck(row({ stuckEscalatedAt: daysAgo(9) }), NOW), 9);
});

test('daysStuck never goes negative and survives a junk stamp', () => {
  assert.equal(daysStuck(row({ stuckEscalatedAt: daysAgo(-3) }), NOW), 0);
  assert.equal(daysStuck(row({ stuckEscalatedAt: 'not-a-date' }), NOW), 0);
  assert.equal(daysStuck(row({ stuckEscalatedAt: '' }), NOW), 0);
});

// ── parked ─────────────────────────────────────────────────────────────────

test('paused, non-compliant and removed ranchers are parked', () => {
  assert.equal(isParked(row({ activeStatus: 'Paused' })), true);
  assert.equal(isParked(row({ activeStatus: 'Non-Compliant' })), true);
  assert.equal(isParked(row({ verificationStatus: 'Removed' })), true);
  assert.equal(isParked(row({ activeStatus: 'Active' })), false);
  assert.equal(isParked(row({ activeStatus: '' })), false);
});

// ── scoring ────────────────────────────────────────────────────────────────

test('a maxed-out row scores 100', () => {
  const r = row({ buyersWaiting: DEMAND_CEILING, pageLive: false, connectStatus: 'active', connectAccountId: 'acct_1' });
  const s = scoreStuckRancher(r, NOW);
  assert.equal(s.signals.demand, 1);
  assert.equal(s.proximity, PROXIMITY.connectActiveNoPage);
  assert.equal(s.score, round2(WEIGHTS.demand + PROXIMITY.connectActiveNoPage * WEIGHTS.proximity));
});

test('demand saturates at the ceiling — one giant state cannot exceed its weight', () => {
  const a = scoreStuckRancher(row({ buyersWaiting: DEMAND_CEILING }), NOW);
  const b = scoreStuckRancher(row({ buyersWaiting: DEMAND_CEILING * 10 }), NOW);
  assert.equal(a.score, b.score);
  assert.equal(a.points.demand, WEIGHTS.demand);
});

test('a big-market applicant outranks a small-market near-payable rancher', () => {
  const texasApplicant = scoreStuckRancher(row({ buyersWaiting: 264, onboardingStatus: '' }), NOW);
  const vermontAlmostLive = scoreStuckRancher(
    row({ id: 'rec2', buyersWaiting: 5, pageLive: true, connectStatus: 'onboarding' }),
    NOW,
  );
  assert.ok(texasApplicant.score > vermontAlmostLive.score);
});

test('within one state, closer-to-payable wins', () => {
  const near = scoreStuckRancher(row({ buyersWaiting: 87, pageLive: true, connectStatus: 'onboarding' }), NOW);
  const far = scoreStuckRancher(row({ id: 'rec2', buyersWaiting: 87, onboardingStatus: '' }), NOW);
  assert.ok(near.score > far.score);
});

test('topReason names the dominant signal and the why sentence follows it', () => {
  const demandLed = scoreStuckRancher(row({ buyersWaiting: 264, onboardingStatus: '' }), NOW);
  assert.equal(demandLed.topReason, 'demand');
  assert.match(demandLed.why, /264 buyers waiting in TX/);

  const proximityLed = scoreStuckRancher(row({ buyersWaiting: 4, pageLive: true, connectStatus: 'onboarding' }), NOW);
  assert.equal(proximityLed.topReason, 'proximity');
  assert.match(proximityLed.why, /Stripe screen/);
});

test('bucketDrifted flags a rancher who moved since the cron escalated', () => {
  const same = scoreStuckRancher(row({ stuckEscalatedBucket: 'new-applicant', onboardingStatus: '' }), NOW);
  assert.equal(same.bucketDrifted, false);
  const moved = scoreStuckRancher(
    row({ stuckEscalatedBucket: 'new-applicant', onboardingStatus: 'Call Complete' }),
    NOW,
  );
  assert.equal(moved.bucketDrifted, true);
  assert.equal(moved.bucket, 'call-complete');
});

test('neverWorked is true until a rancher reply lands', () => {
  assert.equal(scoreStuckRancher(row({ lastTouchAt: '' }), NOW).neverWorked, true);
  assert.equal(scoreStuckRancher(row({ lastTouchAt: daysAgo(2) }), NOW).neverWorked, false);
});

test('scoring is pure — same row and now yields an identical score', () => {
  const r = row({ buyersWaiting: 87, onboardingStatus: 'Docs Sent' });
  assert.deepEqual(scoreStuckRancher(r, NOW), scoreStuckRancher(r, NOW));
});

// ── ranking ────────────────────────────────────────────────────────────────

test('rows with no escalation stamp never enter the queue', () => {
  const out = rankStuckRancherQueue([row({ stuckEscalatedAt: '' })], { now: NOW });
  assert.equal(out.rows.length, 0);
  assert.equal(out.totalStuck, 0);
});

test('parked and resolved rows are counted, not listed', () => {
  const out = rankStuckRancherQueue(
    [
      row({ id: 'a', activeStatus: 'Paused' }),
      row({ id: 'b', verificationStatus: 'Removed' }),
      row({
        id: 'c',
        onboardingStatus: 'Live',
        agreementSigned: true,
        pageLive: true,
        connectAccountId: 'acct_1',
        connectStatus: 'active',
      }),
      row({ id: 'd', buyersWaiting: 264 }),
    ],
    { now: NOW },
  );
  assert.equal(out.parkedCount, 2);
  assert.equal(out.resolvedCount, 1);
  assert.equal(out.totalStuck, 1);
  assert.deepEqual(out.rows.map((r) => r.id), ['d']);
});

test('queue is sorted by score, highest first', () => {
  const out = rankStuckRancherQueue(
    [
      row({ id: 'small', buyersWaiting: 5 }),
      row({ id: 'big', buyersWaiting: 264 }),
      row({ id: 'mid', buyersWaiting: 87 }),
    ],
    { now: NOW },
  );
  assert.deepEqual(out.rows.map((r) => r.id), ['big', 'mid', 'small']);
});

test('a tie breaks on days-stuck, longest-ignored first', () => {
  const out = rankStuckRancherQueue(
    [
      row({ id: 'recNew', buyersWaiting: 87, stuckEscalatedAt: daysAgo(1) }),
      row({ id: 'recOld', buyersWaiting: 87, stuckEscalatedAt: daysAgo(10) }),
    ],
    { now: NOW },
  );
  assert.deepEqual(out.rows.map((r) => r.id), ['recOld', 'recNew']);
  assert.equal(out.rows[0].score, out.rows[1].score);
});

test('a full tie breaks on id so the list never reshuffles between renders', () => {
  const opts = { now: NOW };
  const rows = [
    row({ id: 'recB', buyersWaiting: 87, stuckEscalatedAt: daysAgo(3) }),
    row({ id: 'recA', buyersWaiting: 87, stuckEscalatedAt: daysAgo(3) }),
  ];
  assert.deepEqual(rankStuckRancherQueue(rows, opts).rows.map((r) => r.id), ['recA', 'recB']);
  assert.deepEqual(
    rankStuckRancherQueue([...rows].reverse(), opts).rows.map((r) => r.id),
    ['recA', 'recB'],
  );
});

test('limit trims the list but totalStuck still reports the whole cohort', () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    row({ id: `rec${String(i).padStart(2, '0')}`, buyersWaiting: 20 + i }),
  );
  const out = rankStuckRancherQueue(many, { now: NOW });
  assert.equal(out.rows.length, DEFAULT_STUCK_QUEUE_LIMIT);
  assert.equal(out.totalStuck, 20);
  const all = rankStuckRancherQueue(many, { now: NOW, limit: Infinity });
  assert.equal(all.rows.length, 20);
});

test('limit 0 yields an empty list without throwing', () => {
  const out = rankStuckRancherQueue([row({ buyersWaiting: 10 })], { now: NOW, limit: 0 });
  assert.equal(out.rows.length, 0);
  assert.equal(out.totalStuck, 1);
});

test('an empty input is handled', () => {
  const out = rankStuckRancherQueue([], { now: NOW });
  assert.deepEqual(out, { rows: [], parkedCount: 0, resolvedCount: 0, totalStuck: 0 });
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── paused-review carve-out (pipeline-sla, 2026-08-12) ─────────────────────

test('a Paused rancher with the paused-review bucket PASSES the parked filter', () => {
  const r = row({
    activeStatus: 'Paused',
    stuckEscalatedBucket: 'paused-review',
    stuckEscalatedAt: daysAgo(3),
    buyersWaiting: 50,
  });
  const out = rankStuckRancherQueue([r], { now: NOW });
  assert.equal(out.parkedCount, 0);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].bucket, 'paused-review');
  assert.equal(out.rows[0].bucketDrifted, false);
  assert.equal(out.rows[0].missing[0].includes('resume routing or retire'), true);
});

test('paused ranchers with any OTHER bucket stay parked; Removed always parks', () => {
  const otherBucket = row({ activeStatus: 'Paused', stuckEscalatedBucket: 'connect-stuck' });
  assert.equal(rankStuckRancherQueue([otherBucket], { now: NOW }).parkedCount, 1);
  const removed = row({
    activeStatus: 'Paused',
    verificationStatus: 'Removed',
    stuckEscalatedBucket: 'paused-review',
  });
  assert.equal(rankStuckRancherQueue([removed], { now: NOW }).parkedCount, 1);
  const nonCompliant = row({ activeStatus: 'Non-Compliant', stuckEscalatedBucket: 'paused-review' });
  assert.equal(rankStuckRancherQueue([nonCompliant], { now: NOW }).parkedCount, 1);
});

test('a RESUMED rancher with a stale paused-review stamp falls through to the live ladder', () => {
  const resumed = row({
    activeStatus: 'Active',
    stuckEscalatedBucket: 'paused-review',
    onboardingStatus: 'Call Complete',
  });
  assert.equal(deriveStuckBucket(resumed), 'call-complete');
  const out = rankStuckRancherQueue([resumed], { now: NOW });
  assert.equal(out.rows[0]?.bucketDrifted, true);
});

test('paused-review has a bucket label for the desk', () => {
  assert.equal(typeof BUCKET_LABEL['paused-review'], 'string');
  assert.ok(BUCKET_LABEL['paused-review'].length > 0);
});
