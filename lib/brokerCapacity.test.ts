// BROKER RAIL × CAPACITY — the held-slot invariant, and the starvation bug.
//
// THE INVARIANT: the referrals countHeldReferrals counts are exactly the
// referrals that INCR'd. Every Connect path upheld it by construction —
// matching/suggest claims a slot immediately before flipping the row to
// 'Intro Sent', which is the only way a Connect referral enters the held set.
//
// The broker rail opened a SECOND door into that set and never claimed:
//   lib/brokerReferral creates Status='Pending'  (not held, correctly no INCR)
//   lib/brokerSettlement flips a PAID sale to 'Awaiting Payment'  (HELD)
//
// Invisible while represented ranches were unroutable — nothing read the
// counter. The moment one became real supply it is a starvation bug:
// incrementCapacity seeds a cold Redis key from liveHeldCountForRancher, so N
// settled broker sales inflate the seed by N with no matching claim. At the
// DEFAULT_MAX of 5, five paid sales bounce every subsequent buyer in that
// state off the capacity valve, and capacity-drift-check alarms forever.
//
// The fix is the exact mirror of the existing DECR gate: claim when the row
// ENTERS the held set. These tests pin both halves and their pairing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shouldIncrementOnEnterHeld, shouldDecrementOnClose } from './refundLifecycle';
import { HELD_REFERRAL_STATUSES, countHeldReferrals } from './capacityCount';
import { BROKER_MATCH_TYPE } from './brokerRail';

const RANCHER = 'recSELFSERVE0001';

function brokerRow(status: string, over: Record<string, any> = {}) {
  return {
    id: `rec${status.replace(/\s/g, '')}`,
    Status: status,
    'Match Type': BROKER_MATCH_TYPE,
    Rancher: [RANCHER],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The gate itself
// ---------------------------------------------------------------------------

test('shouldIncrementOnEnterHeld: a settled broker sale (Pending → Awaiting Payment) CLAIMS a slot', () => {
  assert.equal(shouldIncrementOnEnterHeld('Pending', 'Awaiting Payment'), true);
});

test('shouldIncrementOnEnterHeld: an ALREADY-held row does not claim twice', () => {
  // The routed case: matching created the referral, claimed a slot, and left it
  // at 'Intro Sent'. The buyer then pays. Claiming again would book two slots
  // for one buyer and halve the ranch's real capacity.
  for (const held of HELD_REFERRAL_STATUSES) {
    assert.equal(
      shouldIncrementOnEnterHeld(held, 'Awaiting Payment'),
      false,
      `${held} → Awaiting Payment double-claimed a slot`,
    );
  }
});

test('shouldIncrementOnEnterHeld: entering a NON-held status claims nothing', () => {
  for (const next of ['Pending', 'Pending Approval', 'Closed Won', 'Closed Lost', 'Refunded', 'Waitlisted']) {
    assert.equal(shouldIncrementOnEnterHeld('Pending', next), false, `claimed on → ${next}`);
  }
});

test('shouldIncrementOnEnterHeld: unknown/blank input never drifts the counter UP', () => {
  // Same conservative default as its mirror: a missed claim self-heals on the
  // next ground-truth reseed; a spurious one silently starves a rancher.
  assert.equal(shouldIncrementOnEnterHeld('', 'Awaiting Payment'), false);
  assert.equal(shouldIncrementOnEnterHeld(null, 'Awaiting Payment'), false);
  assert.equal(shouldIncrementOnEnterHeld(undefined, 'Awaiting Payment'), false);
  assert.equal(shouldIncrementOnEnterHeld('Pending', ''), false);
  assert.equal(shouldIncrementOnEnterHeld('Pending', null), false);
});

test('the INCR gate is the exact mirror of the DECR gate — no status can claim AND free', () => {
  const all = [
    ...HELD_REFERRAL_STATUSES,
    'Pending', 'Pending Approval', 'Closed Won', 'Closed Lost', 'Refunded', 'Waitlisted',
  ];
  for (const prev of all) {
    for (const next of all) {
      const inc = shouldIncrementOnEnterHeld(prev, next);
      const dec = shouldDecrementOnClose(prev, next);
      assert.ok(!(inc && dec), `${prev} → ${next} both claimed and freed a slot`);
      const prevHeld = HELD_REFERRAL_STATUSES.has(prev);
      const nextHeld = HELD_REFERRAL_STATUSES.has(next);
      assert.equal(inc, !prevHeld && nextHeld, `INCR wrong for ${prev} → ${next}`);
      assert.equal(dec, prevHeld && !nextHeld, `DECR wrong for ${prev} → ${next}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The starvation scenario, end to end
// ---------------------------------------------------------------------------

test('STARVATION: N paid broker sales are held — and each one is now backed by a claim', () => {
  // The count side is unchanged and correct: 'Awaiting Payment' IS a held slot
  // on every rail (fulfillment outstanding). The bug was never the counting —
  // it was that nothing claimed. Pin that each counted row corresponds to a
  // transition the gate says must claim.
  const paid = [1, 2, 3, 4, 5].map(() => brokerRow('Awaiting Payment'));
  paid.forEach((r, i) => { r.id = `recPAID${i}`; });
  assert.equal(countHeldReferrals(RANCHER, paid), 5);
  for (const _ of paid) {
    assert.equal(shouldIncrementOnEnterHeld('Pending', 'Awaiting Payment'), true);
  }
  // …and each frees on the real close, so the ranch is not starved forever.
  assert.equal(shouldDecrementOnClose('Awaiting Payment', 'Closed Won'), true);
  assert.equal(countHeldReferrals(RANCHER, paid.map((r) => ({ ...r, Status: 'Closed Won' }))), 0);
});

test('STARVATION: an UNPAID broker referral holds no slot (so a browsing buyer never starves the ranch)', () => {
  assert.equal(countHeldReferrals(RANCHER, [brokerRow('Pending')]), 0);
});

test('a routed broker referral claims ONCE across its whole life (route → pay → close)', () => {
  // Pending Approval → Intro Sent : matching's claim (existing behavior)
  assert.equal(shouldIncrementOnEnterHeld('Pending Approval', 'Intro Sent'), true);
  // Intro Sent → Awaiting Payment : the buyer pays. Already held, no 2nd claim.
  assert.equal(shouldIncrementOnEnterHeld('Intro Sent', 'Awaiting Payment'), false);
  // Awaiting Payment → Closed Won : the one release.
  assert.equal(shouldDecrementOnClose('Awaiting Payment', 'Closed Won'), true);
});

// ---------------------------------------------------------------------------
// WIRING PINS — settleBrokerDeposit is I/O-bound and cannot be unit-run, so
// pin the wiring a refactor could silently revert. Same technique as the
// settle pins in lib/brokerSettlement.test.ts.
// ---------------------------------------------------------------------------

const settleSrc = readFileSync(fileURLToPath(new URL('./brokerSettlement.ts', import.meta.url)), 'utf8');
const referralSrc = readFileSync(fileURLToPath(new URL('./brokerReferral.ts', import.meta.url)), 'utf8');

test('WIRING: settlement claims the slot through the shared gate, never a bare INCR', () => {
  assert.match(settleSrc, /import \{ shouldIncrementOnEnterHeld \} from '@\/lib\/refundLifecycle'/);
  assert.match(settleSrc, /shouldIncrementOnEnterHeld\(priorRef\?\.\['Status'\], 'Awaiting Payment'\)/);
  assert.match(settleSrc, /await incrementCapacity\(rancherId\)/);
});

test('WIRING: the claim happens BEFORE the status flip (or the Redis bootstrap double-counts)', () => {
  // incrementCapacity seeds a cold key from liveHeldCountForRancher. If the row
  // were already flipped into the held set, the bootstrap would count it AND
  // the increment would add one — one slot claimed twice.
  const claimIdx = settleSrc.indexOf('await incrementCapacity(rancherId)');
  const flipIdx = settleSrc.indexOf("'Status': 'Awaiting Payment',");
  assert.ok(claimIdx > -1 && flipIdx > -1);
  assert.ok(claimIdx < flipIdx, 'the capacity claim must precede the Awaiting Payment write');
});

test('WIRING: a failed status flip releases the slot it just claimed', () => {
  const catchIdx = settleSrc.indexOf('[broker settle] referral stamp failed:');
  assert.ok(catchIdx > -1);
  const tail = settleSrc.slice(catchIdx, catchIdx + 900);
  assert.match(tail, /if \(capacityClaimed\)/);
  assert.match(tail, /await decrementCapacity\(rancherId\)/);
});

test('WIRING: a capacity read failure never blocks settled money', () => {
  const claimBlock = settleSrc.slice(
    settleSrc.indexOf('let capacityClaimed = false;'),
    settleSrc.indexOf("'Status': 'Awaiting Payment',"),
  );
  assert.match(claimBlock, /catch \(e: any\) \{/);
  assert.match(claimBlock, /capacity claim skipped/);
});

test('WIRING: the referral mint still claims NOTHING (Pending is not a held slot)', () => {
  assert.doesNotMatch(referralSrc, /incrementCapacity/);
  assert.match(referralSrc, /Status: 'Pending'/);
});
