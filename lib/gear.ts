// lib/gear.ts
//
// AFFILIATE-PRODUCTS LAYER (Move 1). BHC recommends curated on-brand gear to
// its OWN buyers (freezers, vacuum sealers, cast iron, rubs, knives…) and earns
// affiliate commission, marketed ON-SITE. This module is the pure core: it
// reads the curated catalog and picks which products to surface for a given
// buyer/placement. NO programmatic Amazon search — curation IS the brand guard:
// only rows a human marked Active=true ever render, anywhere.
//
// Two hard compliance rails live here in code (not left to a human to remember):
//   1. getGearCatalog returns Active-only. An unfinished/retired row never leaks.
//   2. emailSafeGear DROPS Amazon-network products. Amazon Associates ToS
//      FORBIDS affiliate links in email — any email placement uses emailSafeGear
//      ONLY. Web placements use the full set.
//
// Selection reuses the existing cutForBuyer mapper (lib/demandRouter) so cut is
// derived from Order Type in exactly ONE place — this module never re-parses it.

import { getAllRecords, TABLES } from './airtable';

// ── Types ────────────────────────────────────────────────────────────────────

export type GearCategory =
  | 'freezer'
  | 'vacuum-sealer'
  | 'cast-iron'
  | 'rub-salt'
  | 'knives'
  | 'supplements'
  | 'cooler'
  | 'other';

export type GearNetwork = 'amazon' | 'direct';

/** A buyer's share size. null = unknown ("Not Sure"/blank Order Type). */
export type GearCut = 'quarter' | 'half' | 'whole';

/** Which moment in the buyer journey a product is being surfaced for. */
export type GearStage = 'waiting' | 'delivered';

/**
 * Mirrors the Recommended Products Airtable row. Field names match the table
 * verbatim (the getAllRecords spread yields raw field keys). Everything past
 * Name/Category/Affiliate URL/Network is optional — an empty catalog and
 * partially-filled rows must both degrade gracefully.
 */
export interface GearProduct {
  id: string;
  Name: string;
  Category?: GearCategory | string;
  'Affiliate URL'?: string; // tag already baked in by Ben
  Network?: GearNetwork | string;
  'Image URL'?: string;
  Blurb?: string; // BHC's own copy
  'Target Cuts'?: string[]; // multipleSelects; EMPTY = universal
  'Target Stage'?: GearStage | 'any' | string;
  'Sort Order'?: number;
  'Freezer Mandatory'?: boolean;
  Active?: boolean;
  'Commission Note'?: string;
  [key: string]: unknown;
}

export interface SelectGearOptions {
  cut: GearCut | null;
  stage: GearStage;
  limit?: number;
}

const DEFAULT_LIMIT = 4;

// ── Catalog fetch (Active-only, fail-open) ─────────────────────────────────────

/**
 * Fetch the curated catalog — ONLY rows a human marked Active=true. This is the
 * brand guard: an unfinished or retired row never renders on any surface.
 *
 * Posture mirrors the rest of the lib: getAllRecords owns the two-layer cache
 * and demo-mode gating (in demo mode the table has no fixtures → returns [],
 * which is exactly the "clean with zero products" behavior we want). We
 * fail-OPEN on any read error — an affiliate block is a nice-to-have, never a
 * reason to 500 a buyer's success page — returning [] so every surface renders
 * nothing rather than a dead block.
 */
export async function getGearCatalog(): Promise<GearProduct[]> {
  try {
    const rows = await getAllRecords(TABLES.RECOMMENDED_PRODUCTS);
    if (!Array.isArray(rows)) return [];
    // Defense in depth: filter Active here even though callers use selectGear
    // (which re-checks). A future non-selectGear consumer still gets curated
    // rows only. Airtable omits an unchecked checkbox field entirely, so a
    // falsy/absent Active === not active.
    return (rows as GearProduct[]).filter((p) => p && p.Active === true);
  } catch (e: any) {
    console.error('[gear] getGearCatalog failed (fail-open, returning []):', e?.message || e);
    return [];
  }
}

// ── Pure selection ─────────────────────────────────────────────────────────────

/**
 * Pick the products to surface for a buyer/placement. PURE — no I/O, fully
 * testable. Decision table (all filters ANDed, then a 3-key sort, then cap):
 *
 *   FILTER  active only ................ p.Active === true
 *   FILTER  stage ...................... Target Stage === stage OR 'any'/blank
 *   FILTER  cut ........................ Target Cuts includes cut, OR is empty
 *                                        (empty = universal, shows for all cuts);
 *                                        when cut === null, ONLY universal rows
 *   SORT 1  whole-cow freezer pin ...... cut === 'whole' → Freezer Mandatory
 *                                        rows FIRST (a whole cow needs a chest
 *                                        freezer before anything else)
 *   SORT 2  Sort Order ................. ascending (curator's hand-order)
 *   SORT 3  network ................... 'direct' before 'amazon' (push the
 *                                        higher-margin / mission brands up)
 *   CAP     limit ...................... default 4
 *
 * Empty/invalid input → []. Every surface renders nothing gracefully.
 */
export function selectGear(
  products: GearProduct[] | null | undefined,
  { cut, stage, limit = DEFAULT_LIMIT }: SelectGearOptions,
): GearProduct[] {
  if (!Array.isArray(products) || products.length === 0) return [];
  const cap = Math.floor(limit);
  if (!Number.isFinite(cap) || cap <= 0) return [];

  const filtered = products.filter((p) => {
    if (!p || p.Active !== true) return false;

    // Stage: match this stage OR the universal 'any'. A blank/absent stage is
    // treated as 'any' (a row the curator didn't scope shows in both moments).
    const targetStage = String(p['Target Stage'] || 'any').trim().toLowerCase();
    if (targetStage !== 'any' && targetStage !== stage) return false;

    // Cut: empty Target Cuts = universal (shows for every cut, and is the ONLY
    // thing shown when cut is unknown/null). Otherwise the buyer's cut must be
    // in the list.
    const cuts = Array.isArray(p['Target Cuts'])
      ? (p['Target Cuts'] as string[]).map((c) => String(c).trim().toLowerCase())
      : [];
    const universal = cuts.length === 0;
    if (cut === null) {
      if (!universal) return false;
    } else if (!universal && !cuts.includes(cut)) {
      return false;
    }

    return true;
  });

  const freezerFirst = cut === 'whole';
  const sorted = filtered.slice().sort((a, b) => {
    // SORT 1 — whole-cow: Freezer Mandatory pins to the very top.
    if (freezerFirst) {
      const af = a['Freezer Mandatory'] === true ? 0 : 1;
      const bf = b['Freezer Mandatory'] === true ? 0 : 1;
      if (af !== bf) return af - bf;
    }
    // SORT 2 — Sort Order ascending. Missing sort → +Infinity (sinks to the
    // bottom, but stays ahead of nothing else so it's deterministic).
    const ao = Number.isFinite(Number(a['Sort Order'])) ? Number(a['Sort Order']) : Number.POSITIVE_INFINITY;
    const bo = Number.isFinite(Number(b['Sort Order'])) ? Number(b['Sort Order']) : Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    // SORT 3 — direct before amazon (higher-margin / mission brands up).
    const an = String(a.Network || '').toLowerCase() === 'direct' ? 0 : 1;
    const bn = String(b.Network || '').toLowerCase() === 'direct' ? 0 : 1;
    return an - bn;
  });

  return sorted.slice(0, cap);
}

// ── Email compliance ───────────────────────────────────────────────────────────

/**
 * DROP Amazon-network products. CRITICAL COMPLIANCE: the Amazon Associates
 * Operating Agreement FORBIDS placing affiliate links in email. Any EMAIL
 * placement must pass its product list through this first — only direct-network
 * (our own mission-brand) links survive. Web placements use the full set.
 *
 * A missing/blank Network is treated as NON-Amazon (kept): direct is the
 * default, and the guard only exists to strip the one forbidden network.
 */
export function emailSafeGear(products: GearProduct[] | null | undefined): GearProduct[] {
  if (!Array.isArray(products)) return [];
  return products.filter((p) => String(p?.Network || '').trim().toLowerCase() !== 'amazon');
}
