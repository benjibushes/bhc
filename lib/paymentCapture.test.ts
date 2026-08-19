// lib/paymentCapture.test.ts
//
// Data-layer audit P0-1 (2026-08-18) — ONE rail-aware definition of "what was
// the buyer's card actually charged", shared by every reader.
//
// Run: JWT_SECRET=test-secret-ci npx tsx --test lib/paymentCapture.test.ts
// (or the full suite: npm test)
//
// THE BUG THESE PIN. recordBrokerDeposit writes the SAME number into both
// `Amount Cents` and `Platform Fee Cents` — on the broker rail the deposit IS
// the commission. lib/contracts/payments::capturedTotalCents knew that; the
// two READ surfaces did not, and each summed the fields:
//   • lib/obligations::collectedCents  — the operator's paid-customer band
//   • lib/depositSla::capturedCentsOf  — whose comment claimed it "mirrors
//     markDepositRefunded exactly" while doing the opposite on this rail
// A broker charge therefore read as 2x, so a refund of the WHOLE real charge
// measured as merely partial: isMoneyReturnedToBuyer stayed false, the
// obligation never cleared, outreach never paused, and the ranch's capacity
// slot stayed held forever.
//
// LIVE at the time of the fix: zero broker Payments rows exist and `Type` is
// empty on all 9 existing rows, so this path had NEVER run against real data —
// but two broker deposit invites were outstanding. It fires the first time one
// of them pays and then refunds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { capturedTotalCents, isBrokerPaymentRow } from './paymentCapture';
import { isMoneyReturnedToBuyer } from './depositSla';
import { selectObligations } from './obligations';
import { BROKER_PAYMENT_TYPE } from './brokerRail';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

/** What recordBrokerDeposit actually writes: the deposit in BOTH fields. */
const BROKER_ROW = {
  Type: BROKER_PAYMENT_TYPE,
  Status: 'succeeded',
  'Amount Cents': 40_000,
  'Platform Fee Cents': 40_000,
};

/** Connect: the fee is charged ON TOP, so the card total really is the sum. */
const CONNECT_ROW = {
  Status: 'succeeded',
  'Amount Cents': 40_000,
  'Platform Fee Cents': 4_000,
};

// ── The shared definition itself ─────────────────────────────────────────────

test('broker capture is the deposit, NOT deposit+fee', () => {
  assert.equal(capturedTotalCents(BROKER_ROW), 40_000);
});

test('connect capture is still the sum — the fee is charged on top', () => {
  assert.equal(capturedTotalCents(CONNECT_ROW), 44_000);
});

test('Total Charged Cents wins on both rails when settlement stamped it', () => {
  assert.equal(capturedTotalCents({ ...BROKER_ROW, 'Total Charged Cents': 40_000 }), 40_000);
  assert.equal(capturedTotalCents({ ...CONNECT_ROW, 'Total Charged Cents': 45_500 }), 45_500);
});

test('rail detection fails CLOSED — anything unreadable is Connect', () => {
  assert.equal(isBrokerPaymentRow({ Type: BROKER_PAYMENT_TYPE }), true);
  assert.equal(isBrokerPaymentRow({ Type: { name: BROKER_PAYMENT_TYPE } }), true);
  assert.equal(isBrokerPaymentRow({}), false);
  assert.equal(isBrokerPaymentRow(null), false);
  assert.equal(isBrokerPaymentRow({ Type: 'broker' }), false);
});

// ── READER 1 — lib/depositSla (drives isMoneyReturnedToBuyer) ────────────────

test('depositSla: a FULL broker refund reads as money returned', () => {
  // The Status flip is deliberately absent — this is the belt branch, where
  // the amounts have to answer the question. Doubling captured to 80,000 made
  // a complete $400 refund look partial, and the obligation never cleared.
  const ref = {
    id: 'recBrokerRefunded',
    __payment: { ...BROKER_ROW, 'Refunded At': daysAgo(1), 'Refunded Amount Cents': 40_000 },
  };
  assert.equal(isMoneyReturnedToBuyer(ref as any), true);
});

test('depositSla: a PARTIAL broker refund still leaves the money owed', () => {
  const ref = {
    id: 'recBrokerPartial',
    __payment: { ...BROKER_ROW, 'Refunded At': daysAgo(1), 'Refunded Amount Cents': 5_000 },
  };
  assert.equal(isMoneyReturnedToBuyer(ref as any), false);
});

test('depositSla: connect full/partial behaviour is unchanged', () => {
  const full = {
    __payment: { ...CONNECT_ROW, 'Refunded At': daysAgo(1), 'Refunded Amount Cents': 44_000 },
  };
  const partial = {
    __payment: { ...CONNECT_ROW, 'Refunded At': daysAgo(1), 'Refunded Amount Cents': 40_000 },
  };
  assert.equal(isMoneyReturnedToBuyer(full as any), true);
  assert.equal(
    isMoneyReturnedToBuyer(partial as any),
    false,
    'refunding the deposit but not the on-top fee is PARTIAL on Connect',
  );
});

// ── READER 2 — lib/obligations (the operator's paid-customer band) ───────────

const rancherById = new Map<string, any>([
  ['recRanchBroker', { id: 'recRanchBroker', 'Ranch Name': 'Broker Ranch', 'Broker Rail': true }],
  ['recRanchConnect', { id: 'recRanchConnect', 'Ranch Name': 'Connect Ranch' }],
]);

function brokerRef(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'recBroker',
    'Match Type': 'Broker — Deposit',
    'Deposit Paid At': daysAgo(6),
    'Intro Sent At': daysAgo(6),
    Status: 'Awaiting Payment',
    'Deposit Amount': 400,
    'Buyer Name': 'Buyer Two',
    'Buyer Email': 'two@example.com',
    Rancher: ['recRanchBroker'],
    ...overrides,
  };
}

test('obligations: a live broker deposit is banded at the deposit, not 2x', () => {
  const rows = selectObligations({
    referrals: [brokerRef()],
    rancherById,
    paymentByReferralId: new Map([['recBroker', BROKER_ROW]]),
    now: NOW,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rail, 'broker');
  assert.equal(rows[0].amountCents, 40_000, 'summing the two fields doubled the band');
});

test('obligations: a FULL broker refund ERASES the obligation', () => {
  // The whole point. Pre-fix this row stayed in the band forever: captured
  // read 80,000, the 40,000 refund looked partial, and nothing could retire it.
  const rows = selectObligations({
    referrals: [brokerRef()],
    rancherById,
    paymentByReferralId: new Map([
      ['recBroker', { ...BROKER_ROW, 'Refunded At': daysAgo(1), 'Refunded Amount Cents': 40_000 }],
    ]),
    now: NOW,
  });
  assert.deepEqual(rows, []);
});

test('obligations: a PARTIAL broker refund keeps the obligation standing', () => {
  const rows = selectObligations({
    referrals: [brokerRef()],
    rancherById,
    paymentByReferralId: new Map([
      ['recBroker', { ...BROKER_ROW, 'Refunded At': daysAgo(1), 'Refunded Amount Cents': 5_000 }],
    ]),
    now: NOW,
  });
  assert.equal(rows.length, 1, 'a partly-refunded customer is still owed beef');
});

test('obligations: connect banding is byte-identical to before', () => {
  const connectRef = {
    id: 'recConnect',
    'Deposit Paid At': daysAgo(10),
    'Rancher Accepted At': daysAgo(9),
    Status: 'Slot Locked',
    'Deposit Amount': 500,
    'Buyer Email': 'one@example.com',
    Rancher: ['recRanchConnect'],
  };
  // With a Payments row: deposit + the on-top fee.
  assert.equal(
    selectObligations({
      referrals: [connectRef],
      rancherById,
      paymentByReferralId: new Map([['recConnect', CONNECT_ROW]]),
      now: NOW,
    })[0].amountCents,
    44_000,
  );
  // Without one: the Referral's own Deposit Amount, in cents.
  assert.equal(
    selectObligations({ referrals: [connectRef], rancherById, now: NOW })[0].amountCents,
    50_000,
  );
  // An empty ledger row cannot answer — fall back rather than band at zero.
  assert.equal(
    selectObligations({
      referrals: [connectRef],
      rancherById,
      paymentByReferralId: new Map([['recConnect', { Status: 'succeeded' }]]),
      now: NOW,
    })[0].amountCents,
    50_000,
  );
});

// ── ONE definition, structurally ─────────────────────────────────────────────

const readSrc = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Source with comments removed — prose about the bug must not read as the bug. */
const codeOf = (rel: string) =>
  readSrc(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('no reader hand-rolls the sum any more', () => {
  for (const rel of ['./obligations.ts', './depositSla.ts']) {
    const code = codeOf(rel);
    assert.ok(
      !/'Platform Fee Cents'\s*\]/.test(code),
      `${rel} still reads Platform Fee Cents directly — the sum belongs to lib/paymentCapture alone`,
    );
    assert.match(
      code,
      /capturedTotalCents/,
      `${rel} must read the shared rail-aware definition`,
    );
  }
});

test('lib/paymentCapture stays hermetic so PURE readers can import it', () => {
  // The whole reason the definition could not be shared before: it lived in
  // lib/contracts/payments, which imports lib/airtable + lib/telegram. If this
  // module ever grows an I/O import the duplication comes straight back.
  const imports = [...readSrc('./paymentCapture.ts').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['./brokerRail']);
});
