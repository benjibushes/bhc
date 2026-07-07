// GET /api/admin/sell-options?state=XX — the operator sell console's menu.
//
// Ben is ON THE PHONE with a buyer. One call returns everything he can sell
// them right now, split by fulfillment reality:
//   ranchers  — deposit-capable (tier_v2 + Connect active + operational)
//               ranchers with priced share tiers, each flagged inState
//               (home state or routing states cover the buyer) and/or
//               nationwide (Ships Nationwide) so the console can section
//               "in their state" vs "ships to them anyway".
//   products  — every sellable marketplace product (the isSellableRow gate
//               already guarantees nationwide-shippable), deposit-style aware.
//
// Admin-gated. Read-only. The actual link minting is POST /api/admin/sell-links
// (deposits) and the existing POST /api/checkout/product (products).

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAllRecords, TABLES } from '@/lib/airtable';
import {
  isRancherOnConnect,
  isRancherOperationalForBuyers,
} from '@/lib/rancherEligibility';
import { deriveDeposit } from '@/lib/pricing';
import { loadMarketplaceProducts } from '@/lib/marketplaceProducts';
import { CUT_LABELS, type Cut } from '@/lib/reserveDeposit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TIER_FIELDS: { cut: Cut; field: string }[] = [
  { cut: 'quarter', field: 'Quarter Price' },
  { cut: 'half', field: 'Half Price' },
  { cut: 'whole', field: 'Whole Price' },
];

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

  const ranchers = rows
    .filter((r) => isRancherOnConnect(r) && isRancherOperationalForBuyers(r) && r['Slug'])
    .map((r) => {
      const tiers = TIER_FIELDS.map(({ cut, field }) => {
        const price = Number(r[field] || 0);
        return price > 0 ? { cut, label: CUT_LABELS[cut], price, deposit: deriveDeposit(price) } : null;
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

  const products = await loadMarketplaceProducts();

  return NextResponse.json({ state, ranchers, products });
}
