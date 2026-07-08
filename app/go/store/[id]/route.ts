// app/go/store/[id]/route.ts
//
// Path note: /go/[code] = rancher setup short-links, /go/product/[id] = the
// affiliate GEAR redirect — this one is the rancher's OWN-STORE passthrough.
//
// EXTERNAL CHECKOUT PASSTHROUGH (BYOC Tier 2, 2026-07-08). A rancher who
// already sells a product on their own store (Shopify, Square, anything)
// pastes that link into the product editor; buyer-facing cards link HERE,
// we stamp the click for attribution truth, then 302 to their store.
//
// SECURITY: the destination comes ONLY from the Airtable record (rancher-
// entered, URL-validated at save) — never from a query param, so this can't
// be used as an open redirect. Only http(s) destinations pass.
//
// The click stamp is best-effort fire-and-forget: attribution must never
// block or slow the buyer's path to the rancher's store.

import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) {
    return NextResponse.redirect(new URL('/shop', 'https://www.buyhalfcow.com'), 302);
  }
  let r: any = null;
  try {
    r = await getRecordById(TABLES.RANCHER_PRODUCTS, id);
  } catch { /* fall through to /shop */ }

  const raw = String(r?.['External Checkout URL'] || '').trim();
  let dest: URL | null = null;
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') dest = u;
  } catch { /* invalid/missing URL → PDP fallback */ }

  if (!dest) {
    // No external store on file (or bad URL) → the product's own PDP.
    return NextResponse.redirect(new URL(`/shop/${id}`, 'https://www.buyhalfcow.com'), 302);
  }

  // Attribution stamp — count + last-clicked, tolerant of missing fields.
  try {
    const clicks = Number(r?.['External Clicks'] || 0);
    await updateRecord(TABLES.RANCHER_PRODUCTS, id, {
      'External Clicks': clicks + 1,
      'Last External Click At': new Date().toISOString(),
    } as any);
  } catch { /* attribution is best-effort, never blocks the buyer */ }

  return NextResponse.redirect(dest.toString(), 302);
}
