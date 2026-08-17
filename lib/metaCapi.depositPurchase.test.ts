// DEPOSIT-LEVEL META CONVERSION (2026-07-04) — pins the pure decision surface
// for the deposit Purchase: the env gate, the distinct event_id scheme, and the
// close-vs-deposit dedup guard that makes a tier_v2 deposit deal count ONCE.
//
// These are the load-bearing predicates. Getting the dedup guard wrong either
// double-counts every deposit deal in Meta (deposit Purchase + close Purchase)
// or drops the conversion for legacy no-deposit closes — both corrupt the ROAS
// signal the ad algorithm optimizes on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  depositPurchaseEnabled,
  depositEventId,
  shouldFireClosePurchase,
} from './metaCapi';
import { BROKER_MATCH_TYPE, isBrokerRancher } from './brokerRail';
import { isBrokerReferralRow } from './commission';

// ── depositPurchaseEnabled: env-gated dark, mirrors closePurchaseEnabled ──
test('depositPurchaseEnabled is false unless META_DEPOSIT_PURCHASE_ENABLED === "true"', () => {
  const prev = process.env.META_DEPOSIT_PURCHASE_ENABLED;
  try {
    delete process.env.META_DEPOSIT_PURCHASE_ENABLED;
    assert.equal(depositPurchaseEnabled(), false);
    process.env.META_DEPOSIT_PURCHASE_ENABLED = 'false';
    assert.equal(depositPurchaseEnabled(), false);
    process.env.META_DEPOSIT_PURCHASE_ENABLED = '1';
    assert.equal(depositPurchaseEnabled(), false, 'only the exact string "true" enables it');
    process.env.META_DEPOSIT_PURCHASE_ENABLED = 'TRUE';
    assert.equal(depositPurchaseEnabled(), false, 'case-sensitive — "TRUE" does not enable');
    process.env.META_DEPOSIT_PURCHASE_ENABLED = 'true';
    assert.equal(depositPurchaseEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.META_DEPOSIT_PURCHASE_ENABLED;
    else process.env.META_DEPOSIT_PURCHASE_ENABLED = prev;
  }
});

// ── depositEventId: distinct from the raw referral id used by close/InitiateCheckout ──
test('depositEventId prefixes so it never collides with the Closed-Won Purchase event_id', () => {
  assert.equal(depositEventId('recABC123'), 'deposit_recABC123');
  // The Closed-Won Purchase + deposit InitiateCheckout use the RAW id
  // (metaEventId(id) === id). Same event_name='Purchase' with the same id would
  // let Meta's dedup window mask a double-count — so it MUST differ.
  assert.notEqual(depositEventId('recABC123'), 'recABC123');
});

// ── shouldFireClosePurchase: THE dedup guard (deposit vs close) ──
test('flag OFF → close Purchase always fires (no deposit Purchase exists to dedup against)', () => {
  assert.equal(
    shouldFireClosePurchase({ depositPurchaseEnabled: false, depositPaidAt: '2026-07-04T00:00:00Z' }),
    true,
    'even with a deposit stamp, a disabled deposit flag means nothing fired at deposit',
  );
  assert.equal(
    shouldFireClosePurchase({ depositPurchaseEnabled: false, depositPaidAt: null }),
    true,
  );
});

test('flag ON + deposit paid → SUPPRESS close Purchase (deposit already counted, count once)', () => {
  assert.equal(
    shouldFireClosePurchase({ depositPurchaseEnabled: true, depositPaidAt: '2026-07-04T00:00:00Z' }),
    false,
  );
});

test('flag ON + NO deposit (legacy close) → close Purchase still fires (its only conversion)', () => {
  assert.equal(
    shouldFireClosePurchase({ depositPurchaseEnabled: true, depositPaidAt: null }),
    true,
  );
  assert.equal(
    shouldFireClosePurchase({ depositPurchaseEnabled: true, depositPaidAt: undefined }),
    true,
  );
  assert.equal(
    shouldFireClosePurchase({ depositPurchaseEnabled: true, depositPaidAt: '   ' }),
    true,
    'a blank/whitespace stamp is not proof of a paid deposit',
  );
});

// ── BROKER RAIL: a Closed Won may NEVER emit a share-price Purchase ─────────
//
// The Closed-Won Purchase reports `Total Sale Amount` — the FULL share price.
// On the broker rail the buyer's card is only ever charged the deposit, and that
// deposit IS BHC's entire revenue (money model 3); the balance is paid to the
// ranch off-platform and never touches BHC or Stripe. Reporting the share price
// would overstate the conversion by ~4-5x and poison value-based bidding.
//
// The rail's one conversion already fires at deposit-paid (lib/brokerCapi), so
// the answer here is ALWAYS "fire nothing" — never "fire with the deposit
// value". The two Purchases carry DIFFERENT event_ids (`recX` vs `deposit_recX`,
// deliberately — see depositEventId), so Meta's dedup window would not collapse
// them and a corrected-value close would still double-count.

test('BROKER: suppressed in ALL FOUR flag combinations — env ORDER is not load-bearing', () => {
  for (const depositFlag of [false, true]) {
    for (const depositPaidAt of [null, '2026-08-17T00:00:00Z']) {
      assert.equal(
        shouldFireClosePurchase({ depositPurchaseEnabled: depositFlag, depositPaidAt, brokerRail: true }),
        false,
        `broker close must not fire (depositPurchaseEnabled=${depositFlag}, depositPaidAt=${depositPaidAt})`,
      );
    }
  }
});

test('BROKER: the reported failure — close flag ON, deposit flag unset, hand-closed (no deposit stamp)', () => {
  // This is the exact hole the PR #621 review found: shouldFireClosePurchase
  // short-circuited to `true` on the very first line when the deposit flag was
  // off, so Meta received a Purchase valued at the whole share price for a deal
  // that earned BHC only the deposit.
  assert.equal(
    shouldFireClosePurchase({
      depositPurchaseEnabled: false, // META_DEPOSIT_PURCHASE_ENABLED unset
      depositPaidAt: null,           // marked Closed Won by hand, link never paid
      brokerRail: true,
    }),
    false,
    'a $1,800 half with a $400 deposit must never report $1,800 to Meta',
  );
});

test('brokerRail is checked BEFORE the deposit guard — it is unconditional, not a tiebreak', () => {
  // Same inputs that make a NON-broker close fire; only the rail flips it.
  const base = { depositPurchaseEnabled: true, depositPaidAt: null };
  assert.equal(shouldFireClosePurchase(base), true);
  assert.equal(shouldFireClosePurchase({ ...base, brokerRail: true }), false);
});

test('absent/false brokerRail is byte-identical to before the parameter existed', () => {
  for (const rail of [undefined, false]) {
    assert.equal(
      shouldFireClosePurchase({ depositPurchaseEnabled: false, depositPaidAt: null, brokerRail: rail }),
      true,
    );
    assert.equal(
      shouldFireClosePurchase({ depositPurchaseEnabled: true, depositPaidAt: '2026-08-17T00:00:00Z', brokerRail: rail }),
      false,
      'the deposit dedup guard still owns the non-broker answer',
    );
  }
});

// ── The two signals that feed `brokerRail` (composed in lib/contracts/rancher
//    isBrokerRailClose). EITHER alone must suppress; only BOTH absent fires.
test('EITHER broker signal alone suppresses — Match Type OR the rancher checkbox', () => {
  const brokerReferral = { 'Match Type': BROKER_MATCH_TYPE, Rancher: ['recRanch'] };
  const plainReferral = { 'Match Type': 'Direct (Rancher Page) — Deposit', Rancher: ['recRanch'] };
  const brokerRancher = { 'Broker Rail': true };
  const connectRancher = { 'Stripe Connect Account Id': 'acct_123' };

  // 1) Label present, rancher checkbox stripped/unreadable → still suppressed.
  assert.equal(
    shouldFireClosePurchase({
      depositPurchaseEnabled: false,
      depositPaidAt: null,
      brokerRail: isBrokerReferralRow(brokerReferral) || isBrokerRancher(null),
    }),
    false,
  );
  // 2) Label stripped (typecast loss), rancher checkbox intact → still suppressed.
  assert.equal(
    shouldFireClosePurchase({
      depositPurchaseEnabled: false,
      depositPaidAt: null,
      brokerRail: isBrokerReferralRow(plainReferral) || isBrokerRancher(brokerRancher),
    }),
    false,
  );
  // 3) Neither signal → a real Connect/legacy close still fires as before.
  assert.equal(
    shouldFireClosePurchase({
      depositPurchaseEnabled: false,
      depositPaidAt: null,
      brokerRail: isBrokerReferralRow(plainReferral) || isBrokerRancher(connectRancher),
    }),
    true,
  );
});
