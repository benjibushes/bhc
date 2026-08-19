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
import {
  MAX_LIFETIME_CHASES,
  CHASE_FIELDS,
  isFulfillmentTerminal,
  selectExhaustedChases,
  FULFILLMENT_TRACKING_EPOCH_MS,
} from './fulfillmentChase';

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

test('connect: dead statuses are NOT obligations', () => {
  const rows = run({
    referrals: [
      connectRef({ id: 'recL', Status: 'Closed Lost' }),
      connectRef({ id: 'recR', Status: 'Refunded' }),
      connectRef({ id: 'recC', Status: 'Cancelled' }),
      connectRef({ id: 'recC2', Status: 'Canceled' }),
      connectRef({ id: 'recE', Status: 'Expired' }),
    ],
  });
  assert.deepEqual(rows, []);
});

// ── B1: the P0 this whole PR exists to close, re-opened by one status value ──
//
// 'Closed Won' on the CONNECT rail means the buyer paid the BALANCE. It says
// nothing about beef: lib/fulfillmentConfirm stamps 'Fulfillment Confirmed At'
// on a completely separate event. Dropping these rows here while
// selectFulfillmentChase kept chasing them is what produced a row that took
// all 3 chases (including the loud tier-2 operator signal), hit the lifetime
// cap, and then appeared on NEITHER terminal surface — permanent silence on
// the one cohort that has already paid in full.

test('B1 connect: Closed Won with no fulfillment confirmation IS an obligation', () => {
  const rows = run({ referrals: [connectRef({ id: 'recW', Status: 'Closed Won' })] });
  assert.deepEqual(ids(rows), ['recW']);
});

test('B1 connect: Closed Won that IS confirmed is not an obligation', () => {
  // The other direction — 'Closed Won' alone must not become a free pass.
  const rows = run({
    referrals: [
      connectRef({ id: 'recW', Status: 'Closed Won', 'Fulfillment Confirmed At': daysAgo(2) }),
    ],
  });
  assert.deepEqual(rows, []);
});

test('B1 connect: a PRE-epoch Closed Won stays out (no legacy flood)', () => {
  // Before FULFILLMENT_TRACKING_EPOCH (#514, the un-gated tracker) a legacy
  // rancher had no route that could stamp a confirmation at all, so
  // "unconfirmed" is an artifact, not a waiting customer. Age-sorted, these
  // would outrank every live row and their pins would hijack `oneMove`.
  const beforeEpoch = new Date(FULFILLMENT_TRACKING_EPOCH_MS - 5 * DAY).toISOString();
  const rows = run({
    referrals: [
      connectRef({
        id: 'recLegacy',
        Status: 'Closed Won',
        'Deposit Paid At': beforeEpoch,
        'Closed At': beforeEpoch,
      }),
    ],
  });
  assert.deepEqual(rows, []);
});

test('B1 connect: a POST-epoch Closed At rescues an old deposit', () => {
  // Deposit predates the epoch but the deal closed after it — the machine
  // could have recorded delivery, so silence is real. 'Closed At' wins.
  const rows = run({
    referrals: [
      connectRef({
        id: 'recStraggler',
        Status: 'Closed Won',
        'Deposit Paid At': new Date(FULFILLMENT_TRACKING_EPOCH_MS - 30 * DAY).toISOString(),
        'Closed At': new Date(FULFILLMENT_TRACKING_EPOCH_MS + 2 * DAY).toISOString(),
      }),
    ],
  });
  assert.deepEqual(ids(rows), ['recStraggler']);
});

test('B1 broker: Closed Won IS terminal — the confirm and the close are one act', () => {
  // Rail-aware, and it stays correct after PR #650 lands: on broker,
  // adminFulfillmentCloseDecision stamps 'Fulfillment Confirmed At' AND
  // Status='Closed Won' in the same operation, so Closed Won means delivered.
  const rows = run({ referrals: [brokerRef({ id: 'recBW', Status: 'Closed Won' })] });
  assert.deepEqual(rows, []);
});

test('B1: the band and the chase lanes agree — chaseable implies visible', () => {
  // The invariant the shared predicate buys. A Connect Closed Won row that the
  // chase cron will still touch must never be invisible to the band, and the
  // exhaustion escalation must inherit it rather than drop it.
  const ref = connectRef({ id: 'recAgree', Status: 'Closed Won' });
  assert.equal(isFulfillmentTerminal(ref, { rail: 'connect' }), false);
  assert.deepEqual(ids(run({ referrals: [ref] })), ['recAgree']);

  const spent = {
    ...ref,
    [CHASE_FIELDS.count]: MAX_LIFETIME_CHASES,
    [CHASE_FIELDS.lastSentAt]: daysAgo(30),
  };
  assert.deepEqual(
    selectExhaustedChases([spent], { nowISO: new Date(NOW).toISOString() }).map((r) => r.referralId),
    ['recAgree'],
  );
});

// ── B3: a partial refund must not silently delete an obligation ─────────────
//
// markDepositRefunded stamps 'Refunded At' on EVERY refund and only sets
// Status='refunded' when the refund is FULL. Reading 'Refunded At' as "money
// gone" meant a $1 goodwill refund on a $750 deposit erased the whole
// obligation — and so did an open chargeback, which only means the buyer is
// contesting. Goes live the moment PR #650 lands (partial refunds on the rail
// where the deposit IS 100% of revenue).

test('B3: a FULL refund drops the obligation', () => {
  const paymentByReferralId = new Map<string, any>([
    // Authoritative: Status flips to 'refunded' only on a full refund.
    ['recFull', { 'Refunded At': daysAgo(1), Status: 'refunded' }],
    // Belt: no Status flip, but the amount covers everything charged.
    ['recFullByAmount', {
      'Refunded At': daysAgo(1),
      Status: 'succeeded',
      'Amount Cents': 50_000,
      'Platform Fee Cents': 5_000,
      'Total Charged Cents': 55_000,
      'Refunded Amount Cents': 55_000,
    }],
    ['recLive', { Status: 'succeeded' }],
  ]);
  const rows = run({
    referrals: [
      connectRef({ id: 'recFull' }),
      connectRef({ id: 'recFullByAmount' }),
      connectRef({ id: 'recLive' }),
    ],
    paymentByReferralId,
  });
  assert.deepEqual(ids(rows), ['recLive']);
});

test('B3: a PARTIAL refund leaves the obligation standing', () => {
  const paymentByReferralId = new Map<string, any>([
    // The shape markDepositRefunded actually writes on a partial refund.
    ['recPartial', {
      'Refunded At': daysAgo(1),
      Status: 'succeeded',
      'Amount Cents': 75_000,
      'Platform Fee Cents': 7_500,
      'Total Charged Cents': 82_500,
      'Refunded Amount Cents': 100,
    }],
    // Old schema: the amount fields were stripped, so only the stamp survives.
    // Without the Status flip that still means PARTIAL.
    ['recPartialNoAmounts', { 'Refunded At': daysAgo(1), Status: 'succeeded' }],
  ]);
  const rows = run({
    referrals: [connectRef({ id: 'recPartial' }), connectRef({ id: 'recPartialNoAmounts' })],
    paymentByReferralId,
  });
  assert.deepEqual(ids(rows).sort(), ['recPartial', 'recPartialNoAmounts']);
});

test('B3: an OPEN dispute keeps the obligation, a LOST one ends it', () => {
  const paymentByReferralId = new Map<string, any>([
    ['recOpen', { Status: 'succeeded', 'Dispute Status': 'needs_response' }],
    ['recReview', { Status: 'succeeded', 'Dispute Status': 'under_review' }],
    // We KEPT the money — so the beef is still owed.
    ['recWon', { Status: 'succeeded', 'Dispute Status': 'won' }],
    // Funds withdrawn for good.
    ['recLost', { Status: 'succeeded', 'Dispute Status': 'lost' }],
  ]);
  const rows = run({
    referrals: [
      connectRef({ id: 'recOpen' }),
      connectRef({ id: 'recReview' }),
      connectRef({ id: 'recWon' }),
      connectRef({ id: 'recLost' }),
    ],
    paymentByReferralId,
  });
  assert.deepEqual(ids(rows).sort(), ['recOpen', 'recReview', 'recWon']);
});

test('B3: the referral-side Refunded At stamp still drops it (always full)', () => {
  // refundReferralClearFields is only reached from restoreReferralAfterRefund,
  // which payments.ts calls only when isFullRefund.
  const rows = run({ referrals: [connectRef({ id: 'recRef', 'Refunded At': daysAgo(1) })] });
  assert.deepEqual(rows, []);
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

// ── B2: externally-fulfilled orders are not BHC obligations ─────────────────
//
// app/api/cron/product-fulfillment-sla deliberately filters
// `External Push Status !== 'pushed'`: a connector-pushed order is Shopify's /
// Printify's to fulfill, the store ships on its own SLA and the reverse
// webhook stamps Shipped. Omitting that filter here did not merely add noise —
// these rows PIN past the escalate window, and a pinned row hijacks the single
// `oneMove` slot on /admin/today with an order nobody at BHC is meant to touch.

test('B2 shop: a connector-pushed order is NOT an obligation', () => {
  const rows = run({
    rancherOrders: [shopOrder({ id: 'recPushed', 'External Push Status': 'pushed' })],
    shipDaysByProductId: new Map(),
  });
  assert.deepEqual(rows, []);
});

test('B2 shop: every other push state still counts (mirrors the cron exactly)', () => {
  // The cron keeps `!== 'pushed'`, so a failed/pending/absent push is BHC's
  // problem and must stay visible. Pinned to the same escalate-window row the
  // test below uses, so a pushed/unpushed pair differ only in that one field.
  const rows = run({
    rancherOrders: [
      shopOrder({ id: 'recFailed', 'External Push Status': 'failed' }),
      shopOrder({ id: 'recPending', 'External Push Status': 'pending' }),
      shopOrder({ id: 'recNone' }),
    ],
    shipDaysByProductId: new Map(),
  });
  assert.deepEqual(ids(rows).sort(), ['recFailed', 'recNone', 'recPending']);
});

// ── Rail-correct copy: a broker row must never be told to chase an "accept" ──

test('broker: the Payments rail signal keeps Connect copy off a broker row', () => {
  // Rancher record unreadable AND 'Match Type' drifted — the two signals the
  // old isBrokerRow had. Without the Payments Type='broker_deposit' signal this
  // row rendered "the ranch never accepted the slot" on a rail that HAS no
  // accept step, and pinned itself at 72h forever waiting for one.
  const rows = run({
    referrals: [brokerRef({ id: 'recBlind', 'Match Type': '', Rancher: ['recUnknown'] })],
    paymentByReferralId: new Map([['recBlind', { Type: 'broker_deposit', Status: 'succeeded' }]]),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rail, 'broker');
  assert.ok(!/accept/i.test(rows[0].nextAction), `Connect copy leaked: ${rows[0].nextAction}`);
});

// ── amountCents says "collected from the customer" and must mean it ──────────

test('amountCents prefers Total Charged Cents — the true charged total', () => {
  // Deliberately NOT equal to deposit + fee, so this pins the precedence and
  // cannot be satisfied by the fallback path.
  const rows = run({
    referrals: [connectRef({ id: 'recFee', 'Deposit Amount': 500 })],
    paymentByReferralId: new Map([
      ['recFee', {
        Status: 'succeeded',
        'Amount Cents': 50_000,
        'Platform Fee Cents': 5_000,
        'Total Charged Cents': 57_500,
      }],
    ]),
  });
  assert.equal(rows[0].amountCents, 57_500);
});

test('amountCents includes the on-top platform fee when there is no total', () => {
  // Money model #1: the rancher keeps 100% of the price and BHC's 10% is added
  // ON TOP of the buyer's deposit. 'Deposit Amount' alone understates the
  // charge by exactly the fee, under a label that says "collected". Rows that
  // predate 'Total Charged Cents' must still add it.
  const rows = run({
    referrals: [connectRef({ id: 'recOld', 'Deposit Amount': 500 })],
    paymentByReferralId: new Map([
      ['recOld', { Status: 'succeeded', 'Amount Cents': 50_000, 'Platform Fee Cents': 5_000 }],
    ]),
  });
  assert.equal(rows[0].amountCents, 55_000);
});

test('amountCents falls back to the deposit when there is no Payments row', () => {
  const rows = run({ referrals: [connectRef({ id: 'recNoPay', 'Deposit Amount': 500 })] });
  assert.equal(rows[0].amountCents, 50_000);
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
