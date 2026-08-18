// Tests for lib/rancherProductInput.ts — the pure pricing + validation layer
// behind the rancher self-serve product rail (journey overhaul Phase 6).
//
// The load-bearing invariant mirrors isSellableRow in lib/marketplaceProducts:
// derived Rancher Base must always satisfy 0 < base <= display, so a
// self-served product can never mint a negative-margin (or free) row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveProductPricing,
  validateProductInput,
  MARGIN_BY_CATEGORY,
  PRODUCT_CATEGORIES,
  MIN_PRODUCT_PRICE_CENTS,
  resolveShippingChoice,
  SHIPPING_CHOICE_PROMPT,
  missingRequiredAnswers,
} from './rancherProductInput';

// ── deriveProductPricing ──────────────────────────────────────────────────────

test('jerky takes the 20% impulse margin', () => {
  const p = deriveProductPricing({ displayCents: 2000, category: 'Jerky' });
  assert.equal(p.displayCents, 2000);
  assert.equal(p.marginRate, 0.2);
  assert.equal(p.baseCents, 1600);
  assert.equal(p.marginCents, 400);
});

test('snack sticks take the 20% impulse margin', () => {
  const p = deriveProductPricing({ displayCents: 1359, category: 'Snack Sticks' });
  assert.equal(p.marginRate, 0.2);
  assert.equal(p.baseCents + p.marginCents, 1359); // cents always reconcile
});

test('boxes take 15%', () => {
  for (const category of ['Sampler Box', 'Bundle', 'Ground Box', 'Eighth Share']) {
    const p = deriveProductPricing({ displayCents: 9500, category });
    assert.equal(p.marginRate, 0.15, category);
    assert.equal(p.baseCents, 8075, category);
  }
});

test('unknown category falls back to the 15% default', () => {
  const p = deriveProductPricing({ displayCents: 10000, category: 'Mystery' });
  assert.equal(p.marginRate, 0.15);
});

test('sellability invariant holds at awkward cent values', () => {
  // Sweep odd prices — base must always be 0 < base <= display and reconcile.
  for (const displayCents of [501, 999, 1001, 1359, 2499, 74900, 33333]) {
    for (const category of PRODUCT_CATEGORIES) {
      const p = deriveProductPricing({ displayCents, category });
      assert.ok(p.baseCents > 0, `${category} ${displayCents}: base > 0`);
      assert.ok(p.baseCents <= p.displayCents, `${category} ${displayCents}: base <= display`);
      assert.equal(p.baseCents + p.marginCents, p.displayCents, 'cents reconcile');
    }
  }
});

// ── validateProductInput ──────────────────────────────────────────────────────

// Shop-chain audit 2026-08-01: a nationwide listing must now answer BOTH
// "how long until it ships" and "who pays shipping" — so the shared fixture
// answers them. The gates themselves are tested at the bottom of this file.
const ANSWERED = { shipsInDays: 3, shippingChoice: 'included' as const };

const GOOD = {
  name: 'Peppered Beef Jerky',
  displayPrice: 19.99,
  category: 'Jerky',
  description: 'a bag of the good stuff',
  weight: '3 oz',
  imageUrl: 'https://blob.vercel-storage.com/ranchers/rec123/x-photo.jpg',
  shipsNationwide: true,
  shelfStable: true,
  ...ANSWERED,
};

test('a valid input normalizes into Airtable-ready fields', () => {
  const r = validateProductInput(GOOD);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fields['Product Name'], 'Peppered Beef Jerky');
  assert.equal(r.fields['Display Price'], 19.99);
  assert.equal(r.fields['Category'], 'Jerky');
  assert.equal(r.fields['Ships Nationwide'], true);
  assert.equal(r.fields['Shelf Stable'], true);
  assert.equal(r.displayCents, 1999);
});

test('name is required and length-capped', () => {
  assert.equal(validateProductInput({ ...GOOD, name: '' }).ok, false);
  assert.equal(validateProductInput({ ...GOOD, name: 'x'.repeat(81) }).ok, false);
});

test('price floor enforced', () => {
  assert.equal(MIN_PRODUCT_PRICE_CENTS, 500);
  assert.equal(validateProductInput({ ...GOOD, displayPrice: 4.99 }).ok, false);
  assert.equal(validateProductInput({ ...GOOD, displayPrice: 0 }).ok, false);
  assert.equal(validateProductInput({ ...GOOD, displayPrice: NaN as any }).ok, false);
});

test('category must be one of the canonical marketplace categories', () => {
  assert.equal(validateProductInput({ ...GOOD, category: 'Weird Stuff' }).ok, false);
  for (const category of PRODUCT_CATEGORIES) {
    assert.equal(validateProductInput({ ...GOOD, category }).ok, true, category);
  }
});

test('cloud-share image links are rejected (Drive/Dropbox render broken)', () => {
  for (const bad of [
    'https://drive.google.com/file/d/abc/view',
    'https://www.dropbox.com/s/abc/photo.jpg',
    'https://1drv.ms/u/s!abc',
    'not-a-url',
  ]) {
    assert.equal(validateProductInput({ ...GOOD, imageUrl: bad }).ok, false, bad);
  }
});

test('image is optional — a product can launch photo-less (placeholder renders)', () => {
  const r = validateProductInput({ ...GOOD, imageUrl: '' });
  assert.equal(r.ok, true);
});

test('description capped at 1000, weight at 60', () => {
  assert.equal(validateProductInput({ ...GOOD, description: 'x'.repeat(1001) }).ok, false);
  assert.equal(validateProductInput({ ...GOOD, weight: 'x'.repeat(61) }).ok, false);
});

test('shipsNationwide defaults true; explicit false respected', () => {
  const def = validateProductInput({ ...GOOD, shipsNationwide: undefined as any });
  assert.equal(def.ok && def.fields['Ships Nationwide'], true);
  const off = validateProductInput({ ...GOOD, shipsNationwide: false });
  assert.equal(off.ok && off.fields['Ships Nationwide'], false);
});

test('margin map covers every canonical category', () => {
  for (const c of PRODUCT_CATEGORIES) {
    assert.ok(MARGIN_BY_CATEGORY[c] !== undefined, c);
  }
});

test('ordersLeft: blank = unlimited (null field), integers pass, junk rejected', () => {
  const blank = validateProductInput({ ...GOOD });
  assert.equal(blank.ok && blank.fields['Orders Left'], null);
  const set = validateProductInput({ ...GOOD, ordersLeft: 12 });
  assert.equal(set.ok && set.fields['Orders Left'], 12);
  const zero = validateProductInput({ ...GOOD, ordersLeft: 0 });
  assert.equal(zero.ok && zero.fields['Orders Left'], 0); // deliberate sold-out pause
  assert.equal(validateProductInput({ ...GOOD, ordersLeft: 2.5 as any }).ok, false);
  assert.equal(validateProductInput({ ...GOOD, ordersLeft: -1 as any }).ok, false);
});

test('shippingCost: 0 records "price includes it", values pass, junk + out-of-range rejected', () => {
  const base = { name: 'Jerky', displayPrice: 25, category: 'Jerky', ...ANSWERED };
  // 0 is now an EXPLICIT answer that persists, not a cleared field — blank is
  // reserved for "this listing predates the question".
  const zero = validateProductInput({ ...base, shippingCost: 0 });
  assert.ok(zero.ok && zero.fields['Shipping Cost'] === 0);
  assert.ok(zero.ok && zero.shippingIncluded === true);
  const set = validateProductInput({ ...base, shippingCost: 12.5 });
  assert.ok(set.ok && set.fields['Shipping Cost'] === 12.5);
  assert.ok(set.ok && set.shippingIncluded === false);
  assert.equal(validateProductInput({ ...base, shippingCost: -3 }).ok, false);
  assert.equal(validateProductInput({ ...base, shippingCost: 250 }).ok, false);
  assert.equal(validateProductInput({ ...base, shippingCost: Number('junk') }).ok, false);
});

test('price ceiling: fat-fingered 1999-instead-of-19.99 is rejected; $2,000 exactly passes', () => {
  const base = { name: 'Jerky', category: 'Jerky', ...ANSWERED };
  assert.equal(validateProductInput({ ...base, displayPrice: 1999 }).ok, true); // $1,999 valid
  assert.equal(validateProductInput({ ...base, displayPrice: 2000 }).ok, true); // boundary
  assert.equal(validateProductInput({ ...base, displayPrice: 2000.01 }).ok, false);
  assert.equal(validateProductInput({ ...base, displayPrice: 19990 }).ok, false);
});

test('SHARE FENCE: whole/half/quarter share names are rejected; boxes + eighth share + half-pound pass', () => {
  const base = { displayPrice: 1900, category: 'Bundle', ...ANSWERED };
  assert.equal(validateProductInput({ ...base, name: 'Half Beef Share' }).ok, false);
  assert.equal(validateProductInput({ ...base, name: 'half cow deposit' }).ok, false);
  assert.equal(validateProductInput({ ...base, name: 'QUARTER-BEEF bundle' }).ok, false);
  assert.equal(validateProductInput({ ...base, name: 'Whole Animal' }).ok, false);
  assert.equal(validateProductInput({ ...base, name: 'Whole steer, pasture raised' }).ok, false);
  // legit products must never false-positive
  assert.equal(validateProductInput({ ...base, name: 'Half-Pound Jerky 3-Pack', displayPrice: 25, category: 'Jerky' }).ok, true);
  assert.equal(validateProductInput({ ...base, name: 'Eighth Share', displayPrice: 749, category: 'Eighth Share' }).ok, true);
  assert.equal(validateProductInput({ ...base, name: '20lb Ground Beef Box', displayPrice: 280, category: 'Ground Box' }).ok, true);
});

test('PATCH merge regression: shippingCost survives an unrelated content edit', () => {
  // Direct validator check of the fix's contract: absent shippingCost clears,
  // present value persists — the route now always threads the existing value.
  const withShip = validateProductInput({ name: 'Jerky', displayPrice: 25, category: 'Jerky', shippingCost: 8.5, ...ANSWERED });
  assert.ok(withShip.ok && withShip.fields['Shipping Cost'] === 8.5);
});

// ── SHIPPING IS A DELIBERATE CHOICE (shop-chain audit 2026-08-01) ───────────
// The old form's default outcome was: nationwide checked, shipping blank,
// rancher silently eats the cold-chain cost. Now they have to say which.

test('resolveShippingChoice: an amount IS the answer; 0 IS the answer; blank refuses', () => {
  const nationwide = { shipsNationwide: true };
  assert.deepEqual(resolveShippingChoice({ ...nationwide, shippingCost: 65 }), {
    ok: true,
    shippingCostField: 65,
    shippingIncluded: false,
  });
  assert.deepEqual(resolveShippingChoice({ ...nationwide, shippingCost: 0 }), {
    ok: true,
    shippingCostField: 0,
    shippingIncluded: true,
  });
  assert.deepEqual(resolveShippingChoice({ ...nationwide, shippingChoice: 'included' }), {
    ok: true,
    shippingCostField: 0,
    shippingIncluded: true,
  });
  // No amount and no answer → refuse, with the plain-words guidance.
  const blank = resolveShippingChoice(nationwide);
  assert.equal(blank.ok, false);
  if (!blank.ok) {
    assert.equal(blank.error, SHIPPING_CHOICE_PROMPT);
    assert.match(blank.error, /\$40 to \$90/);
  }
  // "buyer pays" with no number is an unfinished answer, not an answer.
  const charged = resolveShippingChoice({ ...nationwide, shippingChoice: 'charged' });
  assert.equal(charged.ok, false);
});

test('resolveShippingChoice: local pickup is never asked and never charged', () => {
  assert.deepEqual(resolveShippingChoice({ shipsNationwide: false }), {
    ok: true,
    shippingCostField: null,
    shippingIncluded: null,
  });
  // Even a stray amount on a pickup row resolves to no charge.
  assert.deepEqual(resolveShippingChoice({ shipsNationwide: false, shippingCost: 40 }), {
    ok: true,
    shippingCostField: null,
    shippingIncluded: null,
  });
});

test('a nationwide product cannot be listed without answering shipping', () => {
  const noAnswer = validateProductInput({ name: 'Jerky', displayPrice: 25, category: 'Jerky', shipsInDays: 3 });
  assert.equal(noAnswer.ok, false);
  if (!noAnswer.ok) assert.match(noAnswer.error, /shipping/i);
});

test('NON-BREAKING: a local-pickup product still lists with neither answer', () => {
  const pickup = validateProductInput({
    name: 'Ground Box',
    displayPrice: 180,
    category: 'Ground Box',
    shipsNationwide: false,
  });
  assert.equal(pickup.ok, true);
  if (pickup.ok) {
    assert.equal(pickup.fields['Shipping Cost'], null);
    assert.equal(pickup.fields['Ships In Days'], null);
    assert.equal(pickup.shippingIncluded, null);
  }
});

// ── SHIPS IN DAYS NOW MEANS SOMETHING ──────────────────────────────────────

test('a shippable product must promise a ship window (it drives the SLA)', () => {
  const blank = validateProductInput({
    name: 'Jerky',
    displayPrice: 25,
    category: 'Jerky',
    shippingChoice: 'included',
  });
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.match(blank.error, /days/i);

  const ok = validateProductInput({
    name: 'Jerky',
    displayPrice: 25,
    category: 'Jerky',
    shippingChoice: 'included',
    shipsInDays: 2,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.fields['Ships In Days'], 2);
});

test('ship window stays a sane whole number of days', () => {
  const base = { name: 'Jerky', displayPrice: 25, category: 'Jerky', shippingChoice: 'included' };
  assert.equal(validateProductInput({ ...base, shipsInDays: 0 }).ok, false);
  assert.equal(validateProductInput({ ...base, shipsInDays: 61 }).ok, false);
  assert.equal(validateProductInput({ ...base, shipsInDays: 2.5 as any }).ok, false);
  assert.equal(validateProductInput({ ...base, shipsInDays: 60 }).ok, true);
  assert.equal(validateProductInput({ ...base, shipsInDays: 1 }).ok, true);
});

// ── deriveProductPricing — LOCKED COMMISSION RATE (2026-08-03) ───────────────
//
// THE LIVE BUG: the product rail took the 15–20% category margin from EVERY
// rancher — including a locked-rate rancher whose platform Commission Rate is
// 0.10. A $375 Bundle netted $318.75 instead of $337.50. A locked rate now IS
// the product margin; the category table only applies when no rate is locked.

test('locked 10% beats the category margin — the exact live overcharge', () => {
  // $375 Bundle at a locked 0.10: base must be $337.50. The category table's
  // 15% produced $318.75 — an $18.75 overcharge on a single real order.
  const p = deriveProductPricing({ displayCents: 37500, category: 'Bundle', lockedRate: 0.1 });
  assert.equal(p.marginRate, 0.1);
  assert.equal(p.baseCents, 33750);
  assert.equal(p.marginCents, 3750);
  // ...and it beats the 20% impulse band too.
  const j = deriveProductPricing({ displayCents: 2000, category: 'Jerky', lockedRate: 0.1 });
  assert.equal(j.marginRate, 0.1);
  assert.equal(j.baseCents, 1800);
});

test('locked 0 (Operator tier) is VALID — base = display, never the category fallback', () => {
  // The platform's most expensive historical bug was treating 0 as missing.
  for (const category of PRODUCT_CATEGORIES) {
    const p = deriveProductPricing({ displayCents: 37500, category, lockedRate: 0 });
    assert.equal(p.marginRate, 0, category);
    assert.equal(p.baseCents, 37500, category);
    assert.equal(p.marginCents, 0, category);
  }
});

test('no locked rate (undefined / null) → category behavior byte-identical', () => {
  for (const lockedRate of [undefined, null]) {
    const j = deriveProductPricing({ displayCents: 2000, category: 'Jerky', lockedRate });
    assert.equal(j.marginRate, 0.2);
    assert.equal(j.baseCents, 1600);
    const b = deriveProductPricing({ displayCents: 37500, category: 'Bundle', lockedRate });
    assert.equal(b.marginRate, 0.15);
    assert.equal(b.baseCents, 31875);
  }
});

test('locked rate rides normalizeCommissionRate — percent forms and garbage share the close-path rules', () => {
  // A raw Airtable "10" (typed as percent) normalizes to 0.10 — same
  // semantics calcCommissionForRancher applies on the close path.
  const pct = deriveProductPricing({ displayCents: 37500, category: 'Bundle', lockedRate: 10 });
  assert.equal(pct.marginRate, 0.1);
  assert.equal(pct.baseCents, 33750);
  // Garbage never explodes the math: negative / NaN / >=100 → no usable
  // locked rate → category fallback (never a clamped-to-1-cent payout).
  for (const junk of [-0.1, NaN, 400]) {
    const p = deriveProductPricing({ displayCents: 37500, category: 'Bundle', lockedRate: junk });
    assert.equal(p.marginRate, 0.15, String(junk));
    assert.equal(p.baseCents, 31875, String(junk));
  }
});

test('sellability invariant + cent reconciliation hold at locked rates on odd prices', () => {
  for (const displayCents of [501, 999, 1001, 1359, 2499, 33333, 37500, 74900]) {
    for (const lockedRate of [0, 0.04, 0.1, 0.125, 0.5]) {
      const p = deriveProductPricing({ displayCents, category: 'Bundle', lockedRate });
      assert.equal(p.marginRate, lockedRate, `${displayCents}@${lockedRate}: locked rate honored`);
      assert.ok(p.baseCents > 0, `${displayCents}@${lockedRate}: base > 0`);
      assert.ok(p.baseCents <= p.displayCents, `${displayCents}@${lockedRate}: base <= display`);
      assert.equal(p.baseCents + p.marginCents, p.displayCents, `${displayCents}@${lockedRate}: cents reconcile`);
    }
  }
});

// ── Source-shape pin: BOTH pricing call sites in the products route must pass
// the owner's locked rate. A revert to category-only derivation reappears here
// before it reaches a rancher's payout.
test('create + edit routes derive pricing WITH the rancher locked rate', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const routeSrc = readFileSync(
    fileURLToPath(new URL('../app/api/rancher/products/route.ts', import.meta.url)),
    'utf8',
  );
  const calls = routeSrc.match(/deriveProductPricing\(\{[\s\S]*?\}\)/g) || [];
  assert.equal(calls.length, 2, 'POST create + PATCH edit each derive pricing exactly once');
  for (const call of calls) {
    assert.match(call, /lockedRate:\s*lockedCommissionRateFor\(/, 'every derivation carries the locked rate');
  }
});

// ── THE LEGACY-LISTING EDIT WALL (live bug, ranchers 2026-08-17) ─────────────
//
// #524 (2026-08-01) started REQUIRING two answers on every shippable listing:
// a ships-in-days window and an explicit shipping choice. It was written to be
// non-breaking — existing rows keep selling and get asked "the next time
// they're edited". They did get asked. Badly.
//
// validateProductInput is the SHARED create+edit validator and it fails FAST,
// so an edit of a pre-#524 row returned one question-shaped 400 at a time:
// save → "how many days until this ships?" → save → "how does shipping work on
// this one?" → save. 10 of 11 live rows were in exactly that state, and the
// edit form gave no signal until the rancher pressed save. Ranchers reported it
// as "I can't edit my products."
//
// The requirement itself is correct and stays (it exists so nobody silently
// eats $40-90 a box of cold-chain cost). What changes: the missing answers are
// now enumerable UP FRONT, so the form can ask for all of them at once instead
// of the rancher discovering them one rejection at a time.

test('missingRequiredAnswers names BOTH gaps at once on a pre-#524 listing', () => {
  // Exactly how ProductsTab pre-fills the edit form from a legacy row.
  assert.deepEqual(
    missingRequiredAnswers({
      name: 'Original Beef Jerky',
      displayPrice: 25,
      category: 'Jerky',
      shipsNationwide: true,
      shipsInDays: '',
      shippingCost: '',
      shippingChoice: '',
    }),
    ['shipsInDays', 'shippingChoice'],
  );
});

test('missingRequiredAnswers empties out as the rancher answers', () => {
  const legacy = {
    name: 'Original Beef Jerky',
    displayPrice: 25,
    category: 'Jerky',
    shipsNationwide: true,
    shipsInDays: '' as const,
    shippingCost: '' as const,
    shippingChoice: '',
  };
  assert.deepEqual(missingRequiredAnswers({ ...legacy, shipsInDays: 3 }), ['shippingChoice']);
  assert.deepEqual(missingRequiredAnswers({ ...legacy, shippingChoice: 'included' }), ['shipsInDays']);
  assert.deepEqual(missingRequiredAnswers({ ...legacy, shipsInDays: 3, shippingChoice: 'included' }), []);
  // An amount IS the shipping answer — no separate choice needed.
  assert.deepEqual(missingRequiredAnswers({ ...legacy, shipsInDays: 3, shippingCost: 65 }), []);
  // An explicit 0 ("my price covers it") is an answer too.
  assert.deepEqual(missingRequiredAnswers({ ...legacy, shipsInDays: 3, shippingCost: 0 }), []);
});

test('"charged" with no amount still counts as an unanswered shipping question', () => {
  assert.deepEqual(
    missingRequiredAnswers({
      name: 'Jerky', displayPrice: 25, category: 'Jerky',
      shipsInDays: 3, shippingCost: '', shippingChoice: 'charged',
    }),
    ['shippingChoice'],
  );
});

test('a BAD answer is not a MISSING answer (out-of-range shipping)', () => {
  // $300 is a typo the validator rejects — but the rancher HAS answered, so the
  // form must not tell them the question is still outstanding.
  assert.deepEqual(
    missingRequiredAnswers({
      name: 'Jerky', displayPrice: 25, category: 'Jerky',
      shipsInDays: 3, shippingCost: 300,
    }),
    [],
  );
  assert.equal(validateProductInput({
    name: 'Jerky', displayPrice: 25, category: 'Jerky',
    shipsInDays: 3, shippingCost: 300,
  }).ok, false);
});

test('local pickup is asked NEITHER question', () => {
  assert.deepEqual(
    missingRequiredAnswers({
      name: 'Ground Box', displayPrice: 180, category: 'Ground Box',
      shipsNationwide: false, shipsInDays: '', shippingCost: '', shippingChoice: '',
    }),
    [],
  );
});

test('a rejected save reports EVERY outstanding answer, not just the first', () => {
  // The whole point: one round trip tells the rancher the complete ask.
  const legacy = validateProductInput({
    name: 'Original Beef Jerky',
    displayPrice: 25,
    category: 'Jerky',
    shipsNationwide: true,
    shipsInDays: '',
    shippingCost: '',
    shippingChoice: '',
  });
  assert.equal(legacy.ok, false);
  if (!legacy.ok) {
    assert.deepEqual(legacy.missing, ['shipsInDays', 'shippingChoice']);
    // The first-fail message is unchanged — existing callers keep working.
    assert.match(legacy.error, /days/i);
  }
});

test('an ordinary validation failure carries no phantom missing answers', () => {
  const noName = validateProductInput({ name: '', displayPrice: 25, category: 'Jerky', ...ANSWERED });
  assert.equal(noName.ok, false);
  if (!noName.ok) assert.equal(noName.missing, undefined);
});

// ── Source-shape pins for the edit-wall fix ─────────────────────────────────
// The value of `missing` is that it reaches the rancher. Pin both ends: the
// route must forward it on every 400, and the tab must derive the up-front ask
// from THIS module (a hand-rolled copy in the component would drift away from
// the validator and start lying about what is outstanding).

test('both product-route 400s forward the full missing-answer set', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const routeSrc = readFileSync(
    fileURLToPath(new URL('../app/api/rancher/products/route.ts', import.meta.url)),
    'utf8',
  );
  const rejections = routeSrc.match(/if \(!v\.ok\) return NextResponse\.json\([^\n]*\)/g) || [];
  assert.equal(rejections.length, 2, 'POST create + PATCH edit each reject exactly once');
  for (const r of rejections) {
    assert.match(r, /missing:\s*v\.missing/, 'the rejection carries every outstanding answer');
  }
});

test('the products tab asks up front from the shared validator helper', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const tabSrc = readFileSync(
    fileURLToPath(new URL('../app/rancher/ProductsTab.tsx', import.meta.url)),
    'utf8',
  );
  assert.match(tabSrc, /missingRequiredAnswers,?\n?\s*\} from '@\/lib\/rancherProductInput'/, 'imports the helper');
  assert.match(tabSrc, /const openAsks = missingRequiredAnswers\(\{/, 'derives the open asks from it');
  // Visibility widened (#623 follow-up, 2026-08-18): not just edits — also a
  // form SEEDED from an existing product (Duplicate carries the same legacy
  // blanks with editingId=null) and any 400 that named missing answers. The
  // decision is pure in lib/productAskBanner (pinned in its own test + the
  // ProductsTab wiring pins). A truly blank add-form still stays banner-free —
  // its required markers cover it; that case is pinned in
  // lib/productAskBanner.test.ts.
  assert.match(tabSrc, /const asking = askBannerAsks\(\{/, 'banner visibility comes from the shared decision');
});
