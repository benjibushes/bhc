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

/**
 * Derive the rancher's net from the retail price via the category margin.
 * Base is rounded (not floored) then clamped so the sellability invariant
 * holds at any cent value; margin is the exact remainder so cents reconcile.
 */
export function deriveProductPricing({
  displayCents,
  category,
}: {
  displayCents: number;
  category: string;
}): ProductPricing {
  const marginRate = MARGIN_BY_CATEGORY[category] ?? DEFAULT_MARGIN;
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
  // Shipping (2026-07-07): optional per-order shipping charge in DOLLARS.
  // Blank/0 = shipping included in the retail price (the default). When set,
  // the buyer pays it at checkout as a separate shipping line and the rancher
  // keeps 100% of it — BHC's margin never touches shipping.
  shippingCost?: number | '' | null;
}

export type ValidatedProduct =
  | {
      ok: true;
      /** Airtable-ready field patch (pricing fields NOT included — the route
       *  derives + stamps those from displayCents so they can never disagree
       *  with the margin math). null clears a field (unlimited inventory). */
      fields: Record<string, string | number | boolean | null>;
      displayCents: number;
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
  let shipsInDaysField: number | null = null;
  const rawDays = body.shipsInDays;
  if (!(rawDays === undefined || rawDays === null || rawDays === '')) {
    const d = Number(rawDays);
    if (!Number.isInteger(d) || d < 1 || d > 60) {
      return { ok: false, error: 'ships-in days must be a whole number of days (1–60), or blank.' };
    }
    shipsInDaysField = d;
  }

  // Shipping cost: blank or 0 → cleared (shipping included). Capped at $200 —
  // above that it's a typo, not a shipping rate for a beef box.
  let shippingCostField: number | null = null;
  const rawShip = body.shippingCost;
  if (!(rawShip === undefined || rawShip === null || rawShip === '')) {
    const s = Number(rawShip);
    if (!Number.isFinite(s) || s < 0 || s > 200) {
      return { ok: false, error: 'shipping charge must be between $0 and $200 (leave blank if shipping is built into your price).' };
    }
    shippingCostField = s > 0 ? Math.round(s * 100) / 100 : null;
  }

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
    'Ships Nationwide': body.shipsNationwide === false ? false : true,
    'External Checkout URL': externalUrl,
    'Shelf Stable': !!body.shelfStable,
    'Orders Left': ordersLeftField,
    "What's Included": whatsIncluded,
    'Ships In Days': shipsInDaysField,
    Packaging: packaging,
    Feeds: feeds,
    'Shipping Cost': shippingCostField,
  };

  return { ok: true, fields, displayCents };
}
