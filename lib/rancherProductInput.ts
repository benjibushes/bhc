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

  const fields: Record<string, string | number | boolean | null> = {
    'Product Name': name,
    'Display Price': displayCents / 100,
    Category: category,
    Description: description,
    'Weight / Size': weight,
    'Image URL': imageUrl,
    'Ships Nationwide': body.shipsNationwide === false ? false : true,
    'Shelf Stable': !!body.shelfStable,
    'Orders Left': ordersLeftField,
    "What's Included": whatsIncluded,
    'Ships In Days': shipsInDaysField,
    Packaging: packaging,
    Feeds: feeds,
  };

  return { ok: true, fields, displayCents };
}
