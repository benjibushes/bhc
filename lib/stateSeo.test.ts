import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEO_STATES,
  stateNameToSlug,
  stateBySlug,
  typicalShareRanges,
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
