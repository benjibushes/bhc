// app/api/checkout/product/route.ts
//
// LOW-TICKET PRODUCT checkout link generator (2026-07-06). The operator (Ben)
// POSTs {productId, buyerEmail} and gets back a Stripe Checkout URL to send a
// buyer who balked at a $2,000 share — "not ready for a whole cow? try a $25
// jerky / $170 box." Full charge, BHC margin skimmed as the application fee,
// order lands in the rancher's fulfillment queue on payment. Admin-gated: only
// the operator mints these (public buy-buttons on the rancher page come later).

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getRecordById, getAllRecords, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { createProductCheckout } from '@/lib/productCheckout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export async function POST(request: Request) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const productId = String(body?.productId || '').trim();
  const buyerEmail = String(body?.buyerEmail || '').trim().toLowerCase();
  const buyerName = String(body?.buyerName || '').trim();
  if (!productId || !buyerEmail || !buyerEmail.includes('@')) {
    return NextResponse.json({ error: 'productId and a valid buyerEmail are required' }, { status: 400 });
  }

  // Product — accept a record id, or resolve by exact name for convenience.
  let product: any = null;
  if (/^rec[A-Za-z0-9]{14}$/.test(productId)) {
    product = await getRecordById(TABLES.RANCHER_PRODUCTS, productId).catch(() => null);
  }
  if (!product) {
    const byName = await getAllRecords(
      TABLES.RANCHER_PRODUCTS,
      `{Product Name} = "${escapeAirtableValue(productId)}"`,
    ).catch(() => []);
    product = Array.isArray(byName) && byName[0] ? byName[0] : null;
  }
  if (!product) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 });
  }
  if (!product['Active']) {
    return NextResponse.json({ error: 'Product is not active (out of stock / hidden)' }, { status: 409 });
  }

  const displayCents = Math.round(Number(product['Display Price'] || 0) * 100);
  const baseCents = Math.round(Number(product['Rancher Base'] || 0) * 100);
  if (!displayCents || !baseCents) {
    return NextResponse.json({ error: 'Product is missing Display Price or Rancher Base' }, { status: 409 });
  }
  if (baseCents > displayCents) {
    return NextResponse.json({ error: 'Rancher Base exceeds Display Price — fix the margin before selling' }, { status: 409 });
  }

  // Rancher — must be Connect-active to take a direct charge.
  const rancherId = String(product['Rancher Record ID'] || '').trim();
  const rancher: any = rancherId ? await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null) : null;
  if (!rancher) {
    return NextResponse.json({ error: 'Product has no linked rancher' }, { status: 409 });
  }
  if (String(rancher['Stripe Connect Status'] || '') !== 'active') {
    return NextResponse.json({ error: 'Rancher Stripe Connect is not active — cannot take a charge' }, { status: 409 });
  }
  const connectAccountId = String(rancher['Stripe Connect Account Id'] || '').trim();
  if (!connectAccountId) {
    return NextResponse.json({ error: 'Rancher Stripe Connect Account missing' }, { status: 409 });
  }

  try {
    const { url } = await createProductCheckout({
      rancherConnectAccountId: connectAccountId,
      productName: String(product['Product Name'] || 'Product'),
      displayCents,
      baseCents,
      buyerEmail,
      buyerName: buyerName || undefined,
      productId: product.id,
      rancherId,
      rancherName: String(product['Rancher Name'] || rancher['Ranch Name'] || 'the ranch'),
      successUrl: `${SITE_URL}/order/success`,
      cancelUrl: `${SITE_URL}/order/cancelled`,
    });
    return NextResponse.json({
      url,
      product: product['Product Name'],
      buyerPays: displayCents / 100,
      yourMargin: (displayCents - baseCents) / 100,
    });
  } catch (e: any) {
    console.error('[checkout/product] session create failed:', e?.message);
    return NextResponse.json({ error: `Could not create checkout: ${e?.message || 'unknown'}` }, { status: 502 });
  }
}
