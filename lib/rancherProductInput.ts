// lib/rancherProductInput.ts
//
// Pure pricing + validation for the rancher self-serve product rail (journey
// overhaul Phase 6). A Connect-active rancher enters the RETAIL price (what
// the buyer pays = Display Price); we derive their net (Rancher Base) by
// subtracting the standard category margin, and the UI shows "you net $X ·
// buyhalfcow's cut $Y" transparently. The margin is skimmed at checkout as the
// Stripe application_fee (Display − Base) by the EXISTING checkout path —
// nothing here touches money movement; this module only decides the numbers
// that get written onto the Rancher Products row.
//
// LOAD-BEARING INVARIANT (mirrors isSellableRow in lib/marketplaceProducts):
//   0 < Rancher Base <= Display Price
// A self-served product must never mint a negative-margin or free row.

import { normalizeCommissionRate } from './commission';

// Canonical Category values — must match the `categories` arrays inside
// MARKETPLACE_GROUPS (lib/marketplaceProducts.ts) so a new product buckets
// into a browse section instead of falling through to "more from the ranch".
export const PRODUCT_CATEGORIES = [
  'Jerky',
  'Snack Sticks',
  'Sampler Box',
  'Bundle',
  'Ground Box',
  'Eighth Share',
] as const;

// Margin tiering (founder-approved 2026-07-04: "whatever protects my margin"):
// impulse/shelf-stable items carry 20%, frozen boxes/bundles/shares 15%.
//
// PRICING-APPRAISAL TRIGGER (2026-07-06 research): jerky/sticks can carry 25%
// (top of the impulse band; shipped rail = leak-proof, so the take holds) —
// but ONLY once supply is healthy. Raising a rancher's cut while supply-starved
// and recruiting is bad timing. When Connect-active ranchers per demand state
// stop being the constraint, bump Jerky + Snack Sticks to 0.25 here.
export const MARGIN_BY_CATEGORY: Record<string, number> = {
  Jerky: 0.2,
  'Snack Sticks': 0.2,
  'Sampler Box': 0.15,
  Bundle: 0.15,
  'Ground Box': 0.15,
  'Eighth Share': 0.15,
};
const DEFAULT_MARGIN = 0.15;

// $5 floor — below this, Stripe's fixed fee eats the margin and the row reads
// as a data-entry mistake, not a product.
export const MIN_PRODUCT_PRICE_CENTS = 500;
// $2,000 ceiling — above this it's a typo (1999 vs 19.99), not a marketplace
// product; shares above this price sell through the deposit rail, not /shop.
export const MAX_PRODUCT_PRICE_CENTS = 200000;

export interface ProductPricing {
  displayCents: number;
  baseCents: number;
  marginCents: number;
  marginRate: number;
}

// ── SHIPPING MUST BE A DELIBERATE CHOICE (shop-chain audit 2026-08-01) ───────
//
// The form asked for a "shipping charge (optional)" next to a nationwide
// checkbox that defaults ON, with no guidance whatsoever. So the DEFAULT
// outcome for a new rancher was: ships nationwide, shipping blank, rancher
// silently eats the cold-chain cost on every order — and nobody finds out
// until the first dry-ice invoice lands. (The one live order is fine: that
// ranch's price genuinely includes shipping. It just wasn't RECORDED as a
// choice, which is the part that doesn't survive a second rancher.)
//
// Now a nationwide product must say WHICH it is, and the answer is persisted:
//   'included' → Shipping Cost 0   (explicit zero, distinguishable from blank)
//   'charged'  → Shipping Cost > 0
// Blank Shipping Cost now means ONLY "this listing predates the question" —
// which is what makes the change non-breaking: existing rows keep working
// untouched and are asked once, the next time they're edited.
export type ShippingChoice = 'included' | 'charged';

/** Plain-words guidance the form shows. Real frozen cross-country rates. */
export const FROZEN_SHIPPING_LOW_DOLLARS = 40;
export const FROZEN_SHIPPING_HIGH_DOLLARS = 90;

export const SHIPPING_CHOICE_PROMPT =
  'how does shipping work on this one? either your price already covers it, or the buyer pays a shipping charge on top. ' +
  `shipping frozen beef cross-country usually runs $${FROZEN_SHIPPING_LOW_DOLLARS} to $${FROZEN_SHIPPING_HIGH_DOLLARS} a box — ` +
  'if your price does not cover that, you are paying it out of your own cut on every order.';

export type ShippingResolution =
  | { ok: true; shippingCostField: number | null; shippingIncluded: boolean | null }
  | { ok: false; error: string };

/**
 * Decide what a product's shipping fields should be, or refuse until the
 * rancher answers. Pure.
 *
 *  - LOCAL PICKUP (shipsNationwide false): shipping is never charged and the
 *    question is not asked — nothing to be ambiguous about.
 *  - An amount > 0 IS the answer ("buyer pays it"), no separate flag needed.
 *  - An explicit 0 IS the answer ("my price covers it").
 *  - Blank + an explicit 'included' choice ⇒ 0.
 *  - Blank + 'charged' ⇒ refuse: they picked "buyer pays" and typed no number.
 *  - Blank + no choice ⇒ refuse with SHIPPING_CHOICE_PROMPT.
 */
export function resolveShippingChoice(input: {
  shipsNationwide?: boolean;
  shippingCost?: number | '' | null;
  shippingChoice?: string | null;
}): ShippingResolution {
  const nationwide = input.shipsNationwide !== false;
  if (!nationwide) {
    return { ok: true, shippingCostField: null, shippingIncluded: null };
  }

  const raw = input.shippingCost;
  const blank = raw === undefined || raw === null || raw === '';
  if (!blank) {
    const s = Number(raw);
    if (!Number.isFinite(s) || s < 0 || s > 200) {
      return {
        ok: false,
        error: 'shipping charge must be between $0 and $200 (enter 0 if your price already covers shipping).',
      };
    }
    const rounded = s > 0 ? Math.round(s * 100) / 100 : 0;
    return { ok: true, shippingCostField: rounded, shippingIncluded: rounded === 0 };
  }

  const choice = String(input.shippingChoice || '').trim().toLowerCase();
  if (choice === 'included') {
    return { ok: true, shippingCostField: 0, shippingIncluded: true };
  }
  if (choice === 'charged') {
    return {
      ok: false,
      error: `enter the shipping amount the buyer pays (frozen usually runs $${FROZEN_SHIPPING_LOW_DOLLARS} to $${FROZEN_SHIPPING_HIGH_DOLLARS} cross-country), or switch to "my price already includes shipping".`,
    };
  }
  return { ok: false, error: SHIPPING_CHOICE_PROMPT };
}

/**
 * Derive the rancher's net from the retail price.
 *
 * LOCKED-RATE RULE (2026-08-03, live overcharge): a rancher with a locked
 * `Commission Rate` gets THAT rate as the product margin — the category
 * margin is only the fallback for ranchers without one. The category table
 * silently took 15–20% from a rancher whose platform rate was locked at 10%
 * (and would have taken it from Operator-tier 0% ranchers too). The operator
 * has told a locked-rate rancher in writing that the category cut "isn't
 * supposed to do that for anyone already on the platform" — that is the spec.
 *
 * `lockedRate` runs through normalizeCommissionRate (lib/commission — the
 * single source of the 0-is-valid rule), so a locked 0 (Operator tier) means
 * 0% margin (base = display), NEVER a fall-through to the category table,
 * and a raw Airtable value ("10", "10%") normalizes instead of exploding the
 * math. null/undefined/garbage → category behavior, byte-identical to before.
 *
 * Base is rounded (not floored) then clamped so the sellability invariant
 * holds at any cent value; margin is the exact remainder so cents reconcile.
 */
export function deriveProductPricing({
  displayCents,
  category,
  lockedRate,
}: {
  displayCents: number;
  category: string;
  /** The owning rancher's locked Commission Rate (raw field or resolved
   *  fraction — normalized either way). null/undefined = no locked rate. */
  lockedRate?: number | null;
}): ProductPricing {
  const normalizedLocked = normalizeCommissionRate(lockedRate);
  const marginRate = normalizedLocked ?? MARGIN_BY_CATEGORY[category] ?? DEFAULT_MARGIN;
  let baseCents = Math.round(displayCents * (1 - marginRate));
  // Clamp into the invariant: 0 < base <= display.
  if (baseCents < 1) baseCents = 1;
  if (baseCents > displayCents) baseCents = displayCents;
  return {
    displayCents,
    baseCents,
    marginCents: displayCents - baseCents,
    marginRate,
  };
}

// Cloud-share links (Drive/Dropbox/OneDrive) render as HTML pages, not images —
// they'd show as broken photos to paid traffic. Same rejection rule the
// landing-page editor applies to gallery photos.
function isUsableImageUrl(u: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const s = u.toLowerCase();
  return !(
    s.includes('drive.google.com') ||
    s.includes('docs.google.com') ||
    s.includes('dropbox.com') ||
    s.includes('1drv.ms') ||
    s.includes('onedrive.live.com') ||
    s.includes('icloud.com')
  );
}

export interface ProductInput {
  name?: string;
  displayPrice?: number; // dollars, as typed by the rancher
  category?: string;
  description?: string;
  weight?: string;
  imageUrl?: string;
  shipsNationwide?: boolean;
  // BYOC (2026-07-08): rancher's own store link. Empty string clears it.
  externalCheckoutUrl?: string;
  shelfStable?: boolean;
  // Inventory: blank/undefined = unlimited; an integer >= 0 = orders left
  // (0 = deliberately paused as sold out). Decremented per settled order.
  ordersLeft?: number | '' | null;
  // Product info (Phase 12): what the buyer gets + how it arrives. Optional —
  // but the form nudges hard, because buyers buy what they understand.
  whatsIncluded?: string; // newline-separated list
  shipsInDays?: number | '' | null;
  packaging?: string;
  feeds?: string;
  // Shipping (2026-07-07): per-order shipping charge in DOLLARS. When > 0 the
  // buyer pays it at checkout as a separate shipping line and the rancher
  // keeps 100% of it — BHC's margin never touches shipping.
  //
  // 2026-08-01: 0 now means "my price already covers shipping" (a deliberate
  // answer), and BLANK means "this listing predates the question". See
  // resolveShippingChoice.
  shippingCost?: number | '' | null;
  /** The explicit answer when no amount is entered. See ShippingChoice. */
  shippingChoice?: ShippingChoice | string | null;
}

export type ValidatedProduct =
  | {
      ok: true;
      /** Airtable-ready field patch (pricing fields NOT included — the route
       *  derives + stamps those from displayCents so they can never disagree
       *  with the margin math). null clears a field (unlimited inventory). */
      fields: Record<string, string | number | boolean | null>;
      displayCents: number;
      /**
       * The rancher's shipping answer, deliberately kept OUT of `fields`:
       * 'Shipping Included' is a NEW Rancher Products field, and an unknown
       * field name 422s the whole create/update in Airtable. The route writes
       * it in its own best-effort patch so the listing rail cannot break
       * before Ben adds the field. null = local pickup (question not asked).
       *
       * The answer is ALSO encoded in 'Shipping Cost' (0 = included, >0 =
       * charged, blank = never asked), so it survives regardless.
       */
      shippingIncluded: boolean | null;
    }
  | { ok: false; error: string };

/** Normalize + validate a rancher's product submission. Pure. */
export function validateProductInput(body: ProductInput): ValidatedProduct {
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, error: 'give the product a name.' };
  if (name.length > 80) return { ok: false, error: 'name is too long (80 characters max).' };

  const price = Number(body.displayPrice);
  if (!Number.isFinite(price)) return { ok: false, error: 'enter a price.' };
  const displayCents = Math.round(price * 100);
  if (displayCents < MIN_PRODUCT_PRICE_CENTS) {
    return { ok: false, error: 'price must be at least $5.' };
  }
  // Fat-finger ceiling: "1999" instead of "19.99" would list a $1,999 jerky
  // live within seconds (and a buyer could really pay it). Marketplace
  // products top out around an eighth share — $2,000 is generous headroom.
  if (displayCents > MAX_PRODUCT_PRICE_CENTS) {
    return { ok: false, error: 'price looks too high — double-check it (max $2,000). typo like 1999 instead of 19.99?' };
  }

  // SHARE FENCE (gate audit 2026-07-07): whole/half/quarter shares are the
  // qualified deposit rail — they must NEVER be one-click buyable from cold
  // /shop traffic. A rancher naming a Bundle "Half Beef Share $1,900" would
  // bypass the entire qualification gate. Eighth shares are the sanctioned
  // tier product (their own category); word PAIRS only, so "half-pound
  // jerky" or "quarter-inch cut" never false-positive.
  if (/\b(whole|half|quarter)\s*[- ]?\s*(beef|cow|share|steer|animal)s?\b/i.test(name)) {
    return {
      ok: false,
      error: 'whole, half, and quarter shares sell through your share pricing in My Page (buyers reserve with a deposit) — not as one-click products. list boxes, bundles, or an eighth share here instead.',
    };
  }

  const category = String(body.category || '').trim();
  if (!(PRODUCT_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, error: 'pick a category.' };
  }

  const description = String(body.description || '').trim();
  if (description.length > 1000) return { ok: false, error: 'description is too long (1000 max).' };

  const weight = String(body.weight || '').trim();
  if (weight.length > 60) return { ok: false, error: 'weight/size is too long (60 max).' };

  const imageUrl = String(body.imageUrl || '').trim();
  if (imageUrl && !isUsableImageUrl(imageUrl)) {
    return {
      ok: false,
      error: 'that image link won’t render as a photo — upload the image itself (no Drive/Dropbox share links).',
    };
  }

  // Inventory: blank stays blank (unlimited — Airtable field cleared via
  // null); a value must be a whole number >= 0.
  let ordersLeftField: number | null = null;
  const rawLeft = body.ordersLeft;
  const hasLeft = !(rawLeft === undefined || rawLeft === null || rawLeft === '');
  if (hasLeft) {
    const n = Number(rawLeft);
    if (!Number.isInteger(n) || n < 0 || n > 100000) {
      return { ok: false, error: 'orders available must be a whole number (leave blank for unlimited).' };
    }
    ordersLeftField = n;
  }

  // Product info (all optional, length-capped; blank clears).
  const whatsIncluded = String(body.whatsIncluded || '').trim();
  if (whatsIncluded.length > 1000) return { ok: false, error: "what's included is too long (1000 max)." };
  const packaging = String(body.packaging || '').trim();
  if (packaging.length > 200) return { ok: false, error: 'packaging is too long (200 max).' };
  const feeds = String(body.feeds || '').trim();
  if (feeds.length > 200) return { ok: false, error: 'feeds is too long (200 max).' };
  // SHIPS IN DAYS — REQUIRED for a shippable product (shop-chain audit
  // 2026-08-01). It is quoted to the buyer at checkout ("ships from the ranch
  // within ~N days") and it now drives the fulfillment-SLA windows
  // (lib/productFulfillmentSla.slaWindowFor), so a blank one means the buyer
  // gets a vague promise AND the rancher gets chased on someone else's
  // schedule. Local-pickup products never ship, so it stays optional there.
  //
  // Non-breaking: this only runs through validateProductInput, i.e. on create
  // and on a content edit. Existing rows keep selling untouched until someone
  // edits them.
  const nationwide = body.shipsNationwide !== false;
  let shipsInDaysField: number | null = null;
  const rawDays = body.shipsInDays;
  const daysBlank = rawDays === undefined || rawDays === null || rawDays === '';
  if (!daysBlank) {
    const d = Number(rawDays);
    if (!Number.isInteger(d) || d < 1 || d > 60) {
      return { ok: false, error: 'ships-in days must be a whole number of days (1–60).' };
    }
    shipsInDaysField = d;
  } else if (nationwide) {
    return {
      ok: false,
      error:
        'how many days until this ships? buyers see it at checkout, and it is what we hold the order to — a real number you can hit beats an optimistic one.',
    };
  }

  // Shipping: an explicit choice, not a blank that quietly costs the rancher
  // money on every order. See resolveShippingChoice.
  const shipping = resolveShippingChoice({
    shipsNationwide: body.shipsNationwide,
    shippingCost: body.shippingCost,
    shippingChoice: body.shippingChoice,
  });
  if (!shipping.ok) return { ok: false, error: shipping.error };
  const shippingCostField = shipping.shippingCostField;

  // External checkout URL (BYOC): optional; when present must be a real
  // http(s) URL — anything else is rejected so /go can trust the record.
  let externalUrl = '';
  if (body.externalCheckoutUrl !== undefined && String(body.externalCheckoutUrl).trim() !== '') {
    const raw = String(body.externalCheckoutUrl).trim();
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
      externalUrl = u.toString();
    } catch {
      return { ok: false as const, error: 'External store link must be a full http(s) URL (or leave it blank).' };
    }
  }

  const fields: Record<string, string | number | boolean | null> = {
    'Product Name': name,
    'Display Price': displayCents / 100,
    Category: category,
    Description: description,
    'Weight / Size': weight,
    'Image URL': imageUrl,
    'Ships Nationwide': nationwide,
    'External Checkout URL': externalUrl,
    'Shelf Stable': !!body.shelfStable,
    'Orders Left': ordersLeftField,
    "What's Included": whatsIncluded,
    'Ships In Days': shipsInDaysField,
    Packaging: packaging,
    Feeds: feeds,
    'Shipping Cost': shippingCostField,
  };

  return { ok: true, fields, displayCents, shippingIncluded: shipping.shippingIncluded };
}
