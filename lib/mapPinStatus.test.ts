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
//   • Connect-rail rows  → byte-identical bucketing to the original inline
//     logic (Live/Verified → verified, stages → onboarding, etc.).
//
// Synthetic ranch names only — the repo is PUBLIC.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  derivePinStatus,
  isPinDepositReady,
  ONBOARDING_STAGES,
} from './mapPinStatus';
import { mapPinsFormula } from './airtable';
import { statusMatches } from '../app/map/components/StatusFilter';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

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

test('verified outranks represented: a ranch that graduated to Live reads verified', () => {
  assert.equal(
    derivePinStatus(selfServeBrokerRanch({ 'Onboarding Status': 'Live' })).status,
    'verified',
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

test('Connect-rail bucketing is unchanged: Live/Verified ⇒ verified', () => {
  assert.deepEqual(derivePinStatus({ 'Onboarding Status': 'Live' }), {
    status: 'verified',
    stageLabel: '',
  });
  assert.deepEqual(derivePinStatus({ 'Verification Status': 'Verified' }), {
    status: 'verified',
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

// ─────────────────────────────────────────────────────────────────────────────
// statusMatches — the map's status filter admits represented as "available"
// ─────────────────────────────────────────────────────────────────────────────

test('statusMatches: represented counts as Shipping today AND Shipping + onboarding', () => {
  assert.equal(statusMatches('available', 'represented'), true);
  assert.equal(statusMatches('coming', 'represented'), true);
  assert.equal(statusMatches('all', 'represented'), true);
});

test('statusMatches: the other statuses keep their old buckets', () => {
  assert.equal(statusMatches('available', 'verified'), true);
  assert.equal(statusMatches('available', 'onboarding'), false);
  assert.equal(statusMatches('coming', 'onboarding'), true);
  assert.equal(statusMatches('coming', 'self-submitted'), false);
  assert.equal(statusMatches('coming', 'prospect'), false);
  assert.equal(statusMatches('all', 'prospect'), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// WIRING — the surfaces actually consume the shared bucketing
// ─────────────────────────────────────────────────────────────────────────────

test('WIRING /map page: uses derivePinStatus + isPinDepositReady, no hand-rolled fallthrough left', () => {
  const page = src('app/map/page.tsx');
  assert.ok(page.includes('derivePinStatus('), 'page must bucket via lib/mapPinStatus');
  assert.ok(page.includes('isPinDepositReady('), 'page must gate the CTA via lib/mapPinStatus');
  // The old inline chain must be gone — a resurrected copy would silently
  // fork from the carve-out again.
  assert.ok(!page.includes("status = 'prospect'"), 'no inline prospect fallthrough in the page');
});

test('WIRING DiscoverMap: represented gets its own pin, badge, price, and reserve gate', () => {
  const map = src('app/map/components/DiscoverMap.tsx');
  assert.ok(map.includes('representedIcon'), 'iconForStatus must branch for represented');
  assert.ok(
    map.includes('Represented ranch · deposits open'),
    'popup badge must read in-network + reservable, never "On our radar"',
  );
  // Price + reserve both admit represented alongside verified.
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
