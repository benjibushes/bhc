import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUEST_ONLY_RANCHER_SLUGS,
  REQUEST_ONLY_RANCHER_IDS,
  isRequestOnlyRancher,
  isRequestOnlyRancherId,
} from './requestOnlyRanchers';
import { nationwideFitVerdict } from './nationwideFit';
import { CAMPAIGN_WAVE_EXCLUDED_SLUGS, rancherForStateTable } from './campaignWaves';

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Field names mirror the live Ranchers table. NO buyer data — repo is public.
//
// The request-only rancher is shaped like the real violation: double-flagged
// `Admin Approved Multi-State` + `Ships Nationwide` (which is what put them in
// the nationwide fallback candidate pool for every uncovered state) and priced
// well within a big-budget buyer's ceiling (which is what made the buyer-fit
// gate wave them through on budget alone).
const requestOnlyRancher = {
  id: 'recReqOnly',
  Slug: 'rep-provisions',
  'Ranch Name': 'Request-Only Specialty',
  State: 'MO',
  'Active Status': { name: 'Active' },
  'Agreement Signed': true,
  'Beef Types': 'grass-fed, grass-finished, regenerative',
  'Quarter Price': 1900,
  'Half Price': 3700,
  'Admin Approved Multi-State': true,
  'Ships Nationwide': true,
  'Current Active Referrals': 0,
};

// A NON-request-only nationwide shipper — the control. Proves the exclusion is
// data-driven (a slug list), not "the fallback got broken for everyone".
const openNationwideRancher = {
  id: 'recOpen',
  Slug: 'foodstead',
  'Ranch Name': 'Foodstead',
  State: 'MT',
  'Active Status': { name: 'Active' },
  'Agreement Signed': true,
  'Beef Types': 'grass-fed Angus',
  'Quarter Price': 1100,
  'Half Price': 2100,
  'Admin Approved Multi-State': true,
  'Ships Nationwide': true,
  'Current Active Referrals': 0,
};

/**
 * The nationwide-fallback candidate predicate, in the SAME ORDER the live
 * matcher applies it (app/api/matching/suggest): request-only exclusion FIRST,
 * then the double-flag check, then the buyer-fit gate. Ordering is the load-
 * bearing part — the exclusion has to land before nationwideFitVerdict, or a
 * budget-qualified buyer gets fitted to specialty supply they never asked for.
 * The route's placement is pinned separately in
 * app/api/matching/suggest/route.pins.test.ts.
 */
function nationwideCandidates(
  buyer: Record<string, unknown>,
  ranchers: Record<string, unknown>[],
): string[] {
  return ranchers
    .filter((r) => {
      if (isRequestOnlyRancher(r)) return false;
      if (!(r['Admin Approved Multi-State'] && r['Ships Nationwide'])) return false;
      return nationwideFitVerdict(buyer, r).fit;
    })
    .map((r) => String(r['Slug']));
}

// ── The predicate ────────────────────────────────────────────────────────────

test('isRequestOnlyRancher: the seeded specialty slug is request-only', () => {
  assert.equal(isRequestOnlyRancher(requestOnlyRancher), true);
  assert.equal(REQUEST_ONLY_RANCHER_SLUGS.has('rep-provisions'), true);
});

test('isRequestOnlyRancher: every other rancher is NOT request-only (no over-block)', () => {
  assert.equal(isRequestOnlyRancher(openNationwideRancher), false);
  assert.equal(isRequestOnlyRancher({ Slug: 'champion-valley' }), false);
  assert.equal(isRequestOnlyRancher({ Slug: 'renick' }), false);
});

test('isRequestOnlyRancher: slug is read from the `Slug` field, trimmed and case-insensitive', () => {
  assert.equal(isRequestOnlyRancher({ Slug: '  rep-provisions  ' }), true);
  assert.equal(isRequestOnlyRancher({ Slug: 'REP-Provisions' }), true);
  // Near-misses must not be swept up — this is an exact slug list.
  assert.equal(isRequestOnlyRancher({ Slug: 'rep-provisions-2' }), false);
  assert.equal(isRequestOnlyRancher({ 'Ranch Name': 'Rep Provisions' }), false);
});

test('isRequestOnlyRancher: missing / empty / non-record input is NOT request-only', () => {
  assert.equal(isRequestOnlyRancher({}), false);
  assert.equal(isRequestOnlyRancher({ Slug: '' }), false);
  assert.equal(isRequestOnlyRancher({ Slug: null }), false);
  assert.equal(isRequestOnlyRancher(null), false);
  assert.equal(isRequestOnlyRancher(undefined), false);
});

// ── THE REGRESSION: the forbidden nationwide fallback ────────────────────────

test('REGRESSION: request-only rancher is excluded from the nationwide fallback even when BUDGET alone would fit it', () => {
  // The exact live violation: uncovered-state buyer, big budget, ZERO
  // grass-finished interest. nationwideFitVerdict's budget rule says "fit" —
  // and that is precisely why the exclusion must run before the fit gate.
  const bigBudgetNoPreference = { 'Budget': '$5000+', 'Interest Beef': '' };
  assert.equal(
    nationwideFitVerdict(bigBudgetNoPreference, requestOnlyRancher).fit,
    true,
    'precondition: the fit gate WOULD have passed this buyer — that is the bug',
  );
  assert.deepEqual(
    nationwideCandidates(bigBudgetNoPreference, [requestOnlyRancher]),
    [],
    'request-only supply must never be a generic fallback candidate',
  );
});

test('REGRESSION: request-only rancher is excluded even when the buyer PREFERENCE would fit it', () => {
  // Expressed grass-finished interest in the quiz is not a REQUEST. Request =
  // the pinned deep-link / their own page. Excluded before fitting, so the
  // preference rule never gets a say either.
  const preferenceBuyer = { 'Budget': '', 'Interest Beef': 'looking for grass finished beef' };
  assert.equal(
    nationwideFitVerdict(preferenceBuyer, requestOnlyRancher).fit,
    true,
    'precondition: the preference rule WOULD have passed this buyer',
  );
  assert.deepEqual(nationwideCandidates(preferenceBuyer, [requestOnlyRancher]), []);
});

test('the nationwide fallback still WORKS: a non-request-only shipper still fits and still routes', () => {
  const buyer = { 'Budget': '$4000-$5000', 'Interest Beef': '' };
  assert.deepEqual(
    nationwideCandidates(buyer, [openNationwideRancher]),
    ['foodstead'],
    'the fallback itself must not be broken — only the request-only slug is withheld',
  );
  // Mixed pool: the request-only one drops out, the open one still wins.
  assert.deepEqual(
    nationwideCandidates(buyer, [requestOnlyRancher, openNationwideRancher]),
    ['foodstead'],
  );
});

test('request-only exclusion does not disturb the fit gate for anyone else', () => {
  // A buyer under the open shipper's cheapest cut is still rejected on the
  // existing hard-floor rule, not swallowed by the new exclusion.
  const brokeBuyer = { 'Budget': '<$500', 'Interest Beef': '' };
  assert.deepEqual(nationwideCandidates(brokeBuyer, [openNationwideRancher]), []);
  assert.match(
    nationwideFitVerdict(brokeBuyer, openNationwideRancher).reason,
    /below cheapest cut/,
  );
});

// ── The EXPLICIT-REQUEST path stays open ─────────────────────────────────────

test('explicit request still routes: pin resolution matches a request-only rancher by slug', () => {
  // The direct-pin block resolves `?campaign=rancher-<slug>` against the
  // `Slug` field and never consults the request-only list — request-only
  // blocks the GENERIC path only. Modelled here; pinned in the route's own
  // pins test (which asserts the pin block precedes and excludes the check).
  const allRanchers = [openNationwideRancher, requestOnlyRancher];
  const effectiveCampaign = 'rancher-rep-provisions';
  const rancherSlug = effectiveCampaign.replace('rancher-', '');
  const pinned = allRanchers.find((r) => String(r['Slug'] || '') === rancherSlug);
  assert.ok(pinned, 'a pinned request-only rancher must still resolve');
  assert.equal(pinned!.id, 'recReqOnly');
  assert.equal(
    isRequestOnlyRancher(pinned),
    true,
    'being request-only is exactly what the pin is allowed to override',
  );
});

// ── Both engines read ONE list ───────────────────────────────────────────────

test('campaign waves and the matcher share ONE source of truth', () => {
  assert.equal(
    CAMPAIGN_WAVE_EXCLUDED_SLUGS,
    REQUEST_ONLY_RANCHER_SLUGS,
    'the back-compat alias must BE the shared set, not a second copy that can drift',
  );
});

test('campaign waves still exclude the request-only rancher after the refactor', () => {
  // Both fixtures are operational + sellable, so the open ranch DOES populate
  // the table — the request-only absence is the rule, not a vacuous pass.
  const table = rancherForStateTable([requestOnlyRancher, openNationwideRancher] as any[]);
  assert.equal(table.get('MT')?.slug, 'foodstead');
  assert.equal(table.has('MO'), false);
  for (const [, v] of table) {
    assert.notEqual(v.slug, 'rep-provisions');
  }
});

// ── Rec-ID belt (F10, Wave 1 rails hardening 2026-08-18) ─────────────────────
// The slug set alone left a hole: a slug RENAME in Airtable (or a pool config
// naming the record id directly, as DEMAND_CAMPAIGN_RANCHER_IDS does) slipped
// the gate. The record-id set is the belt — same list, consumed alongside the
// slug set everywhere the slug set is consumed.

test('rec-id belt: REQUEST_ONLY_RANCHER_IDS is seeded with the Rep Provisions record', () => {
  assert.ok(REQUEST_ONLY_RANCHER_IDS.has('recYE5zpedhPg6KIV'));
});

test('rec-id belt: isRequestOnlyRancherId refuses the listed id and nothing else', () => {
  assert.equal(isRequestOnlyRancherId('recYE5zpedhPg6KIV'), true);
  assert.equal(isRequestOnlyRancherId(' recYE5zpedhPg6KIV '), true, 'whitespace-trimmed');
  assert.equal(isRequestOnlyRancherId('recSomeoneElse999'), false);
  assert.equal(isRequestOnlyRancherId(''), false);
  assert.equal(isRequestOnlyRancherId(null), false);
  assert.equal(isRequestOnlyRancherId(undefined), false);
});

test('rec-id belt: a slug RENAME must not drop protection (record id still refuses)', () => {
  assert.equal(isRequestOnlyRancher({ id: 'recYE5zpedhPg6KIV', Slug: 'renamed-rep' }), true);
  assert.equal(isRequestOnlyRancher({ id: 'recYE5zpedhPg6KIV' }), true, 'slug-less record still refused');
});

test('rec-id belt: control — a different id with an open slug stays open', () => {
  assert.equal(isRequestOnlyRancher({ id: 'recOpenRanch12345', Slug: 'foodstead' }), false);
});
