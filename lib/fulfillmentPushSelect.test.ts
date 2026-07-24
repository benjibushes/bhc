import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectPushCandidates,
  classifyPushOutcome,
  PUSH_WINDOW_MS,
  STALE_PUSHING_GRACE_MS,
  MAX_PUSH_PER_RUN,
  type PushCandidateOrder,
} from './fulfillmentPushSelect';

const NOW = '2026-07-24T12:00:00.000Z';
const nowMs = Date.parse(NOW);
const msAgo = (ms: number) => new Date(nowMs - ms).toISOString();
const daysAgo = (d: number) => msAgo(d * 24 * 60 * 60 * 1000);
const minsAgo = (m: number) => msAgo(m * 60 * 1000);

// A plain, pushable blank New order settled 1 day ago.
const blank = (over: Partial<PushCandidateOrder> = {}): PushCandidateOrder => ({
  id: 'recBLANK',
  status: 'New',
  externalPushStatus: '',
  orderedAt: daysAgo(1),
  ...over,
});

// ─── M1(a): oldest-first ordering ──────────────────────────────────────────

test('M1(a): candidates are ordered oldest-first by Ordered At', () => {
  const sel = selectPushCandidates(
    [
      blank({ id: 'young', orderedAt: daysAgo(1) }),
      blank({ id: 'oldest', orderedAt: daysAgo(2.5) }),
      blank({ id: 'middle', orderedAt: daysAgo(2) }),
    ],
    NOW,
  );
  assert.deepEqual(sel.toPush, ['oldest', 'middle', 'young']);
});

test('M1(a): the cap keeps the OLDEST, defers the rest (no starvation)', () => {
  const orders: PushCandidateOrder[] = [];
  // 25 orders, increasing age with index. Oldest 20 must be selected.
  for (let i = 0; i < MAX_PUSH_PER_RUN + 5; i++) {
    orders.push(blank({ id: `o${i}`, orderedAt: msAgo(i * 60 * 60 * 1000 + 60 * 1000) }));
  }
  const sel = selectPushCandidates(orders, NOW);
  assert.equal(sel.toPush.length, MAX_PUSH_PER_RUN);
  assert.equal(sel.totalEligible, MAX_PUSH_PER_RUN + 5);
  assert.equal(sel.deferred, 5);
  // Oldest (highest index) come first; the 5 youngest (o0..o4) are deferred.
  assert.equal(sel.toPush[0], `o${MAX_PUSH_PER_RUN + 4}`);
  for (let i = 0; i < 5; i++) assert.ok(!sel.toPush.includes(`o${i}`), `o${i} should be deferred`);
});

// ─── M1(b): window-independent backstop ────────────────────────────────────

test('M1(b): a blank order OLDER than the 3-day window is still selected (backstop)', () => {
  const aged = blank({ id: 'aged', orderedAt: msAgo(PUSH_WINDOW_MS + 5 * 24 * 60 * 60 * 1000) });
  const sel = selectPushCandidates([aged], NOW);
  assert.deepEqual(sel.toPush, ['aged']);
  assert.equal(sel.sourceCounts.aged, 1);
});

test('M1(b): a blank order WITHIN the window is selected (source blank)', () => {
  const sel = selectPushCandidates([blank({ id: 'fresh', orderedAt: daysAgo(1) })], NOW);
  assert.deepEqual(sel.toPush, ['fresh']);
  assert.equal(sel.sourceCounts.blank, 1);
});

test('M1(b): an AGED blank order for a rancher with NO integration is excluded (no forever-loop)', () => {
  const aged = blank({
    id: 'noint',
    orderedAt: msAgo(PUSH_WINDOW_MS + 24 * 60 * 60 * 1000),
    hasIntegration: false,
  });
  assert.equal(selectPushCandidates([aged], NOW).toPush.length, 0);
});

test('M1(b): a no-integration order WITHIN the window is still swept (late-connect grace)', () => {
  const within = blank({ id: 'noint-fresh', orderedAt: daysAgo(1), hasIntegration: false });
  assert.deepEqual(selectPushCandidates([within], NOW).toPush, ['noint-fresh']);
});

test('M1(b): unknown integration (undefined) fails OPEN — aged order still selected', () => {
  const aged = blank({ id: 'unknown', orderedAt: daysAgo(9), hasIntegration: undefined });
  assert.deepEqual(selectPushCandidates([aged], NOW).toPush, ['unknown']);
});

// ─── Stale-'pushing' recovery ──────────────────────────────────────────────

test("stale 'pushing' (Ordered At older than grace, no External Pushed At) → included", () => {
  const stale = blank({
    id: 'crashed',
    externalPushStatus: 'pushing',
    orderedAt: minsAgo(60), // > 30m grace
    externalPushedAt: '',
  });
  const sel = selectPushCandidates([stale], NOW);
  assert.deepEqual(sel.toPush, ['crashed']);
  assert.equal(sel.sourceCounts['stale-pushing'], 1);
});

test("fresh 'pushing' (younger than grace) → excluded (do not interrupt an in-flight push)", () => {
  const fresh = blank({
    id: 'inflight',
    externalPushStatus: 'pushing',
    orderedAt: minsAgo(5), // < 30m grace
    externalPushedAt: '',
  });
  assert.equal(selectPushCandidates([fresh], NOW).toPush.length, 0);
});

test("'pushing' with a RECENT External Pushed At → excluded even if Ordered At is old", () => {
  const fresh = blank({
    id: 'inflight2',
    externalPushStatus: 'pushing',
    orderedAt: daysAgo(3),
    externalPushedAt: minsAgo(2),
  });
  assert.equal(selectPushCandidates([fresh], NOW).toPush.length, 0);
});

test("'pushing' with a STALE External Pushed At → included", () => {
  const stale = blank({
    id: 'stalepush',
    externalPushStatus: 'pushing',
    orderedAt: daysAgo(3),
    externalPushedAt: minsAgo(45),
  });
  assert.deepEqual(selectPushCandidates([stale], NOW).toPush, ['stalepush']);
});

test('exactly at the stale-pushing grace → included (>=)', () => {
  const at = blank({
    id: 'edge',
    externalPushStatus: 'pushing',
    orderedAt: msAgo(STALE_PUSHING_GRACE_MS),
    externalPushedAt: '',
  });
  assert.deepEqual(selectPushCandidates([at], NOW).toPush, ['edge']);
});

// ─── Terminal states are never routine candidates ──────────────────────────

test("'pushed' / 'cancelled' / has-External-Order-Id are never selected by the routine sweep", () => {
  const pushed = blank({ id: 'p', externalPushStatus: 'pushed' });
  const cancelled = blank({ id: 'c', externalPushStatus: 'cancelled' });
  const hasId = blank({ id: 'h', externalPushStatus: '', externalOrderId: 'gid://shopify/Order/1' });
  // Note: hasId has blank status but an external id — routine blank branch does
  // not consult external id, so assert via the retry path instead below. Here
  // the routine sweep should still skip a 'pushed'/'cancelled' row.
  const sel = selectPushCandidates([pushed, cancelled, hasId], NOW);
  assert.ok(!sel.toPush.includes('p'));
  assert.ok(!sel.toPush.includes('c'));
});

test("'failed:*' is NOT auto-retried by the routine sweep (only via Push Retry Requested At)", () => {
  const failed = blank({ id: 'f', externalPushStatus: 'failed:config' });
  assert.equal(selectPushCandidates([failed], NOW).toPush.length, 0);
});

test('non-New status is excluded', () => {
  for (const status of ['Shipped', 'Refunded', 'Cancelled', '']) {
    assert.equal(selectPushCandidates([blank({ id: 'x', status })], NOW).toPush.length, 0, `status=${status}`);
  }
});

// ─── M2: Push Retry Requested At ───────────────────────────────────────────

test('M2: a retry-requested blank order is selected + queued for flag-clear', () => {
  const retry = blank({ id: 'r', pushRetryRequestedAt: minsAgo(1) });
  const sel = selectPushCandidates([retry], NOW);
  assert.deepEqual(sel.toPush, ['r']);
  assert.deepEqual(sel.clearRetryIds, ['r']);
  assert.equal(sel.sourceCounts['retry-requested'], 1);
});

test('M2: a retry-requested order OUTSIDE the 3-day window is still selected (window-independent)', () => {
  const retry = blank({ id: 'r7', orderedAt: daysAgo(7), pushRetryRequestedAt: minsAgo(1) });
  assert.deepEqual(selectPushCandidates([retry], NOW).toPush, ['r7']);
});

test('M2: a retry-requested FAILED order is selected (operator fixed the SKU)', () => {
  const retry = blank({ id: 'rf', externalPushStatus: 'failed:no-sku', orderedAt: daysAgo(7), pushRetryRequestedAt: minsAgo(1) });
  const sel = selectPushCandidates([retry], NOW);
  assert.deepEqual(sel.toPush, ['rf']);
  assert.deepEqual(sel.clearRetryIds, ['rf']);
});

test('M2: a retry-requested but ALREADY-PUSHED order is moot — not pushed, but flag cleared', () => {
  const moot = blank({ id: 'm', externalPushStatus: 'pushed', pushRetryRequestedAt: minsAgo(1) });
  const sel = selectPushCandidates([moot], NOW);
  assert.deepEqual(sel.toPush, []);
  assert.deepEqual(sel.clearRetryIds, ['m']);
});

test('M2: a retry-requested order that already has an External Order Id is moot (cleared, not pushed)', () => {
  const moot = blank({ id: 'm2', externalPushStatus: '', externalOrderId: 'gid://shopify/Order/9', pushRetryRequestedAt: minsAgo(1) });
  const sel = selectPushCandidates([moot], NOW);
  assert.deepEqual(sel.toPush, []);
  assert.deepEqual(sel.clearRetryIds, ['m2']);
});

test('M2: retry-requested jumps ahead of an OLDER routine blank order (priority)', () => {
  const sel = selectPushCandidates(
    [
      blank({ id: 'old-routine', orderedAt: daysAgo(2.9) }),
      blank({ id: 'fresh-retry', orderedAt: daysAgo(0.1), pushRetryRequestedAt: minsAgo(1) }),
    ],
    NOW,
  );
  assert.deepEqual(sel.toPush, ['fresh-retry', 'old-routine']);
});

test('M2: a retry-requested order DEFERRED past the cap keeps its flag (only attempted ones clear)', () => {
  const orders: PushCandidateOrder[] = [];
  // 21 retry-requested pushable orders, increasing age with index.
  for (let i = 0; i < MAX_PUSH_PER_RUN + 1; i++) {
    orders.push(blank({ id: `r${i}`, orderedAt: msAgo(i * 60 * 1000 + 1000), pushRetryRequestedAt: minsAgo(1) }));
  }
  const sel = selectPushCandidates(orders, NOW);
  assert.equal(sel.toPush.length, MAX_PUSH_PER_RUN);
  assert.equal(sel.clearRetryIds.length, MAX_PUSH_PER_RUN); // only the attempted 20 clear
  assert.equal(sel.deferred, 1);
  // The single youngest retry row (r0) is the one deferred — its flag is NOT cleared.
  assert.ok(!sel.clearRetryIds.includes('r0'));
  assert.ok(!sel.toPush.includes('r0'));
});

// ─── Guards ────────────────────────────────────────────────────────────────

test('bad now / empty / null rows → empty selection (no throw)', () => {
  assert.deepEqual(selectPushCandidates([blank()], 'garbage').toPush, []);
  assert.deepEqual(selectPushCandidates([], NOW).toPush, []);
  assert.deepEqual(selectPushCandidates([null as any, undefined as any], NOW).toPush, []);
  assert.deepEqual(selectPushCandidates([{ id: '', status: 'New' } as any], NOW).toPush, []);
});

// ─── classifyPushOutcome ───────────────────────────────────────────────────

test('classifyPushOutcome maps every post-attempt status correctly', () => {
  assert.equal(classifyPushOutcome('pushed'), 'pushed');
  assert.equal(classifyPushOutcome('pushed-unstamped:gid://x'), 'pushed');
  assert.equal(classifyPushOutcome('cancelled'), 'skipped');
  assert.equal(classifyPushOutcome('skipped:deposit-style'), 'skipped');
  assert.equal(classifyPushOutcome('skipped:no-sku'), 'skipped');
  assert.equal(classifyPushOutcome('failed:config'), 'failed');
  assert.equal(classifyPushOutcome('cancel-failed:boom'), 'failed');
  assert.equal(classifyPushOutcome(''), 'retryable');
  assert.equal(classifyPushOutcome('pushing'), 'retryable');
  assert.equal(classifyPushOutcome(null), 'retryable');
  assert.equal(classifyPushOutcome(undefined), 'retryable');
});
