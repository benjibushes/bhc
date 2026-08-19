import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEO_STATES,
  stateNameToSlug,
  stateBySlug,
  typicalShareRanges,
  resolveShareRanges,
  fmtUsd,
  fmtRange,
  waitlistLine,
  stateFaqs,
  TYPICAL_WHOLE_LOW,
  TYPICAL_WHOLE_HIGH,
} from './stateSeo';
import { deriveLadder, DEPOSIT_PCT } from './pricing';
import { US_STATES } from './states';

// ─── SEO_STATES: the static-params source of truth ──────────────────────
// generateStaticParams prerenders exactly this list. It must be the 50
// states (no DC), with unique URL-safe full-name slugs, and it must never
// drift from lib/states.ts (the platform's canonical state list).

test('SEO_STATES is exactly the 50 states — no DC, no dupes', () => {
  assert.equal(SEO_STATES.length, 50);
  assert.ok(!SEO_STATES.some((s) => s.code === 'DC'), 'DC must be excluded');
  const slugs = new Set(SEO_STATES.map((s) => s.slug));
  const codes = new Set(SEO_STATES.map((s) => s.code));
  assert.equal(slugs.size, 50, 'slugs must be unique');
  assert.equal(codes.size, 50, 'codes must be unique');
});

test('every slug is lowercase, hyphenated, URL-safe', () => {
  for (const s of SEO_STATES) {
    assert.match(s.slug, /^[a-z]+(-[a-z]+)*$/, `bad slug: ${s.slug}`);
  }
});

test('SEO_STATES stays in lockstep with lib/states.ts', () => {
  const canonical = US_STATES.filter((s) => s.code !== 'DC');
  assert.equal(SEO_STATES.length, canonical.length);
  for (const c of canonical) {
    const found = SEO_STATES.find((s) => s.code === c.code);
    assert.ok(found, `missing state ${c.code}`);
    assert.equal(found.name, c.name);
  }
});

test('stateNameToSlug handles multi-word states and whitespace', () => {
  assert.equal(stateNameToSlug('Texas'), 'texas');
  assert.equal(stateNameToSlug('New York'), 'new-york');
  assert.equal(stateNameToSlug('  West   Virginia  '), 'west-virginia');
  assert.equal(stateNameToSlug(''), '');
});

// ─── stateBySlug: the 404 boundary ───────────────────────────────────────

test('stateBySlug resolves full-name slugs (case-insensitive, trimmed)', () => {
  assert.equal(stateBySlug('texas')?.code, 'TX');
  assert.equal(stateBySlug('new-york')?.code, 'NY');
  assert.equal(stateBySlug('Texas')?.code, 'TX');
  assert.equal(stateBySlug(' texas ')?.code, 'TX');
});

test('stateBySlug rejects everything outside the 50-name slug space', () => {
  // 2-letter codes belong to /access/[state] — must 404 here.
  assert.equal(stateBySlug('tx'), null);
  assert.equal(stateBySlug('dc'), null);
  assert.equal(stateBySlug('district-of-columbia'), null);
  assert.equal(stateBySlug('new york'), null); // unhyphenated ≠ a route slug
  assert.equal(stateBySlug('bogusland'), null);
  assert.equal(stateBySlug(''), null);
});

// ─── typicalShareRanges: truth-coupled to lib/pricing.ts ────────────────
// The published dollar ranges must be EXACTLY what deriveLadder produces
// for the typical whole-beef band, so a pricing retune propagates to every
// state page automatically instead of stranding stale copy.

test('share ranges equal deriveLadder output at the band edges', () => {
  const r = typicalShareRanges();
  const lo = deriveLadder(TYPICAL_WHOLE_LOW);
  const hi = deriveLadder(TYPICAL_WHOLE_HIGH);
  assert.deepEqual(r.whole, { low: lo.whole, high: hi.whole });
  assert.deepEqual(r.half, { low: lo.half, high: hi.half });
  assert.deepEqual(r.quarter, { low: lo.quarter, high: hi.quarter });
});

test('share ranges are sane: positive, low<high, half<whole, quarter<half', () => {
  const r = typicalShareRanges();
  for (const tier of [r.whole, r.half, r.quarter]) {
    assert.ok(tier.low > 0 && tier.high > tier.low);
  }
  assert.ok(r.half.high < r.whole.high);
  assert.ok(r.quarter.high < r.half.high);
});

test('depositPercent mirrors DEPOSIT_PCT as a whole number', () => {
  assert.equal(typicalShareRanges().depositPercent, Math.round(DEPOSIT_PCT * 100));
});

// ─── formatting ──────────────────────────────────────────────────────────

test('fmtUsd / fmtRange render whole-dollar US format', () => {
  assert.equal(fmtUsd(1950), '$1,950');
  assert.equal(fmtUsd(550), '$550');
  assert.equal(fmtRange({ low: 1100, high: 1950 }), '$1,100–$1,950');
});

// ─── waitlistLine: honest social proof or nothing ────────────────────────

test('waitlistLine renders real positive counts with pluralization', () => {
  assert.equal(waitlistLine('Texas', 1), '1 Texas family is already on the list.');
  assert.equal(
    waitlistLine('Texas', 253),
    '253 Texas families are already on the list.',
  );
  assert.equal(
    waitlistLine('California', 1981),
    '1,981 California families are already on the list.',
  );
});

test('waitlistLine returns null for zero, null (unknown), and garbage', () => {
  // null = Airtable unreachable — must NOT render as a zero-claim.
  assert.equal(waitlistLine('Texas', null), null);
  assert.equal(waitlistLine('Texas', 0), null);
  assert.equal(waitlistLine('Texas', -3), null);
  assert.equal(waitlistLine('Texas', NaN), null);
});

// ─── stateFaqs: the JSON-LD + visible-FAQ shared source ─────────────────

test('stateFaqs returns 4 items with non-empty q/a mentioning the state', () => {
  const faqs = stateFaqs('Montana');
  assert.equal(faqs.length, 4);
  for (const f of faqs) {
    assert.ok(f.q.length > 10 && f.a.length > 40);
  }
  assert.ok(faqs[0].q.includes('Montana'));
  assert.ok(faqs[3].a.includes('Montana'));
});

test('stateFaqs pricing answer carries the derived ranges + honest comparison', () => {
  const r = typicalShareRanges();
  const priceFaq = stateFaqs('Texas')[0];
  assert.ok(priceFaq.a.includes(fmtRange(r.half)), 'half range must appear');
  assert.ok(priceFaq.a.includes(fmtRange(r.quarter)), 'quarter range must appear');
  assert.ok(priceFaq.a.includes('hanging weight'));
});

test('stateFaqs deposit answer states refundability and the percent', () => {
  const r = typicalShareRanges();
  const depositFaq = stateFaqs('Ohio')[2];
  assert.ok(depositFaq.a.includes('refundable'));
  assert.ok(depositFaq.a.includes(`${r.depositPercent}%`));
});

// ─── LIVE-SUPPLY PRICING (2026-08-18) ───────────────────────────────────────
// /half-a-cow/arizona published half beef at $3,300–$3,850 while the ONLY
// live Arizona supply (a weight-priced represented ranch) sells a half at
// $2,025–$2,363 — the page anchored every AZ buyer ~60% above the real offer.
// The network-typical band is now a FALLBACK, used only when the state has no
// live supply we can price from.
//
// Fixtures below are real public listing shapes (rancher pricing is public;
// this repo is public — counts and prices only, never a buyer).

const AZ_WEIGHT_PRICED = {
  'Quarter Price': 1050, 'Quarter Price Max': 1225,
  'Half Price': 2025, 'Half Price Max': 2363,
  'Whole Price': 4050, 'Whole Price Max': 4725,
};
const CO_A = { 'Half Price': 1760, 'Whole Price': 3520 };            // no quarter
const CO_B = { 'Quarter Price': 1400, 'Half Price': 2600, 'Whole Price': 4800 };

test('ZERO live ranchers → the network-typical band, flagged as not-from-supply', () => {
  const resolved = resolveShareRanges([]);
  assert.equal(resolved.hasSupplyPricing, false);
  assert.deepEqual(resolved.ranges, typicalShareRanges());
  assert.deepEqual(resolved.fromSupply, { whole: false, half: false, quarter: false });
});

test('UNKNOWN supply (Airtable unreachable → null) falls back, never invents', () => {
  for (const unknown of [null, undefined]) {
    const resolved = resolveShareRanges(unknown);
    assert.equal(resolved.hasSupplyPricing, false);
    assert.deepEqual(resolved.ranges, typicalShareRanges());
  }
});

test('ONE live rancher prices the page — weight-priced cuts use floor→max', () => {
  const resolved = resolveShareRanges([AZ_WEIGHT_PRICED]);
  assert.equal(resolved.hasSupplyPricing, true);
  assert.deepEqual(resolved.ranges.half, { low: 2025, high: 2363 });
  assert.deepEqual(resolved.ranges.quarter, { low: 1050, high: 1225 });
  assert.deepEqual(resolved.ranges.whole, { low: 4050, high: 4725 });
  assert.deepEqual(resolved.fromSupply, { whole: true, half: true, quarter: true });
  // The exact lie this fix exists to kill.
  assert.notEqual(fmtRange(resolved.ranges.half), fmtRange(typicalShareRanges().half));
  assert.equal(fmtRange(resolved.ranges.half), '$2,025–$2,363');
});

test('MULTIPLE live ranchers span the whole real market, tier by tier', () => {
  const resolved = resolveShareRanges([CO_A, CO_B]);
  assert.equal(resolved.hasSupplyPricing, true);
  assert.deepEqual(resolved.ranges.half, { low: 1760, high: 2600 });
  assert.deepEqual(resolved.ranges.whole, { low: 3520, high: 4800 });
  // Only ONE of the two prices a quarter — that is still real supply.
  assert.deepEqual(resolved.ranges.quarter, { low: 1400, high: 1400 });
  assert.deepEqual(resolved.fromSupply, { whole: true, half: true, quarter: true });
});

test('a tier NO live rancher sells falls back to network-typical, and says so', () => {
  const resolved = resolveShareRanges([CO_A]); // half + whole only
  assert.equal(resolved.fromSupply.quarter, false);
  assert.deepEqual(resolved.ranges.quarter, typicalShareRanges().quarter);
  assert.equal(resolved.fromSupply.half, true);
  assert.deepEqual(resolved.ranges.half, { low: 1760, high: 1760 });
});

test('live ranchers with NO published prices fall all the way back', () => {
  const resolved = resolveShareRanges([{ Slug: 'listed-but-unpriced' }, {}]);
  assert.equal(resolved.hasSupplyPricing, false);
  assert.deepEqual(resolved.ranges, typicalShareRanges());
});

test('per-lb mis-entries and junk are dropped, never published as a share price', () => {
  // The DD-Ranch class of bug: $7.40 typed into a whole-cow total field.
  const resolved = resolveShareRanges([
    { 'Half Price': 7.4, 'Whole Price': 0, 'Quarter Price': -20 },
    { 'Half Price': 2600, 'Whole Price': 'n/a', 'Quarter Price': null },
  ]);
  assert.deepEqual(resolved.ranges.half, { low: 2600, high: 2600 });
  assert.equal(resolved.fromSupply.whole, false);
  assert.equal(resolved.fromSupply.quarter, false);
});

test('a Max at or below its floor is EXACT mode, not a range', () => {
  const resolved = resolveShareRanges([{ 'Half Price': 2600, 'Half Price Max': 2600 }]);
  assert.deepEqual(resolved.ranges.half, { low: 2600, high: 2600 });
  const junkMax = resolveShareRanges([{ 'Half Price': 2600, 'Half Price Max': 10 }]);
  assert.deepEqual(junkMax.ranges.half, { low: 2600, high: 2600 });
  // A plausible-but-inverted Max (a real price, just below the floor) must not
  // be trusted either — publishing high < low would render "$2,600–$1,500".
  const inverted = resolveShareRanges([{ 'Half Price': 2600, 'Half Price Max': 1500 }]);
  assert.deepEqual(inverted.ranges.half, { low: 2600, high: 2600 });
});

test('fmtRange collapses a single-price market instead of saying "$X–$X"', () => {
  assert.equal(fmtRange({ low: 2600, high: 2600 }), '$2,600');
  assert.equal(fmtRange({ low: 1999.99, high: 1999.99 }), '$2,000');
  assert.equal(fmtRange({ low: 1760, high: 2600 }), '$1,760–$2,600');
});

test('the network band is never mistaken for live supply pricing', () => {
  // A state page that shows the network band must be able to SAY so — the
  // whole point of the flags.
  const network = resolveShareRanges([]);
  const supply = resolveShareRanges([AZ_WEIGHT_PRICED]);
  assert.notDeepEqual(network.fromSupply, supply.fromSupply);
});

// ─── stateFaqs honours the resolved ranges (FAQPage JSON-LD included) ───────

test('stateFaqs quotes LIVE supply prices when the state has supply', () => {
  const resolved = resolveShareRanges([AZ_WEIGHT_PRICED]);
  const faq = stateFaqs('Arizona', resolved)[0];
  assert.ok(faq.a.includes('$2,025–$2,363'), 'must quote the real Arizona half');
  assert.ok(!faq.a.includes('$3,300'), 'must not quote the network band as Arizona');
});

test('stateFaqs falls back to the network band with no supply, and defaults safely', () => {
  const t = typicalShareRanges();
  assert.ok(stateFaqs('Wyoming', resolveShareRanges([]))[0].a.includes(fmtRange(t.half)));
  // No second argument at all → the old, network-typical behaviour.
  assert.ok(stateFaqs('Wyoming')[0].a.includes(fmtRange(t.half)));
});

test('stateFaqs drops the network per-lb rate when it is quoting real supply', () => {
  const supply = stateFaqs('Arizona', resolveShareRanges([AZ_WEIGHT_PRICED]))[0].a;
  assert.ok(!supply.includes('$8–$11'), 'a network-derived $/lb rate is not an Arizona fact');
  assert.ok(supply.includes('hanging weight'), 'the mechanism still gets explained');
  const network = stateFaqs('Wyoming', resolveShareRanges([]))[0].a;
  assert.ok(network.includes('$8–$11'), 'the network band keeps its matching $/lb figure');
});
