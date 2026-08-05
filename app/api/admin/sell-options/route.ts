// GET /api/admin/sell-options?state=XX — the operator sell console's menu.
//
// Ben is ON THE PHONE with a buyer. One call returns everything he can sell
// them right now, split by fulfillment reality:
//   ranchers        — CONNECT rail. Deposit-capable (tier_v2 + Connect active +
//               operational) ranchers with priced share tiers, each flagged
//               inState (home state or routing states cover the buyer) and/or
//               nationwide (Ships Nationwide) so the console can section
//               "in their state" vs "ships to them anyway".
//   brokerRanchers  — BROKER rail (docs/BUSINESS-MODEL.md model 3). See below.
//   products        — every sellable marketplace product (the isSellableRow
//               gate already guarantees nationwide-shippable), deposit-style
//               aware.
//
// WHY BROKER RANCHERS NEED THEIR OWN LIST (2026-08-03)
// ---------------------------------------------------
// A represented ranch is DELIBERATELY invisible to every platform predicate:
// isRancherOnConnect is false (no Connect account by definition) and
// isRancherOperationalForBuyers is false (Active Status is left empty on
// purpose — see the guardrails in lib/brokerRail). That is correct and must
// not be "fixed": those predicates gate routing, the marketplace, the map and
// the crons, none of which a represented ranch belongs in.
//
// But the operator DOES sell them — by phone, personally. So the console needs
// a SECOND pass over the same already-fetched rows, gated by the broker rail's
// own predicate instead. Same single Airtable read, no extra round trip.
//
// The two lists are never merged: they are different money models (Connect =
// buyer pays BHC's fee ON TOP and the rancher keeps 100% of price; broker =
// the deposit goes 100% to BHC and IS the commission, rancher collects
// price − deposit). The console renders them as separate, differently-labeled
// groups so the operator's rail choice is always explicit.
//
// Admin-gated. Read-only. The actual link minting is POST /api/admin/sell-links
// (deposits, both rails) and the existing POST /api/checkout/product (products).

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAllRecords, TABLES } from '@/lib/airtable';
import {
  isRancherOnConnect,
  isRancherOperationalForBuyers,
} from '@/lib/rancherEligibility';
import { deriveDeposit, MIN_TIER_PRICE } from '@/lib/pricing';
import { loadMarketplaceProducts } from '@/lib/marketplaceProducts';
import { CUT_LABELS, type Cut } from '@/lib/reserveDeposit';
import { assertBrokerEligible, isBrokerRancher } from '@/lib/brokerRail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TIER_FIELDS: { cut: Cut; field: string }[] = [
  { cut: 'quarter', field: 'Quarter Price' },
  { cut: 'half', field: 'Half Price' },
  { cut: 'whole', field: 'Whole Price' },
];

const ALL_CUTS: Cut[] = ['quarter', 'half', 'whole'];

// ---------------------------------------------------------------------------
// BROKER rail rows — pure, so the split is unit-testable without Airtable
// ---------------------------------------------------------------------------

export interface BrokerSellCut {
  cut: Cut;
  label: string;
  /** false → the console renders this cut DISABLED with `reason`, never a
   *  button that 400s at mint time. */
  sellable: boolean;
  /** The buyer's full share price. 0 when !sellable — never a guess. */
  price: number;
  /** Due today. Goes 100% to BHC and IS the commission. 0 when !sellable. */
  deposit: number;
  /** === deposit. Named for the console's "you keep $X" line so the operator
   *  money truth is read straight off the rail's own quote, not re-derived.
   *  EXACT in both pricing modes — the commission never rides the weight. */
  bhcKeeps: number;
  /** price − deposit. The ranch collects this direct; it is also its net. In
   *  WEIGHT-PRICED mode this is the LOW end of the collect range. */
  ranchCollects: number;
  /** WEIGHT-PRICED (range) mode — the cut's Max field is set above the floor,
   *  so the exact share price is set by hanging weight. The console renders
   *  "buyer price: $floor–$max (hanging weight)" and a collect range; the
   *  "you keep" line stays exact. When false, priceMax/ranchCollectsMax
   *  COLLAPSE to price/ranchCollects so the split invariant
   *  (bhcKeeps + ranchCollectsMax === priceMax) holds in both modes. */
  weightPriced: boolean;
  priceMax: number;
  ranchCollectsMax: number;
  /** assertBrokerEligible's message, VERBATIM, when !sellable. '' otherwise. */
  reason: string;
}

export interface BrokerSellRancher {
  /** Ranchers RECORD ID — a represented ranch has no slug by design, and the
   *  mint endpoint selects the broker rail by taking `rancherId`. */
  id: string;
  name: string;
  state: string;
  inState: boolean;
  cuts: BrokerSellCut[];
}

/**
 * Build one represented-ranch row for the console.
 *
 * Every per-cut number comes from assertBrokerEligible's quote — the SAME
 * helper the mint endpoint and settlement use — so the console can never show
 * a price/deposit/split that disagrees with what the buyer is actually charged.
 * In particular the deposit is never derived here (deriveDeposit is the Connect
 * rail's helper); on this rail a derived deposit would invent the commission.
 *
 * Unsellable cuts are RETURNED, not dropped: "no half price set" is exactly the
 * thing the operator needs to see and go fix.
 *
 * `inState` is home-state only. A represented ranch is excluded from routing,
 * so reading `Routing States` here would imply coverage semantics that do not
 * apply to it.
 */
export function buildBrokerSellRancher(rancher: any, state: string): BrokerSellRancher {
  const home = String(rancher?.['State'] || '').toUpperCase();
  const cuts: BrokerSellCut[] = ALL_CUTS.map((cut) => {
    const gate = assertBrokerEligible(rancher, cut);
    if (!gate.ok) {
      return {
        cut,
        label: CUT_LABELS[cut],
        sellable: false,
        price: 0,
        deposit: 0,
        bhcKeeps: 0,
        ranchCollects: 0,
        weightPriced: false,
        priceMax: 0,
        ranchCollectsMax: 0,
        reason: gate.error,
      };
    }
    const { priceCents, depositCents, balanceCents, weightPriced, priceMaxCents, balanceMaxCents } =
      gate.quote;
    return {
      cut,
      label: CUT_LABELS[cut],
      sellable: true,
      price: priceCents / 100,
      deposit: depositCents / 100,
      bhcKeeps: depositCents / 100,
      ranchCollects: balanceCents / 100,
      // WEIGHT-PRICED: ceilings from the quote; exact mode collapses them so
      // the console can always render priceMax/ranchCollectsMax safely.
      weightPriced,
      priceMax: (weightPriced && priceMaxCents ? priceMaxCents : priceCents) / 100,
      ranchCollectsMax: (weightPriced && balanceMaxCents ? balanceMaxCents : balanceCents) / 100,
      reason: '',
    };
  });

  return {
    id: String(rancher?.id || ''),
    name: String(rancher?.['Ranch Name'] || rancher?.['Operator Name'] || 'Represented ranch').trim(),
    state: home,
    inState: !!state && home === state,
    cuts,
  };
}

/**
 * Split the Ranchers table into the two sell rails. Pure.
 *
 * A row can only land in one list: the broker list is taken FIRST and the
 * Connect list explicitly excludes represented ranchers. That exclusion is
 * already implied (isRancherOnConnect / isRancherOperationalForBuyers both
 * return false for them, by design) — it is restated here as the greppable
 * belt lib/brokerRail asks every read boundary to wear, so a future eligibility
 * change can never leak a represented ranch onto the Connect rail's UI.
 */
export function splitSellRanchers(rows: any[]): { connect: any[]; broker: any[] } {
  const all = Array.isArray(rows) ? rows : [];
  const broker = all.filter((r) => isBrokerRancher(r) && r?.id);
  const connect = all.filter(
    (r) => !isBrokerRancher(r) && isRancherOnConnect(r) && isRancherOperationalForBuyers(r) && r?.['Slug'],
  );
  return { connect, broker };
}

export async function GET(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  const state = (new URL(request.url).searchParams.get('state') || '').trim().toUpperCase();

  let rows: any[] = [];
  try {
    rows = (await getAllRecords(TABLES.RANCHERS)) as any[];
  } catch (e: any) {
    return NextResponse.json({ error: `ranchers read failed: ${e?.message || 'unknown'}` }, { status: 502 });
  }

  const { connect: connectRows, broker: brokerRows } = splitSellRanchers(rows);

  const ranchers = connectRows
    .map((r) => {
      const tiers = TIER_FIELDS.map(({ cut, field }) => {
        const price = Number(r[field] || 0);
        // GTM-hardening F1: only surface tiers the redemption path will accept
        // (>= MIN_TIER_PRICE, NaN-safe) — the console must never show a
        // clickable tier that mints a bouncing link.
        return price >= MIN_TIER_PRICE
          ? { cut, label: CUT_LABELS[cut], price, deposit: deriveDeposit(price) }
          : null;
      }).filter(Boolean);
      // Coverage: home state, admin routing states, or legacy States Served —
      // same precedence the routing engine uses (Routing States first).
      const coverage = String(r['Routing States'] || r['States Served'] || '')
        .toUpperCase()
        .split(/[,\s]+/)
        .filter(Boolean);
      const home = String(r['State'] || '').toUpperCase();
      const inState = !!state && (home === state || coverage.includes(state));
      return {
        slug: String(r['Slug']),
        name: String(r['Ranch Name'] || r['Operator Name'] || 'Ranch').trim(),
        state: home,
        inState,
        nationwide: r['Ships Nationwide'] === true,
        tiers,
      };
    })
    .filter((r) => r.tiers.length > 0)
    // In-state first, then nationwide shippers, then the rest (operator can
    // still see everything — he's the router on this call).
    .sort((a, b) => Number(b.inState) - Number(a.inState) || Number(b.nationwide) - Number(a.nationwide));

  // BROKER rail — the second pass over the same rows. Represented ranches are
  // listed even when NO cut is currently sellable: an unpriced cut is exactly
  // what the operator needs to see and go set before Aug 10.
  const brokerRanchers = brokerRows
    .map((r) => buildBrokerSellRancher(r, state))
    .sort((a, b) => Number(b.inState) - Number(a.inState) || a.name.localeCompare(b.name));

  const products = await loadMarketplaceProducts();

  return NextResponse.json({ state, ranchers, brokerRanchers, products });
}
