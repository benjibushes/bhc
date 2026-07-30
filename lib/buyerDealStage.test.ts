// lib/buyerDealStage.test.ts — the buyer-facing deal ladder.
//
// The load-bearing cases:
//   - exactly ONE step is `current` while the deal is live
//   - a later signal backfills every earlier step to `done` (Airtable stamps
//     arrive out of order all the time — a rancher can jump the tracker
//     straight to `ready` without ever having typed a Handoff Date)
//   - a pickup deal with no tracking number still reaches "ready" (the Wave 3
//     bug: the whole ladder used to hide behind ref.tracking_number)
//   - Closed Lost / Refunded never render a ladder

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUYER_DEAL_STEP_KEYS,
  buildBuyerDealLadder,
  currentStep,
  handoffWord,
  nextStepGuidance,
  resolveHandoffMode,
  shouldShowDealLadder,
  type BuyerDealFields,
} from './buyerDealStage';

const PAID: BuyerDealFields = {
  status: 'Awaiting Payment',
  depositPaidAt: '2026-07-01T10:00:00Z',
};

function keysWithState(fields: BuyerDealFields, state: 'done' | 'current' | 'upcoming') {
  return buildBuyerDealLadder(fields)
    .filter((s) => s.state === state)
    .map((s) => s.key);
}

// ── shape ───────────────────────────────────────────────────────────────────

test('ladder is the six ordered steps, always, in order', () => {
  const ladder = buildBuyerDealLadder(PAID);
  assert.deepEqual(ladder.map((s) => s.key), [...BUYER_DEAL_STEP_KEYS]);
  assert.deepEqual(BUYER_DEAL_STEP_KEYS, [
    'deposit',
    'accepted',
    'scheduled',
    'ready',
    'balance',
    'delivered',
  ]);
  for (const step of ladder) assert.ok(step.label.length > 0, `${step.key} needs a label`);
});

test('at most one step is current, and it is the first not-done step', () => {
  const cases: BuyerDealFields[] = [
    {},
    PAID,
    { ...PAID, rancherAcceptedAt: '2026-07-02T10:00:00Z' },
    { ...PAID, status: 'Slot Locked', handoffDate: '2026-08-14' },
    { ...PAID, status: 'Slot Locked', fulfillmentStatus: 'ready' },
    { ...PAID, status: 'Closed Won', fulfillmentConfirmedAt: '2026-08-20T00:00:00Z' },
  ];
  for (const fields of cases) {
    const ladder = buildBuyerDealLadder(fields);
    const currents = ladder.filter((s) => s.state === 'current');
    assert.ok(currents.length <= 1, `expected <=1 current, got ${currents.length}`);
    const firstNotDone = ladder.find((s) => s.state !== 'done');
    if (firstNotDone) assert.equal(firstNotDone.state, 'current');
    // Nothing after the current step may be done — the ladder is monotone.
    const currentIdx = ladder.findIndex((s) => s.state === 'current');
    if (currentIdx >= 0) {
      for (const later of ladder.slice(currentIdx + 1)) assert.equal(later.state, 'upcoming');
    }
  }
});

// ── progression ─────────────────────────────────────────────────────────────

test('nothing paid: deposit is current, everything else upcoming', () => {
  assert.deepEqual(keysWithState({ status: 'Intro Sent' }, 'done'), []);
  assert.equal(currentStep({ status: 'Intro Sent' })?.key, 'deposit');
});

test('deposit paid, rancher has not accepted: accepted is current', () => {
  assert.deepEqual(keysWithState(PAID, 'done'), ['deposit']);
  assert.equal(currentStep(PAID)?.key, 'accepted');
});

test('deposit-paid truth is the shared guard, not a bare status read', () => {
  // Requested-but-unpaid ('Awaiting Payment' + Deposit Requested At, no paid
  // stamp) is NOT paid — same disambiguator as lib/depositPaidState.
  const requested: BuyerDealFields = {
    status: 'Awaiting Payment',
    depositRequestedAt: '2026-07-01T09:00:00Z',
  };
  assert.equal(currentStep(requested)?.key, 'deposit');
  // Slot Locked implies the deposit landed even with the stamp missing.
  assert.deepEqual(keysWithState({ status: 'Slot Locked' }, 'done').includes('deposit'), true);
});

test('rancher accepted: scheduled is current', () => {
  const f = { ...PAID, rancherAcceptedAt: '2026-07-02T10:00:00Z', status: 'Slot Locked' };
  assert.deepEqual(keysWithState(f, 'done'), ['deposit', 'accepted']);
  assert.equal(currentStep(f)?.key, 'scheduled');
});

test('handoff date set: scheduled is done and carries the date as detail', () => {
  const f = { ...PAID, status: 'Slot Locked', rancherAcceptedAt: '2026-07-02T10:00:00Z', handoffDate: '2026-08-14' };
  const ladder = buildBuyerDealLadder(f);
  const scheduled = ladder.find((s) => s.key === 'scheduled')!;
  assert.equal(scheduled.state, 'done');
  assert.equal(scheduled.date, '2026-08-14');
  assert.equal(currentStep(f)?.key, 'ready');
});

test('PICKUP deal with no tracking number still reaches ready (Wave 3 bug)', () => {
  const f: BuyerDealFields = {
    ...PAID,
    status: 'Slot Locked',
    fulfillmentStatus: 'ready',
    fulfillmentMethod: 'pickup',
    // no trackingNumber anywhere — the ladder must not care
  };
  const ready = buildBuyerDealLadder(f).find((s) => s.key === 'ready')!;
  assert.equal(ready.state, 'done');
  assert.equal(currentStep(f)?.key, 'balance');
});

test('tracker at processing: ready is the current step', () => {
  const f = { ...PAID, status: 'Slot Locked', fulfillmentStatus: 'processing' };
  assert.equal(currentStep(f)?.key, 'ready');
});

test('a later signal backfills every earlier step (out-of-order stamps)', () => {
  // Rancher jumped straight to `fulfilled`: no accept stamp, no handoff date,
  // no final-invoice stamp. Every earlier step must still read done.
  const f: BuyerDealFields = { ...PAID, fulfillmentStatus: 'fulfilled' };
  const ladder = buildBuyerDealLadder(f);
  assert.deepEqual(ladder.map((s) => s.state), ['done', 'done', 'done', 'done', 'done', 'done']);
  assert.equal(currentStep(f), null);
});

test('final invoice sent but unpaid: balance is current and shows the amount', () => {
  const f: BuyerDealFields = {
    ...PAID,
    status: 'Awaiting Payment',
    rancherAcceptedAt: '2026-07-02T10:00:00Z',
    fulfillmentStatus: 'ready',
    finalInvoiceSentAt: '2026-08-01T10:00:00Z',
    finalInvoiceAmount: 1499.5,
  };
  const balance = buildBuyerDealLadder(f).find((s) => s.key === 'balance')!;
  assert.equal(balance.state, 'current');
  assert.match(String(balance.detail), /1,499\.50/);
});

test('final balance paid: balance done, delivered current', () => {
  const f: BuyerDealFields = {
    ...PAID,
    status: 'Awaiting Payment',
    finalPaidAt: '2026-08-05T10:00:00Z',
    fulfillmentStatus: 'ready',
  };
  assert.equal(buildBuyerDealLadder(f).find((s) => s.key === 'balance')!.state, 'done');
  assert.equal(currentStep(f)?.key, 'delivered');
});

test('fulfillment confirmed: whole ladder done, no current step', () => {
  const f: BuyerDealFields = {
    ...PAID,
    status: 'Closed Won',
    finalPaidAt: '2026-08-05T10:00:00Z',
    fulfillmentConfirmedAt: '2026-08-20T14:00:00Z',
  };
  const ladder = buildBuyerDealLadder(f);
  assert.ok(ladder.every((s) => s.state === 'done'));
  assert.equal(currentStep(f), null);
  assert.equal(ladder.find((s) => s.key === 'delivered')!.date, '2026-08-20T14:00:00Z');
});

test('Closed Won without a fulfillment stamp still closes the ladder', () => {
  // Closed Won is the platform's terminal "this deal completed" state and the
  // buyer card already says delivered — the stepper must not contradict the
  // badge sitting two inches above it.
  const f: BuyerDealFields = { ...PAID, status: 'Closed Won' };
  assert.ok(buildBuyerDealLadder(f).every((s) => s.state === 'done'));
});

// ── gating ──────────────────────────────────────────────────────────────────

test('ladder is shown only for a live, deposit-paid deal', () => {
  assert.equal(shouldShowDealLadder(PAID), true);
  assert.equal(shouldShowDealLadder({ ...PAID, status: 'Closed Won' }), true);
  // Pre-deposit there is no deal to track — the card shows the pay CTA instead.
  assert.equal(shouldShowDealLadder({ status: 'Intro Sent' }), false);
  assert.equal(shouldShowDealLadder({ status: 'Pending Approval' }), false);
  // Dead deals never render a progress ladder.
  assert.equal(shouldShowDealLadder({ ...PAID, status: 'Closed Lost' }), false);
  assert.equal(shouldShowDealLadder({ ...PAID, status: 'Refunded' }), false);
  assert.equal(shouldShowDealLadder(null), false);
});

// ── handoff wording (single source shared with the buyer handoff email) ─────

test('resolveHandoffMode: rancher method wins, buyer pref is the fallback', () => {
  assert.equal(resolveHandoffMode({ method: 'pickup', buyerPref: 'Delivery' }), 'pickup');
  assert.equal(resolveHandoffMode({ method: 'ship', buyerPref: 'Pickup' }), 'delivery');
  assert.equal(resolveHandoffMode({ method: '', buyerPref: 'Pickup' }), 'pickup');
  assert.equal(resolveHandoffMode({ method: '', buyerPref: 'Delivery' }), 'delivery');
  assert.equal(resolveHandoffMode({ method: '', buyerPref: '' }), null);
  assert.equal(resolveHandoffMode({}), null);
  // Case-insensitive on both inputs (Airtable singleSelect casing drifts).
  assert.equal(resolveHandoffMode({ method: 'PICKUP' }), 'pickup');
  assert.equal(resolveHandoffMode({ buyerPref: 'pickup' }), 'pickup');
});

test('handoffWord: the exact word the buyer handoff email uses', () => {
  assert.equal(handoffWord('pickup'), 'pickup');
  assert.equal(handoffWord('delivery'), 'delivery');
  assert.equal(handoffWord(null), 'handoff');
});

test('scheduled step wording follows the handoff mode', () => {
  const base = { ...PAID, status: 'Slot Locked', handoffDate: '2026-08-14' };
  const pickup = buildBuyerDealLadder({ ...base, fulfillmentMethod: 'pickup' })
    .find((s) => s.key === 'scheduled')!;
  assert.match(String(pickup.detail), /Pickup scheduled/i);
  const delivery = buildBuyerDealLadder({ ...base, fulfillmentMethod: 'ship' })
    .find((s) => s.key === 'scheduled')!;
  assert.match(String(delivery.detail), /Delivery scheduled/i);
  const generic = buildBuyerDealLadder(base).find((s) => s.key === 'scheduled')!;
  assert.match(String(generic.detail), /scheduled/i);
});

// ── "what happens next", driven by the current step ─────────────────────────

test('guidance is stage-aware and always names the rancher', () => {
  const waitingOnAccept = nextStepGuidance(PAID, { rancherName: 'Dana' });
  assert.ok(waitingOnAccept.length >= 2);
  assert.ok(waitingOnAccept.every((l) => l.when.length > 0 && l.text.length > 0));
  assert.ok(waitingOnAccept.some((l) => l.text.includes('Dana')));

  const scheduled = nextStepGuidance(
    { ...PAID, status: 'Slot Locked', rancherAcceptedAt: '2026-07-02T00:00:00Z' },
    { rancherName: 'Dana' },
  );
  assert.notDeepEqual(scheduled, waitingOnAccept);
});

test('guidance falls back to a neutral noun when the rancher name is missing', () => {
  for (const line of nextStepGuidance(PAID, {})) {
    assert.ok(!line.text.includes('undefined'));
    assert.ok(!/\s{2,}/.test(line.text), `double space in: ${line.text}`);
  }
});

test('a finished deal gets closing guidance, not "what happens next" theatre', () => {
  const done = nextStepGuidance(
    { ...PAID, status: 'Closed Won', fulfillmentConfirmedAt: '2026-08-20T00:00:00Z' },
    { rancherName: 'Dana' },
  );
  assert.equal(done.length, 1);
  assert.match(done[0].when, /done/i);
});
