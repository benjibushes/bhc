// P1′ lane projection tests (MARKETING-REVAMP-2026-08, Track 1).
//
// Pins three things:
//   1. The INCOMPLETE_PROFILE ordering fix — state coverage is evaluated
//      BEFORE profile completeness, so a stranded buyer (known, unserved
//      state) classifies STATE_WAITLIST and never gets profile-ask emails
//      for a product they cannot buy (the 179/wk waste).
//   2. laneForSegment — the pure 3-way projection of every routing segment
//      onto the lane architecture (share-ready / national / customer).
//   3. getServedStates — the ONE shared served-states helper. Default is
//      capacity-OUT (at-capacity ranchers still count as coverage, and the
//      'Max Active Referalls' field — single-L Airtable typo — is never
//      read); the explicit { excludeAtCapacity: true } flag preserves the
//      legacy capacity-IN semantics of getCoveredStates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBuyer,
  laneForSegment,
  getServedStates,
  getCoveredStates,
  type RoutingSegment,
} from './routingSegment';

// A fully-operational rancher serving MT — passes every eligibility gate.
function operationalRancher(over: Record<string, unknown> = {}) {
  return {
    'Active Status': 'Active',
    'Onboarding Status': 'Live',
    'Agreement Signed': true,
    'Subscription Status': 'active',
    'Pricing Model': 'legacy',
    State: 'MT',
    ...over,
  };
}

// A qualified buyer baseline — complete profile, mid budget, MT.
function buyer(over: Record<string, unknown> = {}) {
  return {
    'Buyer Stage': 'READY',
    'Order Type': 'Half',
    Budget: '$1000-$2000',
    State: 'MT',
    ...over,
  };
}

// ── 1 · INCOMPLETE_PROFILE ordering fix ─────────────────────────────────────

test('ORDERING FIX: unserved state + incomplete profile → STATE_WAITLIST, not INCOMPLETE_PROFILE', () => {
  // Rancher pool serves MT only; the buyer is in FL with no Order Type.
  // Before the fix this returned INCOMPLETE_PROFILE — profile-ask emails to
  // a buyer who cannot buy at any price. State coverage must win.
  const seg = classifyBuyer(
    buyer({ State: 'FL', 'Order Type': '', Budget: '' }),
    [operationalRancher()],
  );
  assert.equal(seg, 'STATE_WAITLIST');
});

test('ORDERING FIX: unserved state + missing budget only → STATE_WAITLIST', () => {
  const seg = classifyBuyer(
    buyer({ State: 'FL', Budget: 'Unsure' }),
    [operationalRancher()],
  );
  assert.equal(seg, 'STATE_WAITLIST');
});

test('served state + incomplete profile still → INCOMPLETE_PROFILE (profile ask is lane-appropriate)', () => {
  const seg = classifyBuyer(
    buyer({ 'Order Type': 'Not Sure' }),
    [operationalRancher()],
  );
  assert.equal(seg, 'INCOMPLETE_PROFILE');
});

test('NO state + incomplete profile → INCOMPLETE_PROFILE (unknown state is not stranded; the ask collects it)', () => {
  const seg = classifyBuyer(
    buyer({ State: '', 'Order Type': '' }),
    [operationalRancher()],
  );
  assert.equal(seg, 'INCOMPLETE_PROFILE');
});

test('at-capacity-only state + incomplete profile → INCOMPLETE_PROFILE (stranded check is capacity-OUT — no lane-flap when a rancher fills)', () => {
  const full = operationalRancher({
    'Current Active Referrals': 5,
    'Max Active Referalls': 5, // sic — Airtable field typo, single L
  });
  const seg = classifyBuyer(buyer({ 'Order Type': '' }), [full]);
  assert.equal(seg, 'INCOMPLETE_PROFILE');
});

test('terminal stages still outrank the stranded check (CLOSED in unserved state → TERMINAL)', () => {
  const seg = classifyBuyer(
    buyer({ State: 'FL', 'Order Type': '', 'Buyer Stage': 'CLOSED' }),
    [operationalRancher()],
  );
  assert.equal(seg, 'TERMINAL');
});

test('suppression still outranks the stranded check (Unsubscribed in unserved state → UNQUALIFIED_NURTURE)', () => {
  const seg = classifyBuyer(
    buyer({ State: 'FL', 'Order Type': '', Unsubscribed: true }),
    [operationalRancher()],
  );
  assert.equal(seg, 'UNQUALIFIED_NURTURE');
});

test('budget-driven segments preserved for complete profiles in unserved states', () => {
  // Founder pitch is budget-driven, not state-driven ("works in any state").
  const pitch = classifyBuyer(
    buyer({ State: 'FL', Budget: '<$500' }),
    [operationalRancher()],
  );
  assert.equal(pitch, 'NO_BUDGET_FOUNDER_PITCH');
  const explore = classifyBuyer(
    buyer({ State: 'FL', Budget: 'Just exploring' }),
    [operationalRancher()],
  );
  assert.equal(explore, 'COMMUNITY_NURTURE');
});

// ── funnel behavior preserved (capacity-IN for MATCH_NOW routing) ───────────

test('covered state + Ready to Buy → MATCH_NOW', () => {
  const seg = classifyBuyer(
    buyer({ 'Ready to Buy': true }),
    [operationalRancher()],
  );
  assert.equal(seg, 'MATCH_NOW');
});

test('all ranchers at capacity: complete-profile buyer stays STATE_WAITLIST (funnel keeps capacity-IN — never route intros at a full rancher)', () => {
  const full = operationalRancher({
    'Current Active Referrals': 5,
    'Max Active Referalls': 5,
  });
  const seg = classifyBuyer(buyer({ 'Ready to Buy': true }), [full]);
  assert.equal(seg, 'STATE_WAITLIST');
});

// ── 2 · laneForSegment — every segment value, plus fallback ─────────────────

test('laneForSegment maps every segment 3-way', () => {
  const expected: Record<RoutingSegment, ReturnType<typeof laneForSegment>> = {
    TERMINAL: 'customer',
    MATCH_NOW: 'share-ready',
    WARM_LEAD: 'share-ready',
    NUDGE_TO_ENGAGE: 'share-ready',
    INCOMPLETE_PROFILE: 'share-ready',
    STATE_WAITLIST: 'national',
    NO_BUDGET_FOUNDER_PITCH: 'national',
    COMMUNITY_NURTURE: 'national',
    UNQUALIFIED_NURTURE: 'national',
  };
  for (const [seg, lane] of Object.entries(expected)) {
    assert.equal(laneForSegment(seg), lane, `laneForSegment(${seg})`);
  }
});

test('laneForSegment fails safe: unknown or empty segment → national (lowest-pressure lane)', () => {
  assert.equal(laneForSegment(''), 'national');
  assert.equal(laneForSegment('SOMETHING_NEW'), 'national');
  assert.equal(laneForSegment('match_now'), 'national'); // case-sensitive: stored values are exact
});

// ── 3 · getServedStates — the ONE shared helper ─────────────────────────────

test('default (capacity-OUT): at-capacity ranchers STILL count as coverage', () => {
  const full = operationalRancher({
    'Current Active Referrals': 9,
    'Max Active Referalls': 5,
  });
  const served = getServedStates([full]);
  assert.deepEqual(Array.from(served), ['MT']);
});

test('default path NEVER reads the "Max Active Referalls" typo field', () => {
  // A poisoned getter proves the capacity-OUT path cannot touch the field.
  const r = operationalRancher();
  Object.defineProperty(r, 'Max Active Referalls', {
    get() {
      throw new Error('capacity-OUT path must not read Max Active Referalls');
    },
  });
  Object.defineProperty(r, 'Current Active Referrals', {
    get() {
      throw new Error('capacity-OUT path must not read Current Active Referrals');
    },
  });
  const served = getServedStates([r]);
  assert.equal(served.has('MT'), true);
});

test('excludeAtCapacity: true drops at-capacity ranchers (legacy capacity-IN semantics)', () => {
  const full = operationalRancher({
    'Current Active Referrals': 5,
    'Max Active Referalls': 5,
  });
  assert.equal(getServedStates([full], { excludeAtCapacity: true }).size, 0);
  // max=0 / unset means uncapped — still counts.
  const uncapped = operationalRancher({ 'Current Active Referrals': 50 });
  assert.equal(
    getServedStates([uncapped], { excludeAtCapacity: true }).has('MT'),
    true,
  );
});

test('coverage is a union: one full + one open rancher in the same state → covered under both definitions', () => {
  const full = operationalRancher({
    'Current Active Referrals': 5,
    'Max Active Referalls': 5,
  });
  const open = operationalRancher({
    'Current Active Referrals': 1,
    'Max Active Referalls': 5,
  });
  assert.equal(getServedStates([full, open]).has('MT'), true);
  assert.equal(
    getServedStates([full, open], { excludeAtCapacity: true }).has('MT'),
    true,
  );
});

test('non-operational ranchers never count as coverage', () => {
  const paused = operationalRancher({ 'Active Status': 'Paused' });
  const unsigned = operationalRancher({ 'Agreement Signed': false });
  assert.equal(getServedStates([paused, unsigned]).size, 0);
});

test('getCoveredStates back-compat wrapper keeps capacity-IN semantics', () => {
  const full = operationalRancher({
    'Current Active Referrals': 5,
    'Max Active Referalls': 5,
  });
  assert.equal(getCoveredStates([full]).size, 0);
  const open = operationalRancher();
  assert.equal(getCoveredStates([open]).has('MT'), true);
});
