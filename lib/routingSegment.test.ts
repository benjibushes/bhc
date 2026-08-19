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

// ── TIMING LADDER promotion (preference-fidelity audit 2026-08-12) ──────────
// A declared "Within 30 days" was write-time-frozen: baked into Intent Score
// at signup, never read again, so a 30-day buyer without the R2B flag idled
// at NUDGE cadence while the window lapsed. classifyBuyer now reads the
// ladder at decision time.

test('TIMING: covered state + W30 + quiz stamp → MATCH_NOW without Ready to Buy', () => {
  const seg = classifyBuyer(
    buyer({ Timing: 'Within 30 days', 'Qualified At': '2026-08-01T00:00:00.000Z' }),
    [operationalRancher()],
  );
  assert.equal(seg, 'MATCH_NOW');
});

test('TIMING: covered state + W30 WITHOUT the quiz stamp → WARM_LEAD (never manufactures a row the 412 gate would bounce)', () => {
  const seg = classifyBuyer(buyer({ Timing: 'Within 30 days' }), [operationalRancher()]);
  assert.equal(seg, 'WARM_LEAD');
});

test('TIMING: singleSelect object shape is read like the string', () => {
  const seg = classifyBuyer(
    buyer({ Timing: { id: 'sel1', name: 'Within 30 days' }, 'Qualified At': '2026-08-01T00:00:00.000Z' }),
    [operationalRancher()],
  );
  assert.equal(seg, 'MATCH_NOW');
});

test('TIMING: weaker windows change nothing — W60 stays NUDGE_TO_ENGAGE', () => {
  const seg = classifyBuyer(buyer({ Timing: 'Within 60 days' }), [operationalRancher()]);
  assert.equal(seg, 'NUDGE_TO_ENGAGE');
});

test('TIMING: uncovered state + W30 stays STATE_WAITLIST (no intro to route)', () => {
  const seg = classifyBuyer(
    buyer({ State: 'FL', Timing: 'Within 30 days', 'Qualified At': '2026-08-01T00:00:00.000Z' }),
    [operationalRancher()],
  );
  assert.equal(seg, 'STATE_WAITLIST');
});

test('TIMING: terminal/suppression still outrank the promotion (MATCHED + W30 → TERMINAL)', () => {
  const seg = classifyBuyer(
    buyer({ 'Buyer Stage': 'MATCHED', Timing: 'Within 30 days', 'Qualified At': '2026-08-01T00:00:00.000Z' }),
    [operationalRancher()],
  );
  assert.equal(seg, 'TERMINAL');
});

// ── 4 · REQUEST-ONLY BELT on getServedStates (P0, 2026-08-18) ───────────────
//
// WHAT THIS PROTECTS. `getServedStates` is the shared answer to "does GENERIC
// supply exist in this state?" — every caller is a marketing/routing gate that
// hands an ordinary buyer to whatever rancher covers their state. Request-only
// specialty supply (lib/requestOnlyRanchers) is reachable ONLY by explicit
// buyer request, so it is not generic coverage and must contribute ZERO states
// here. It gated only on isRancherOperationalForBuyers, and the one
// request-only ranch carries `Admin Approved Multi-State` + 48 Routing States,
// so it inflated the served set to 48 states — the waiting-activation cron
// then told ~45 buyers/day that ranchers served their state when 15 states
// had real coverage. Both keys of the policy are pinned (slug AND rec id),
// and both directions (a normal rancher must still count).

// The seeded request-only ranch: operational, multi-state approved, 3 routing
// states — the exact shape that inflated the set in prod.
function requestOnlyMultiStateRancher(over: Record<string, unknown> = {}) {
  return operationalRancher({
    Slug: 'rep-provisions',
    'Admin Approved Multi-State': true,
    'Routing States': 'TX, FL, NY',
    State: 'TX',
    ...over,
  });
}

test('BELT: a request-only rancher contributes ZERO served states (slug key)', () => {
  assert.equal(getServedStates([requestOnlyMultiStateRancher()]).size, 0);
});

test('BELT: the rec-id key holds when the slug is renamed in Airtable', () => {
  const renamed = requestOnlyMultiStateRancher({ id: 'recYE5zpedhPg6KIV', Slug: 'renamed-in-airtable' });
  assert.equal(getServedStates([renamed]).size, 0);
});

test('BELT: both capacity variants exclude request-only supply', () => {
  const r = requestOnlyMultiStateRancher({ 'Current Active Referrals': 0, 'Max Active Referalls': 5 });
  assert.equal(getServedStates([r], { excludeAtCapacity: true }).size, 0);
  assert.equal(getCoveredStates([r]).size, 0);
});

test('BELT does NOT over-block: a normal rancher still counts, in both directions', () => {
  const normal = operationalRancher({ Slug: 'champion-valley', State: 'MT', id: 'recNormalRanch123' });
  assert.equal(getServedStates([normal]).has('MT'), true);
  assert.equal(getCoveredStates([normal]).has('MT'), true);
  // Multi-state routing still expands a NORMAL rancher's coverage.
  const normalMulti = operationalRancher({
    Slug: 'foodstead',
    'Admin Approved Multi-State': true,
    'Routing States': 'TX, FL',
    State: 'GA',
  });
  assert.deepEqual(
    Array.from(getServedStates([normalMulti])).sort(),
    ['FL', 'GA', 'TX'],
  );
});

test('BELT: request-only supply never widens a mixed pool beyond real coverage', () => {
  // Real coverage = MT (one normal ranch). The request-only ranch claims
  // TX/FL/NY on top; none of them may appear.
  const served = getServedStates([
    operationalRancher({ Slug: 'champion-valley', State: 'MT' }),
    requestOnlyMultiStateRancher(),
  ]);
  assert.deepEqual(Array.from(served), ['MT']);
});

test('BELT: a state whose ONLY cover is request-only reads as UNSERVED downstream', () => {
  // The buyer-visible consequence: TX has request-only supply and nothing
  // else, so a TX buyer is stranded (waitlist) rather than promised a match.
  const ranchers = [operationalRancher({ Slug: 'champion-valley', State: 'MT' }), requestOnlyMultiStateRancher()];
  assert.equal(classifyBuyer(buyer({ State: 'TX' }), ranchers), 'STATE_WAITLIST');
  // ...and an MT buyer is unaffected.
  assert.notEqual(classifyBuyer(buyer({ State: 'MT' }), ranchers), 'STATE_WAITLIST');
});
