// /map PIN BUCKETING (lib/mapPinStatus) — pins the #630 blocking fix: a
// REPRESENTED ranch (Broker Rail + `Broker Self Serve`) has EMPTY Verification
// Status, Onboarding Status, and Self-Submitted At (it never ran the wizard
// and never signed anything), and the pre-carve-out bucketing fell through to
// 'prospect' — painting a deposit-ready, routable ranch as "○ On our radar
// (unclaimed)" on the map, with no price and no list entry.
//
// Three directions, per the Wave A doctrine:
//   • self-serve broker  → 'represented' (in-network, deposits open);
//   • token-only broker  → NEVER 'represented' (and absent from the map
//     entirely — mapPinsFormula's carve-out excludes it at fetch time);
//   • Connect-rail rows  → same bucketing as the original inline logic
//     (Live/Verified → the terminal bucket, stages → onboarding, etc.).
//
// SECOND WAVE (2026-08-18, /map truth): the terminal bucket used to be NAMED
// 'verified' and every surface that read it printed the word "verified" — over
// a bucket that is mostly `Onboarding Status = Live` rows carrying no
// verification verdict at all. The bucket is now 'live' (what the field
// actually says) and the WORD comes from isVerifiedRancher, the same strict
// `Verification Status = 'Verified'` predicate the rancher page uses. The
// counts below pin the other half: nothing may claim shipping without
// Fulfillment Types, and nothing may claim reservations without a deposit rail.
//
// Synthetic ranch names only — the repo is PUBLIC.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  derivePinStatus,
  deriveMapStats,
  isPinDepositReady,
  isVerifiedRancher,
  shipsColdChain,
  ONBOARDING_STAGES,
  type MapStatsInput,
} from './mapPinStatus';
import { mapPinsFormula } from './airtable';
import { statusMatches } from '../app/map/components/StatusFilter';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/**
 * The file with its COMMENTS stripped — block comments (incl. the `{/* … *\/}`
 * JSX form) and whole-line `//` comments. The truth pins below assert about
 * copy a buyer can read and code that runs; the removed claims are quoted
 * verbatim in the comments that explain why they went, and a pin that can't
 * tell those apart would forbid documenting its own fix. Mid-line `//` is left
 * alone so URLs inside string literals survive.
 */
const code = (p: string) =>
  src(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

const MAP_SOURCES = [
  'app/map/page.tsx',
  'app/map/components/DiscoverMap.tsx',
  'app/map/components/DiscoverMapClient.tsx',
  'app/map/components/MapLegend.tsx',
  'app/map/components/RancherList.tsx',
  'app/map/components/StatusFilter.tsx',
];

/**
 * A represented ranch exactly as one really exists (Gila-shaped): opted in,
 * publicly resolvable, priced cuts with explicit deposits — and NONE of the
 * wizard paperwork: no Verification Status, no Onboarding Status, no
 * Self-Submitted At, no Pricing Model, no Stripe anything.
 */
function selfServeBrokerRanch(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'recSELFSERVE0001',
    'Ranch Name': 'Dry Wash Cattle',
    State: 'AZ',
    Slug: 'dry-wash-cattle',
    'Broker Rail': true,
    'Broker Self Serve': true,
    'Quarter Price': 1100,
    'Quarter Deposit': 250,
    'Half Price': 2100,
    'Half Deposit': 450,
    'Whole Price': 4000,
    'Whole Deposit': 850,
    ...over,
  };
}

/** The same ranch WITHOUT the opt-in: phone-only token rail, invisible. */
function tokenOnlyBrokerRanch(over: Record<string, any> = {}): Record<string, any> {
  const r = selfServeBrokerRanch(over);
  delete (r as any)['Broker Self Serve'];
  return r;
}

/** A minimal already-derived pin, for the stats/copy layer. */
function statPin(over: Partial<MapStatsInput> = {}): MapStatsInput {
  return {
    status: 'live',
    state: 'TX',
    verified: false,
    depositReady: false,
    shipsColdChain: false,
    requestOnly: false,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// derivePinStatus — the bucketing itself
// ─────────────────────────────────────────────────────────────────────────────

test('self-serve broker ranch with ALL pipeline fields empty ⇒ represented, never prospect (the #630 bug)', () => {
  const r = selfServeBrokerRanch();
  assert.equal(r['Verification Status'], undefined, 'fixture: no Verification Status');
  assert.equal(r['Onboarding Status'], undefined, 'fixture: no Onboarding Status');
  assert.equal(r['Self-Submitted At'], undefined, 'fixture: no Self-Submitted At');
  assert.deepEqual(derivePinStatus(r), { status: 'represented', stageLabel: '' });
});

test('token-only broker ranch is NEVER represented — falls to prospect (defense in depth behind the formula)', () => {
  // The fetch-time truth is the carve-out: a token-only ranch never reaches
  // derivePinStatus at all (exact formula pinned in
  // lib/brokerDiscoverySurfaces.test.ts). If that ever regressed, the
  // bucketing must still fail CLOSED — an unlabeled dot, not a public
  // "represented · deposits open" claim for a phone-only ranch.
  assert.equal(derivePinStatus(tokenOnlyBrokerRanch()).status, 'prospect');
  assert.ok(
    mapPinsFormula().includes('OR(NOT({Broker Rail} = 1), {Broker Self Serve} = 1)'),
    'mapPinsFormula must keep excluding token-only broker rows at fetch time',
  );
});

test('a stray Broker Self Serve tick on a NON-broker rancher relaxes nothing (isBrokerSelfServe fails closed)', () => {
  const r = selfServeBrokerRanch();
  delete (r as any)['Broker Rail'];
  assert.equal(derivePinStatus(r).status, 'prospect');
});

test('live outranks represented: a ranch that graduated to Live reads as the more-progressed thing', () => {
  assert.equal(
    derivePinStatus(selfServeBrokerRanch({ 'Onboarding Status': 'Live' })).status,
    'live',
  );
});

test('represented outranks the pipeline buckets: stray stage/self-submit data does not demote a deposit-ready ranch', () => {
  assert.equal(
    derivePinStatus(selfServeBrokerRanch({ 'Onboarding Status': 'Call Scheduled' })).status,
    'represented',
  );
  assert.equal(
    derivePinStatus(selfServeBrokerRanch({ 'Self-Submitted At': '2026-08-01' })).status,
    'represented',
  );
});

test('Connect-rail bucketing is unchanged in MEMBERSHIP: Live/Verified ⇒ the terminal bucket', () => {
  assert.deepEqual(derivePinStatus({ 'Onboarding Status': 'Live' }), {
    status: 'live',
    stageLabel: '',
  });
  assert.deepEqual(derivePinStatus({ 'Verification Status': 'Verified' }), {
    status: 'live',
    stageLabel: '',
  });
});

test('Connect-rail bucketing is unchanged: every stage ⇒ onboarding with its stageLabel', () => {
  for (const stage of ONBOARDING_STAGES) {
    assert.deepEqual(derivePinStatus({ 'Onboarding Status': stage }), {
      status: 'onboarding',
      stageLabel: stage,
    });
  }
});

test('Connect-rail bucketing is unchanged: self-submitted and cold prospect', () => {
  assert.equal(derivePinStatus({ 'Self-Submitted At': '2026-07-01' }).status, 'self-submitted');
  assert.equal(derivePinStatus({}).status, 'prospect');
  assert.equal(derivePinStatus({ 'Onboarding Status': 'Nonsense Stage' }).status, 'prospect');
});

// ─────────────────────────────────────────────────────────────────────────────
// isVerifiedRancher — the WORD "verified", and only where it is earned
//
// THE BUG (live until 2026-08-18): the terminal bucket was named 'verified'
// and four surfaces printed that word straight off the bucket — the legend
// sentence, the legend row, the SSR list badge, and the pin card. On the live
// map that bucket held 13 ranches and only 6 carried a `Verification Status =
// 'Verified'` stamp: seven ranches were publicly called verified by a surface
// that had never read the verification field. This is the same defect PR #647
// removed from the ranchers' own pages, one surface over.
// ─────────────────────────────────────────────────────────────────────────────

test('isVerifiedRancher: ONLY the Verification Status stamp earns the word', () => {
  assert.equal(isVerifiedRancher({ 'Verification Status': 'Verified' }), true);
  // Onboarding = Live is a PIPELINE state, not a verification verdict. These
  // are the seven live-but-unstamped ranches on the map today.
  assert.equal(isVerifiedRancher({ 'Onboarding Status': 'Live' }), false);
  assert.equal(
    isVerifiedRancher({ 'Onboarding Status': 'Live', 'Verification Status': 'Not Started' }),
    false,
  );
  assert.equal(isVerifiedRancher({ 'Verification Status': '' }), false);
  assert.equal(isVerifiedRancher({}), false);
  // Airtable single-selects sometimes arrive as { name } — same shape handling
  // as the rancher page's pill.
  assert.equal(isVerifiedRancher({ 'Verification Status': { name: 'Verified' } }), true);
  // Never fuzzy: only the exact verdict counts.
  assert.equal(isVerifiedRancher({ 'Verification Status': 'Verification Complete' }), false);
});

test('a REPRESENTED ranch is never verified — no field combination buys it the word (#636 ruling)', () => {
  const r = selfServeBrokerRanch();
  assert.equal(derivePinStatus(r).status, 'represented');
  assert.equal(isVerifiedRancher(r), false);
  // Even a stray Live stamp that promotes it into the terminal bucket only
  // moves the BUCKET. The word still comes from the verification field.
  const graduated = selfServeBrokerRanch({ 'Onboarding Status': 'Live' });
  assert.equal(derivePinStatus(graduated).status, 'live');
  assert.equal(isVerifiedRancher(graduated), false);
  // And a token-only broker row (never on the map at all) likewise.
  assert.equal(isVerifiedRancher(tokenOnlyBrokerRanch()), false);
});

test('the pin-status union has no "verified" member — the bucket CANNOT print the word', () => {
  assert.ok(
    !/'verified'/.test(code('lib/mapPinStatus.ts')),
    "no 'verified' status literal may survive in the bucketing — that name is what made four surfaces overclaim",
  );
  for (const f of MAP_SOURCES) {
    assert.ok(
      !/status === 'verified'/.test(code(f)),
      `${f} must not branch on a 'verified' pin bucket`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// shipsColdChain — "shipping" is a fulfillment capability, never a bucket
// ─────────────────────────────────────────────────────────────────────────────

test('shipsColdChain derives from Fulfillment Types — never assumed, never defaulted', () => {
  assert.equal(shipsColdChain({ 'Fulfillment Types': ['Cold-Chain Shipping', 'Local Pickup'] }), true);
  assert.equal(shipsColdChain({ 'Fulfillment Types': ['Local Pickup', 'Local Delivery'] }), false);
  assert.equal(shipsColdChain({ 'Fulfillment Types': [] }), false);
  // A BLANK field is not a shipper. Half the live ranches have no Fulfillment
  // Types at all — fail closed, never invent the capability.
  assert.equal(shipsColdChain({}), false);
  assert.equal(shipsColdChain({ 'Onboarding Status': 'Live' }), false);
  // Legacy [{name}] rows, and a non-array value, both handled.
  assert.equal(shipsColdChain({ 'Fulfillment Types': [{ name: 'Cold-Chain Shipping' }] }), true);
  assert.equal(shipsColdChain({ 'Fulfillment Types': 'Cold-Chain Shipping' }), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveMapStats — every public number on /map, derived from its own field
// ─────────────────────────────────────────────────────────────────────────────

test('deriveMapStats: the shipping count comes from fulfillment capability, NOT the pin bucket', () => {
  const pins = [
    statPin({ status: 'live', shipsColdChain: true }),
    statPin({ status: 'live' }),
    statPin({ status: 'live' }),
    statPin({ status: 'represented' }),
  ];
  const s = deriveMapStats(pins);
  assert.equal(s.live + s.represented, 4, 'four ranches are in the green bucket');
  assert.equal(
    s.coldChainShippers,
    1,
    'the old headline called all four of these "ranchers shipping beef today"',
  );
});

test('deriveMapStats: request-only supply never counts toward a public shipping claim', () => {
  const pins = [
    statPin({ status: 'live', shipsColdChain: true }),
    statPin({ status: 'live', shipsColdChain: true, requestOnly: true }),
  ];
  assert.equal(deriveMapStats(pins).coldChainShippers, 1);
});

test('deriveMapStats: a stray shipping type on a non-green pin claims nothing', () => {
  const pins = [
    statPin({ status: 'onboarding', shipsColdChain: true }),
    statPin({ status: 'self-submitted', shipsColdChain: true }),
    statPin({ status: 'prospect', shipsColdChain: true }),
  ];
  assert.equal(deriveMapStats(pins).coldChainShippers, 0);
});

test('deriveMapStats: "taking reservations" counts only pins whose page renders a deposit form', () => {
  const pins = [
    statPin({ status: 'live', depositReady: true }),
    statPin({ status: 'live', depositReady: false }),
    statPin({ status: 'represented', depositReady: true }),
    statPin({ status: 'onboarding', depositReady: true }),
  ];
  const s = deriveMapStats(pins);
  assert.equal(s.live + s.represented, 3, 'three green pins');
  assert.equal(s.reservable, 2, 'only the two green pins with a real deposit rail');
});

test('deriveMapStats: verifiedPartners counts the stamp, never the bucket', () => {
  const pins = [
    statPin({ status: 'live', verified: true }),
    statPin({ status: 'live' }),
    statPin({ status: 'live' }),
    statPin({ status: 'represented' }),
  ];
  const s = deriveMapStats(pins);
  assert.equal(s.live, 3);
  assert.equal(s.verifiedPartners, 1);
});

test('deriveMapStats: pipeline + geography counts are unchanged', () => {
  const pins = [
    statPin({ status: 'live', state: 'TX' }),
    statPin({ status: 'onboarding', state: 'TX' }),
    statPin({ status: 'onboarding', state: 'OK' }),
    statPin({ status: 'self-submitted', state: 'NE' }),
    statPin({ status: 'prospect', state: '' }),
  ];
  const s = deriveMapStats(pins);
  assert.equal(s.onboarding, 2);
  assert.equal(s.selfSubmitted, 1);
  assert.equal(s.prospects, 1);
  assert.equal(s.statesCovered, 3, 'blank states are not a state');
});

// ─────────────────────────────────────────────────────────────────────────────
// isPinDepositReady — the Reserve-CTA gate, both rails
// ─────────────────────────────────────────────────────────────────────────────

test('depositReady: routable self-serve broker ranch ⇒ true (broker checkout will take the money)', () => {
  assert.equal(isPinDepositReady(selfServeBrokerRanch()), true);
});

test('depositReady: self-serve ranch with NO eligible cut ⇒ false (card must fall back to "View ranch")', () => {
  // Deposits are never derived on the broker rail — unpriced deposits mean no
  // cut passes assertBrokerEligible, so the reserve page renders no form.
  const r = selfServeBrokerRanch({
    'Quarter Deposit': undefined,
    'Half Deposit': undefined,
    'Whole Deposit': undefined,
  });
  assert.equal(isPinDepositReady(r), false);
});

test('depositReady: Connect rail unchanged — tier_v2 + active ⇒ true, anything less ⇒ false', () => {
  assert.equal(
    isPinDepositReady({ 'Pricing Model': 'tier_v2', 'Stripe Connect Status': 'active' }),
    true,
  );
  assert.equal(
    isPinDepositReady({ 'Pricing Model': 'tier_v2', 'Stripe Connect Status': 'pending' }),
    false,
  );
  assert.equal(isPinDepositReady(tokenOnlyBrokerRanch()), false);
  assert.equal(isPinDepositReady({}), false);
});

test('a LIVE ranch with no deposit rail is real but not reservable — the map must say so', () => {
  // Five of the fourteen green pins on the live map are exactly this shape
  // (Live, browsable, no Connect/broker checkout). Their pin card already
  // reads "View ranch →"; the headline and the filter chip must agree.
  const r = { 'Onboarding Status': 'Live' };
  assert.equal(derivePinStatus(r).status, 'live');
  assert.equal(isPinDepositReady(r), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// statusMatches — the map's status filter
// ─────────────────────────────────────────────────────────────────────────────

test('statusMatches: represented counts as reservable AND as live+onboarding', () => {
  const r = { status: 'represented' as const, depositReady: true };
  assert.equal(statusMatches('available', r), true);
  assert.equal(statusMatches('coming', r), true);
  assert.equal(statusMatches('all', r), true);
});

test('statusMatches: "Taking reservations" requires a real deposit rail, not just a green bucket', () => {
  const live = { status: 'live' as const, depositReady: true };
  const liveNoRail = { status: 'live' as const, depositReady: false };
  assert.equal(statusMatches('available', live), true);
  assert.equal(statusMatches('available', liveNoRail), false);
  // …but the DEFAULT view must not hide that ranch — it is real supply.
  assert.equal(statusMatches('coming', liveNoRail), true);
  assert.equal(statusMatches('all', liveNoRail), true);
});

test('statusMatches: the pipeline buckets keep their old membership', () => {
  const onboarding = { status: 'onboarding' as const, depositReady: true };
  assert.equal(statusMatches('available', onboarding), false);
  assert.equal(statusMatches('coming', onboarding), true);
  assert.equal(statusMatches('coming', { status: 'self-submitted', depositReady: false }), false);
  assert.equal(statusMatches('coming', { status: 'prospect', depositReady: false }), false);
  assert.equal(statusMatches('all', { status: 'prospect', depositReady: false }), true);
});

test('the headline count and the "Taking reservations" filter can never disagree', () => {
  const pins = [
    statPin({ status: 'live', depositReady: true }),
    statPin({ status: 'live', depositReady: false }),
    statPin({ status: 'represented', depositReady: true }),
    statPin({ status: 'represented', depositReady: false }),
    statPin({ status: 'onboarding', depositReady: true }),
    statPin({ status: 'prospect' }),
  ];
  const shown = pins.filter((p) => statusMatches('available', p)).length;
  assert.equal(shown, deriveMapStats(pins).reservable);
});

// ─────────────────────────────────────────────────────────────────────────────
// WIRING — the surfaces actually consume the shared bucketing
// ─────────────────────────────────────────────────────────────────────────────

test('WIRING /map page: uses derivePinStatus + isPinDepositReady, no hand-rolled fallthrough left', () => {
  const page = src('app/map/page.tsx');
  assert.ok(page.includes('derivePinStatus('), 'page must bucket via lib/mapPinStatus');
  assert.ok(page.includes('isPinDepositReady('), 'page must gate the CTA via lib/mapPinStatus');
  assert.ok(page.includes('deriveMapStats('), 'page must derive its public counts via lib/mapPinStatus');
  // The old inline chain must be gone — a resurrected copy would silently
  // fork from the carve-out again.
  assert.ok(!page.includes("status = 'prospect'"), 'no inline prospect fallthrough in the page');
});

test('WIRING DiscoverMap: represented gets its own pin, badge, price, and reserve gate', () => {
  const map = src('app/map/components/DiscoverMap.tsx');
  assert.ok(map.includes('representedIcon'), 'iconForStatus must branch for represented');
  assert.ok(
    map.includes('Represented ranch'),
    'popup badge must read in-network, never "On our radar"',
  );
  assert.ok(map.includes('deposits open'), 'a routable represented ranch still says deposits are open');
  // Price + reserve both admit represented alongside the live bucket.
  assert.ok(count(map, "pin.status === 'represented'") >= 2, 'price AND reserve admit represented');
});

test('WIRING RancherList: represented is admitted to the SSR/SEO list with its own honest badge', () => {
  const list = src('app/map/components/RancherList.tsx');
  assert.ok(list.includes("p.status === 'represented'"), 'list filter must admit represented');
  assert.ok(list.includes('represented'), 'row badge says represented — never "verified"');
});

test('WIRING MapLegend: a represented row exists so the green/gold pin is explained', () => {
  const legend = src('app/map/components/MapLegend.tsx');
  assert.ok(legend.includes('Represented'), 'legend must name the represented status');
  assert.ok(legend.includes('#E3C381'), 'legend swatch carries the tallow center that IDs the pin');
});

// ── the /map truth pins (2026-08-18) ────────────────────────────────────────

test('WIRING hero: the blanket "shipping beef today" headline is gone and the count is derived', () => {
  const client = code('app/map/components/DiscoverMapClient.tsx');
  assert.ok(
    !/shipping beef today/i.test(client),
    'the headline must not claim shipping for ranches that only do pickup/delivery',
  );
  assert.ok(!/shippingTodayCount/.test(client), 'the mis-derived prop must be gone');
  assert.ok(client.includes('reservableCount'), 'headline counts ranches with a real deposit rail');
  assert.ok(
    client.includes('coldChainShipperCount'),
    'any shipping number on the hero is the fulfillment-derived one',
  );
});

test('WIRING /map page: no surface asserts verification over the whole green bucket', () => {
  const page = code('app/map/page.tsx');
  assert.ok(
    !/verified partners and ranches we represent/i.test(page),
    'the false green-bucket legend sentence must be gone',
  );
  assert.ok(!/shipping today/i.test(page), 'no "shipping today" claim survives on /map');
  assert.ok(!/shippingToday/.test(page), 'the mis-derived stat must be gone');

  const legend = code('app/map/components/MapLegend.tsx');
  assert.ok(
    !/verified partner/i.test(legend),
    'the legend row must not claim verification over the green bucket',
  );
  assert.ok(
    !/shipping via\s+BuyHalfCow today/i.test(legend.replace(/\s+/g, ' ')),
    'the legend row must not claim shipping over the green bucket',
  );
});

test('WIRING RancherList + PinCard: the word "verified" is gated on the verification field', () => {
  const list = code('app/map/components/RancherList.tsx');
  assert.ok(list.includes('p.verified'), 'list badge reads the per-ranch verification flag');

  const map = code('app/map/components/DiscoverMap.tsx');
  assert.ok(map.includes('pin.verified'), 'pin card gates its Verified line on the verification flag');
  assert.ok(
    map.includes('pin.depositReady'),
    'the pin card derives "taking reservations" from the deposit rail, not the bucket',
  );
});

test('WIRING StatusFilter: the "Shipping today" chip is gone and reservations gate on a deposit rail', () => {
  const f = code('app/map/components/StatusFilter.tsx');
  assert.ok(!/Shipping today/i.test(f), 'the false "Shipping today" chip must be gone');
  assert.ok(!/Shipping \+ onboarding/i.test(f), 'the false "Shipping + onboarding" chip must be gone');
  assert.ok(f.includes('depositReady'), 'the available bucket gates on depositReady');
});
