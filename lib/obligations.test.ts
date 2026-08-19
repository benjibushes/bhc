// lib/obligations.test.ts
//
// Fulfillment audit P0-1 (2026-08-18): the OBLIGATIONS selector — every row,
// on every rail, where BHC has taken a customer's money and cannot prove the
// customer got their beef.
//
// Run: JWT_SECRET=test-secret-ci npx tsx --test lib/obligations.test.ts
// (or the full suite: npm test)
//
// The pin these tests defend: before this module the ONLY money-at-risk tile
// on any operator surface was `Deposit Paid At && !Rancher Accepted At`, so a
// deal vanished from every screen the instant a rancher tapped Accept —
// months before anyone could prove delivery. These tests pin all three rails
// plus the empty case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectObligations, type ObligationRow } from './obligations';
import { MAX_LIFETIME_CHASES } from './fulfillmentChase';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const hoursAgo = (h: number) => new Date(NOW - h * HOUR).toISOString();
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

/** A Connect referral: deposit paid, rancher accepted, nothing confirms it. */
function connectRef(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'recConnect',
    'Deposit Paid At': daysAgo(10),
    'Rancher Accepted At': daysAgo(9),
    Status: 'Slot Locked',
    'Deposit Amount': 500,
    'Buyer Name': 'Buyer One',
    'Buyer Email': 'one@example.com',
    'Buyer State': 'CO',
    Rancher: ['recRanchConnect'],
    ...overrides,
  };
}

/** A BROKER referral: deposit paid, fulfillment sheet delivered after it. */
function brokerRef(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'recBroker',
    'Match Type': 'Broker — Deposit',
    'Deposit Paid At': daysAgo(6),
    'Intro Sent At': daysAgo(6), // sheet delivered at settle
    Status: 'Awaiting Payment',
    'Deposit Amount': 300,
    'Buyer Name': 'Buyer Two',
    'Buyer Email': 'two@example.com',
    'Buyer State': 'AZ',
    Rancher: ['recRanchBroker'],
    ...overrides,
  };
}

/** A shop order: paid, still sitting in Status='New'. */
function shopOrder(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'recOrder',
    Status: 'New',
    'Ordered At': daysAgo(9),
    'Order Ref': 'BHC-oid:recOrder',
    'Buyer Paid': 120,
    'Buyer Name': 'Buyer Three',
    'Rancher Name': 'Shop Ranch',
    'Product Record ID': 'recProduct',
    ...overrides,
  };
}

const rancherById = new Map<string, any>([
  ['recRanchConnect', { id: 'recRanchConnect', 'Ranch Name': 'Connect Ranch' }],
  ['recRanchBroker', { id: 'recRanchBroker', 'Ranch Name': 'Broker Ranch', 'Broker Rail': true }],
]);

function run(input: Partial<Parameters<typeof selectObligations>[0]> = {}): ObligationRow[] {
  return selectObligations({
    referrals: [],
    rancherOrders: [],
    rancherById,
    now: NOW,
    ...input,
  });
}

const ids = (rows: ObligationRow[]) => rows.map((r) => r.id);

// ── The empty case ───────────────────────────────────────────────────────────

test('empty everything → empty band (and never throws)', () => {
  assert.deepEqual(run(), []);
  assert.deepEqual(
    selectObligations({ referrals: [], rancherOrders: [], rancherById: new Map(), now: NOW }),
    [],
  );
});

test('no obligations → empty band even with healthy rows present', () => {
  const rows = run({
    referrals: [
      // confirmed via the binary stamp
      connectRef({ id: 'recA', 'Fulfillment Confirmed At': daysAgo(1) }),
      // confirmed via the richer tracker
      connectRef({ id: 'recB', 'Fulfillment Status': 'fulfilled' }),
      // no money collected at all
      connectRef({ id: 'recC', 'Deposit Paid At': '' }),
    ],
    rancherOrders: [shopOrder({ id: 'recD', Status: 'Shipped' })],
  });
  assert.deepEqual(rows, []);
});

// ── RAIL 1 — Connect / legacy ────────────────────────────────────────────────

test('connect: deposit paid + accepted + unconfirmed → an obligation (the P0-1 hole)', () => {
  const rows = run({ referrals: [connectRef()] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rail, 'connect');
  assert.equal(rows[0].id, 'recConnect');
  assert.equal(rows[0].ageHours, 10 * 24);
  assert.equal(rows[0].amountCents, 50_000);
});

test('connect: deposit paid + NEVER accepted → still an obligation (P0-2 rows surface here)', () => {
  const rows = run({
    referrals: [connectRef({ 'Rancher Accepted At': '', Status: 'Awaiting Payment' })],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rail, 'connect');
  assert.match(rows[0].nextAction, /never accepted/i);
  assert.equal(rows[0].pinned, true); // 10d unaccepted is way past the 72h escalation
});

test('connect: closed / refunded / cancelled / expired statuses are NOT obligations', () => {
  const rows = run({
    referrals: [
      connectRef({ id: 'recW', Status: 'Closed Won' }),
      connectRef({ id: 'recL', Status: 'Closed Lost' }),
      connectRef({ id: 'recR', Status: 'Refunded' }),
      connectRef({ id: 'recC', Status: 'Cancelled' }),
      connectRef({ id: 'recC2', Status: 'Canceled' }),
      connectRef({ id: 'recE', Status: 'Expired' }),
    ],
  });
  assert.deepEqual(rows, []);
});

test('connect: a refunded or disputed Payments row drops the obligation', () => {
  const paymentByReferralId = new Map<string, any>([
    ['recRefunded', { 'Refunded At': daysAgo(1) }],
    ['recDisputed', { 'Dispute Status': 'needs_response' }],
    ['recLive', { Status: 'succeeded' }],
  ]);
  const rows = run({
    referrals: [
      connectRef({ id: 'recRefunded' }),
      connectRef({ id: 'recDisputed' }),
      connectRef({ id: 'recLive' }),
    ],
    paymentByReferralId,
  });
  assert.deepEqual(ids(rows), ['recLive']);
});

test('connect: synthetic e2e buyers never reach the operator band', () => {
  const rows = run({
    referrals: [connectRef({ id: 'recBot', 'Buyer Email': 'probe-audit@example.test' })],
  });
  assert.deepEqual(rows, []);
});

test('connect: an exhausted chase ladder pins the row instead of losing it (P0-3)', () => {
  const rows = run({
    referrals: [connectRef({ 'Fulfillment Chase Count': MAX_LIFETIME_CHASES })],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pinned, true);
  assert.match(rows[0].nextAction, /chas/i);
});

test('connect: a Fulfillment Escalated At stamp pins the row', () => {
  const rows = run({
    referrals: [connectRef({ 'Fulfillment Escalated At': daysAgo(1) })],
  });
  assert.equal(rows[0].pinned, true);
});

test('connect: a live ladder (count under the cap, recently accepted) is NOT pinned', () => {
  const rows = run({
    referrals: [
      connectRef({
        'Deposit Paid At': hoursAgo(30),
        'Rancher Accepted At': hoursAgo(29),
        'Fulfillment Chase Count': 1,
      }),
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pinned, false);
});

// ── RAIL 2 — Broker ──────────────────────────────────────────────────────────

test('broker: deposit paid + sheet delivered + unconfirmed → an obligation', () => {
  const rows = run({ referrals: [brokerRef()] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rail, 'broker');
  assert.equal(rows[0].amountCents, 30_000);
  assert.match(rows[0].nextAction, /pickup/i);
});

test('broker rail is read off the linked rancher too, not just Match Type', () => {
  const rows = run({
    referrals: [brokerRef({ 'Match Type': '' })], // rancher carries `Broker Rail`
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rail, 'broker');
});

test('broker: sheet NEVER delivered is still an obligation, pinned, with its own action', () => {
  const rows = run({
    referrals: [
      brokerRef({ 'Intro Sent At': '' }),
      // a pre-deposit routing-time stamp is NOT a delivery either
      brokerRef({ id: 'recStale', 'Intro Sent At': daysAgo(20) }),
    ],
  });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.rail, 'broker');
    assert.equal(r.pinned, true);
    assert.match(r.nextAction, /sheet/i);
  }
});

test('broker: a closed or confirmed row is not an obligation', () => {
  const rows = run({
    referrals: [
      brokerRef({ id: 'recBW', Status: 'Closed Won' }),
      brokerRef({ id: 'recBC', 'Fulfillment Confirmed At': daysAgo(1) }),
    ],
  });
  assert.deepEqual(rows, []);
});

test('broker rows never take the Connect lane (no accept exists on that rail)', () => {
  const rows = run({ referrals: [brokerRef()] });
  assert.equal(rows.length, 1);
  assert.equal(/accept/i.test(rows[0].nextAction), false);
  assert.equal(/accept/i.test(rows[0].stage), false);
});

// ── RAIL 3 — Shop (Rancher Orders) ───────────────────────────────────────────

test('shop: a New order past the flat window is an obligation', () => {
  const rows = run({ rancherOrders: [shopOrder()] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rail, 'shop');
  assert.equal(rows[0].id, 'recOrder');
  assert.equal(rows[0].amountCents, 12_000);
});

test("shop: the ranch's OWN Ships In Days promise sets the window", () => {
  // 5-day order. A 14-day promise (+1 grace) is NOT late; a 2-day promise is.
  const patient = run({
    rancherOrders: [shopOrder({ 'Ordered At': daysAgo(5) })],
    shipDaysByProductId: new Map([['recProduct', 14]]),
  });
  assert.deepEqual(patient, []);

  const late = run({
    rancherOrders: [shopOrder({ 'Ordered At': daysAgo(5) })],
    shipDaysByProductId: new Map([['recProduct', 2]]),
  });
  assert.equal(late.length, 1);
  assert.equal(late[0].promisedDays, 2);
  assert.match(late[0].nextAction, /2/);
});

test('shop: an order still inside its window is not an obligation', () => {
  const rows = run({ rancherOrders: [shopOrder({ 'Ordered At': hoursAgo(6) })] });
  assert.deepEqual(rows, []);
});

test('shop: DEPOSIT / PICKUP orders ride the slow windows (they dwell in New by design)', () => {
  const rows = run({
    rancherOrders: [
      shopOrder({ id: 'recDep', 'Order Ref': 'DEPOSIT — BHC-oid:recDep', 'Ordered At': daysAgo(5) }),
      shopOrder({ id: 'recPick', 'Order Ref': 'PICKUP — BHC-oid:recPick', 'Ordered At': daysAgo(5) }),
    ],
  });
  assert.deepEqual(rows, []);
});

test('shop: refunded / cancelled orders are not obligations', () => {
  const rows = run({
    rancherOrders: [
      shopOrder({ id: 'recRef', 'Refunded At': daysAgo(1) }),
      shopOrder({ id: 'recCan', 'Cancelled At': daysAgo(1) }),
    ],
  });
  assert.deepEqual(rows, []);
});

test('shop: past the escalate window the row pins', () => {
  const rows = run({ rancherOrders: [shopOrder({ 'Ordered At': daysAgo(30) })] });
  assert.equal(rows[0].pinned, true);
});

// ── All three rails together ─────────────────────────────────────────────────

test('all three rails land in ONE band, oldest money first', () => {
  const rows = run({
    referrals: [connectRef(), brokerRef()], // 10d, 6d
    rancherOrders: [shopOrder()], // 9d
  });
  assert.deepEqual(ids(rows), ['recConnect', 'recOrder', 'recBroker']);
  assert.deepEqual(
    rows.map((r) => r.rail),
    ['connect', 'shop', 'broker'],
  );
  // Every row carries the three things the operator needs to act.
  for (const r of rows) {
    assert.ok(r.ageHours >= 0);
    assert.ok(r.nextAction.length > 0);
    assert.ok(['connect', 'broker', 'shop'].includes(r.rail));
  }
});

test('band is capped but always keeps the oldest rows', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    connectRef({ id: `rec${i}`, 'Deposit Paid At': daysAgo(i + 1) }),
  );
  const rows = run({ referrals: many, limit: 5 });
  assert.equal(rows.length, 5);
  assert.deepEqual(ids(rows), ['rec39', 'rec38', 'rec37', 'rec36', 'rec35']);
});
