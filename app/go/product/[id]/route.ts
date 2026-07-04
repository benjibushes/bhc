// app/go/product/[id]/route.ts
//
// Affiliate-products click-tracking redirect (Move 1).
//
//   buyhalfcow.com/go/product/<recId>?buyer=&ref=&surface=
//     -> best-effort click log to Gear Clicks
//     -> 302 -> product['Affiliate URL']  (tag already baked in)
//
// Why a nested `product` segment: the existing /go/[code] route is the rancher
// setup short-link. A single dynamic segment there would collide with product
// ids; /go/product/<id> is unambiguous — Next matches the more specific static
// `product` segment before the [code] catch-all.
//
// Postures borrowed from the codebase:
//   - Unknown/missing product → 302 /gear (NEVER 404 — mirrors /go/[code]'s
//     redirect-home-on-miss; a buyer clicking a shop link should always land
//     somewhere useful, here the curated gear page).
//   - Click log is FIRE-AND-FORGET: it must NEVER block or throw the redirect
//     (same best-effort posture as the Meta CAPI fires). A logging failure
//     costs us one data point, never the buyer's click.
//   - In demo mode createRecord no-ops into the in-memory store automatically
//     (createRecord is demo-gated) — no special-casing needed here.

import { NextRequest, NextResponse } from 'next/server';
import { getRecordById, createRecord, TABLES } from '@/lib/airtable';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

// Airtable record ids are [a-zA-Z0-9] (with a rec prefix). Sanitize to that
// charset and cap length so nothing weird can reach getRecordById.
function cleanRecId(raw: string): string {
  return (raw || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
}

// Only the four known surfaces are logged; anything else falls back to 'gear'
// so the singleSelect never rejects an unexpected value.
const SURFACES = new Set(['success', 'member', 'email', 'gear']);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const productId = cleanRecId(id);

  // No usable id → the curated gear page (never a 404).
  if (!productId) return NextResponse.redirect(`${SITE_URL}/gear`, 302);

  let product: Record<string, any> | null = null;
  try {
    product = await getRecordById(TABLES.RECOMMENDED_PRODUCTS, productId);
  } catch (e: any) {
    console.error('[/go/product] lookup failed:', e?.message || e);
  }

  const affiliateUrl = String(product?.['Affiliate URL'] || '').trim();
  // Unknown product, inactive, or no destination URL → /gear. We do NOT gate on
  // Active here: a link minted while a product was live shouldn't 404 if the
  // curator later deactivates it — but a row with no Affiliate URL has no
  // destination, so it falls back to the browsable catalog.
  if (!product || !affiliateUrl) {
    return NextResponse.redirect(`${SITE_URL}/gear`, 302);
  }

  // Best-effort click log. Read attribution from the query string; omit the
  // link fields entirely when absent (an empty [] link write is harmless, but
  // omitting keeps the row clean). NEVER await-block the redirect on it.
  const buyerId = cleanRecId(request.nextUrl.searchParams.get('buyer') || '');
  const refId = cleanRecId(request.nextUrl.searchParams.get('ref') || '');
  const surfaceRaw = String(request.nextUrl.searchParams.get('surface') || '').toLowerCase();
  const surface = SURFACES.has(surfaceRaw) ? surfaceRaw : 'gear';
  const network = String(product['Network'] || '').toLowerCase() === 'amazon' ? 'amazon' : 'direct';

  const fields: Record<string, any> = {
    Product: [productId],
    Surface: surface,
    Network: network,
    'Clicked At': new Date().toISOString(),
  };
  if (buyerId) fields.Buyer = [buyerId];
  if (refId) fields.Referral = [refId];

  // Fire-and-forget: kick off the write, swallow any rejection, do NOT await.
  // If the event loop tears down before it lands we lose one click datapoint —
  // an acceptable trade against ever delaying/breaking the outbound redirect.
  try {
    void createRecord(TABLES.GEAR_CLICKS, fields).catch((e: any) => {
      console.error('[/go/product] click log failed (non-blocking):', e?.message || e);
    });
  } catch (e: any) {
    console.error('[/go/product] click log threw synchronously (ignored):', e?.message || e);
  }

  return NextResponse.redirect(affiliateUrl, 302);
}
