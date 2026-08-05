import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBudgetCeiling,
  classifyBudget,
  extractBeefSignals,
  nationwideFitVerdict,
} from './nationwideFit';
import { isRancherOperationalForBuyers } from './rancherEligibility';

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Generic specialty-shipper shape (premium prices, production claims). Field
// names mirror the live Ranchers table; NO real ranch data — repo is public.
const premiumRancher = {
  'Beef Types': 'grass-fed, grass-finished, regenerative',
  'Quarter Price': 1900,
  'Half Price': 3800,
  'Whole Price': 7400,
};
const unpricedRancher = {
  'Beef Types': 'grass-fed, grass-finished',
  'Quarter Price': 0,
  'Half Price': null,
  'Whole Price': undefined,
};
const conventionalRancher = {
  'Beef Types': 'corn-finished Black Angus',
  'Quarter Price': 1200,
  'Half Price': 2300,
  'Whole Price': 4400,
};

// ── parseBudgetCeiling: semantics pinned (moved from matching/suggest) ───────
// This parser previously lived inline in app/api/matching/suggest/route.ts
// (isPriceFit). It moved here UNCHANGED; these pins keep the move honest.

test('parseBudgetCeiling: range bracket → upper bound', () => {
  assert.equal(parseBudgetCeiling('$1000-$1500'), 1500);
  assert.equal(parseBudgetCeiling('$4000-$5000'), 5000);
});

test('parseBudgetCeiling: "+" bracket → Infinity', () => {
  assert.equal(parseBudgetCeiling('$5000+'), Infinity);
  assert.equal(parseBudgetCeiling('$2000+'), Infinity);
});

test('parseBudgetCeiling: "<" bracket → the number', () => {
  assert.equal(parseBudgetCeiling('<$500'), 500);
});

test('parseBudgetCeiling: "Just exploring" → 0 (hard reject)', () => {
  assert.equal(parseBudgetCeiling('Just exploring'), 0);
});

test('parseBudgetCeiling: legacy Unsure/Not Sure/empty → Infinity (permissive)', () => {
  assert.equal(parseBudgetCeiling('Unsure'), Infinity);
  assert.equal(parseBudgetCeiling('Not Sure'), Infinity);
  assert.equal(parseBudgetCeiling(''), Infinity);
});

test('parseBudgetCeiling: bare number strings parse', () => {
  assert.equal(parseBudgetCeiling('$2,500'), 2500);
  assert.equal(parseBudgetCeiling('2000'), 2000);
});

// ── classifyBudget: known vs never-expressed (the fit-gate distinction) ──────
// parseBudgetCeiling collapses "$5000+" and ""/"Unsure" to the SAME Infinity;
// the fit gate must not — an unanswered budget can't wave a buyer through a
// premium gate, an expressed top bracket can.

test('classifyBudget: expressed brackets are known', () => {
  assert.deepEqual(classifyBudget('$1000-$1500'), { known: true, ceiling: 1500 });
  assert.deepEqual(classifyBudget('$5000+'), { known: true, ceiling: Infinity });
  assert.deepEqual(classifyBudget('Just exploring'), { known: true, ceiling: 0 });
});

test('classifyBudget: empty / Unsure / digit-free garbage are unknown', () => {
  assert.equal(classifyBudget('').known, false);
  assert.equal(classifyBudget('  ').known, false);
  assert.equal(classifyBudget('Unsure').known, false);
  assert.equal(classifyBudget('Not Sure').known, false);
  assert.equal(classifyBudget('idk, call me').known, false);
  assert.equal(classifyBudget(undefined).known, false);
  assert.equal(classifyBudget(null).known, false);
});

test('classifyBudget: Airtable {name} select-object shape is read', () => {
  assert.deepEqual(
    classifyBudget({ id: 'sel1', name: '$2000-$2500', color: 'green' }),
    { known: true, ceiling: 2500 },
  );
});

// ── extractBeefSignals: the token normalizer ─────────────────────────────────

test('extractBeefSignals: spelling variants land on one token', () => {
  assert.ok(extractBeefSignals('Grass Fed').has('grassfed'));
  assert.ok(extractBeefSignals('grassfed').has('grassfed'));
  assert.ok(extractBeefSignals('grass-fed beef please').has('grassfed'));
});

test('extractBeefSignals: "100% grass-finished" → grassfinished (+ implied grassfed)', () => {
  const s = extractBeefSignals('100% grass-finished');
  assert.ok(s.has('grassfinished'));
  assert.ok(s.has('grassfed')); // grass-finished cattle are grass-fed by definition
});

test('extractBeefSignals: production claims and breeds detected', () => {
  assert.ok(extractBeefSignals('regenerative ranching').has('regenerative'));
  assert.ok(extractBeefSignals('certified ORGANIC').has('organic'));
  assert.ok(extractBeefSignals('pasture raised, non-GMO').has('pastureraised'));
  assert.ok(extractBeefSignals('pasture raised, non-GMO').has('nongmo'));
  assert.ok(extractBeefSignals('Wagyu crosses').has('wagyu'));
});

test('extractBeefSignals: no cross-word false positives', () => {
  // Whole-string collapse would see "organ i couldnt" as containing "organic";
  // adjacent-pair joining must not.
  assert.equal(extractBeefSignals('organ i couldnt say').has('organic'), false);
  assert.equal(extractBeefSignals('').size, 0);
  assert.equal(extractBeefSignals(undefined).size, 0);
  assert.equal(extractBeefSignals('just some beef').size, 0);
});

// ── nationwideFitVerdict: the four rules ─────────────────────────────────────

test('fit: budget covers cheapest cut, no preference needed', () => {
  const v = nationwideFitVerdict(
    { 'Budget': '$2000-$2500', 'Interest Beef': '' },
    premiumRancher,
  );
  assert.equal(v.fit, true); // 2500 ≥ 1900 quarter
  assert.match(v.reason, /covers cheapest cut/);
});

test('not fit: budget below cheapest cut, EVEN with a preference match', () => {
  const v = nationwideFitVerdict(
    { 'Budget': '$1000-$1500', 'Interest Beef': '100% grass-fed only please' },
    premiumRancher,
  );
  assert.equal(v.fit, false); // 1500 < 1900 — no sticker-shock routing
  assert.match(v.reason, /below cheapest cut/);
});

test('fit: no budget answered but grass-fed interest matches rancher', () => {
  const v = nationwideFitVerdict(
    { 'Budget': '', 'Interest Beef': 'looking for grass fed beef' },
    premiumRancher,
  );
  assert.equal(v.fit, true); // expressed specialty seeker = the right customer
  assert.match(v.reason, /interest matches rancher specialty/);
});

test('not fit: no budget, no preference → stays waitlisted (status quo)', () => {
  const v = nationwideFitVerdict(
    { 'Budget': '', 'Interest Beef': '' },
    premiumRancher,
  );
  assert.equal(v.fit, false);
  assert.match(v.reason, /no parsable budget and no specialty interest/);
});

test('preference match is rancher-attribute-driven, not a fixed profile', () => {
  // Same buyer text, different rancher attributes → different verdicts.
  const grassSeeker = { 'Budget': '', 'Interest Beef': 'grass fed please' };
  assert.equal(nationwideFitVerdict(grassSeeker, premiumRancher).fit, true);
  // A corn-finished rancher does NOT claim grass-fed → no overlap → no fit.
  assert.equal(nationwideFitVerdict(grassSeeker, conventionalRancher).fit, false);
  // And the overlap works for ANY shared signal, e.g. breed terms.
  const angusSeeker = { 'Budget': '', 'Interest Beef': 'Black Angus' };
  assert.equal(nationwideFitVerdict(angusSeeker, conventionalRancher).fit, true);
});

test('"Just exploring" is an expressed $0 ceiling — hard floor, preference cannot save it', () => {
  const v = nationwideFitVerdict(
    { 'Budget': 'Just exploring', 'Interest Beef': 'grass-fed grass-finished' },
    premiumRancher,
  );
  assert.equal(v.fit, false);
  assert.match(v.reason, /below cheapest cut/);
});

test('weird budget strings: Unsure/garbage fall to the preference rule', () => {
  // "Unsure" (legacy) is NOT an expressed budget — preference decides.
  assert.equal(
    nationwideFitVerdict({ 'Budget': 'Unsure', 'Interest Beef': 'regenerative' }, premiumRancher).fit,
    true,
  );
  assert.equal(
    nationwideFitVerdict({ 'Budget': 'Unsure', 'Interest Beef': '' }, premiumRancher).fit,
    false,
  );
  // Digit-free garbage behaves like unanswered.
  assert.equal(
    nationwideFitVerdict({ 'Budget': 'whatever it takes', 'Interest Beef': '' }, premiumRancher).fit,
    false,
  );
  // "$5000+" is expressed and unbounded → fit on budget grounds alone.
  assert.equal(
    nationwideFitVerdict({ 'Budget': '$5000+', 'Interest Beef': '' }, premiumRancher).fit,
    true,
  );
});

test('unpriced rancher: finite budget cannot verify → preference decides; $5000+ clears', () => {
  // Finite ceiling vs no priced cut — affordability unverifiable, no pref → not fit.
  const noPref = nationwideFitVerdict({ 'Budget': '$2000-$2500', 'Interest Beef': '' }, unpricedRancher);
  assert.equal(noPref.fit, false);
  assert.match(noPref.reason, /no priced cut/);
  // Same budget + expressed matching interest → fit via the preference rule.
  assert.equal(
    nationwideFitVerdict({ 'Budget': '$2000-$2500', 'Interest Beef': 'grassfed' }, unpricedRancher).fit,
    true,
  );
  // Expressed unbounded bracket clears on budget grounds even unpriced.
  assert.equal(
    nationwideFitVerdict({ 'Budget': '$5000+', 'Interest Beef': '' }, unpricedRancher).fit,
    true,
  );
});

test('verdict tolerates missing/garbage records without throwing', () => {
  assert.equal(nationwideFitVerdict({}, {}).fit, false);
  assert.equal(nationwideFitVerdict({} as any, premiumRancher).fit, false);
  assert.equal(
    nationwideFitVerdict({ 'Budget': 42 as any, 'Interest Beef': null }, premiumRancher).fit,
    false, // non-string Budget reads as '' → unknown, no preference → not fit
  );
});

// ── Broker pin: represented ranchers can NEVER reach the nationwide pool ─────
// The fallback filter in matching/suggest requires isEligibleBase → which
// requires isRancherOperationalForBuyers → which hard-refuses Broker Rail
// FIRST, before any status field. Pin that here so no flag combination —
// including both nationwide flags — can ever route a buyer to a represented
// rancher through the fallback.
test('broker rancher with both nationwide flags is still non-operational', () => {
  const broker = {
    'Broker Rail': true,
    // Every other gate set to PASS, so this pin fails only if the broker
    // check itself is ever weakened.
    'Active Status': 'Active',
    'Agreement Signed': true,
    'Onboarding Status': 'Live',
    'Subscription Status': 'active',
    'Pricing Model': 'legacy',
    'Ships Nationwide': true,
    'Admin Approved Multi-State': true,
  };
  assert.equal(isRancherOperationalForBuyers(broker), false);
  // Sanity: the identical rancher WITHOUT the broker flag is operational —
  // proves the broker flag (not some other field) is what blocks.
  assert.equal(isRancherOperationalForBuyers({ ...broker, 'Broker Rail': false }), true);
});
