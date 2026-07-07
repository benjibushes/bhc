// app/api/admin/products/route.ts
//
// GET — list Active low-ticket Rancher Products for the operator link tool.
// Admin-gated. Feeds the /admin/products "generate a checkout link" page so
// Ben can text a share-balker a jerky/box link in two taps.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAllRecords, TABLES } from '@/lib/airtable';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  let rows: any[] = [];
  try {
    rows = (await getAllRecords(TABLES.RANCHER_PRODUCTS)) as any[];
  } catch (e: any) {
    return NextResponse.json({ error: `products read failed: ${e?.message || 'unknown'}` }, { status: 502 });
  }

  const products = rows
    .filter((r) => r['Active'])
    .map((r) => {
      const display = Number(r['Display Price'] || 0);
      const base = Number(r['Rancher Base'] || 0);
      return {
        id: r.id,
        name: String(r['Product Name'] || ''),
        rancher: String(r['Rancher Name'] || ''),
        category: (r['Category'] && typeof r['Category'] === 'object' ? r['Category'].name : r['Category']) || '',
        tier: (r['Resistance Tier'] && typeof r['Resistance Tier'] === 'object' ? r['Resistance Tier'].name : r['Resistance Tier']) || '',
        displayPrice: display,
        rancherBase: base,
        margin: Math.max(0, display - base),
        shelfStable: !!r['Shelf Stable'],
        // Deposit-style truth (audit fix C-1.6): the operator must never text
        // a $95-355 range box as a plain $95 purchase.
        depositStyle: r['Deposit Style'] === true,
        priceRange: String(r['Price Range'] || ''),
      };
    })
    // Cheapest first — the impulse rungs the operator pushes to cold leads.
    .sort((a, b) => a.displayPrice - b.displayPrice);

  return NextResponse.json({ products });
}
