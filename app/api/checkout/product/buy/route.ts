// app/api/checkout/product/buy/route.ts
//
// PUBLIC self-serve product checkout (2026-07-06). The storefront "Buy" button
// POSTs { productId } here — no auth, no email needed. We mint the Stripe
// Checkout Session and return its URL; the buyer lands on Stripe's hosted page
// which collects email + shipping address + card. Fast, simple, two taps.
//
// Distinct from the admin /api/checkout/product (operator-generated links). This
// one is public, so it's rate-limited and never accepts a price from the client
// — all money comes from the trusted Rancher Products row.

import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { createProductCheckout } from '@/lib/productCheckout';
import { ensureStripePrice } from '@/lib/productStripeSync';
import { rateLimit } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for') || '';
  return xff.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}

export async function POST(request: Request) {
  // Rate limit — public endpoint. 12 checkout starts / min / IP is generous for
  // a human, tight enough to stop a script minting sessions in a loop.
  const rl = await rateLimit(`product-buy:${clientIp(request)}`, { requests: 12, window: '1m' });
  if (!rl.ok) {
    return NextResponse.json({ error: 'Too many attempts — wait a minute and try again.' }, { status: 429 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const productId = String(body?.productId || '').trim();
  if (!/^rec[A-Za-z0-9]{14}$/.test(productId)) {
    return NextResponse.json({ error: 'Invalid product' }, { status: 400 });
  }

  const product: any = await getRecordById(TABLES.RANCHER_PRODUCTS, productId).catch(() => null);
  if (!product || !product['Active']) {
    return NextResponse.json({ error: 'That product is unavailable.' }, { status: 404 });
  }

  const displayCents = Math.round(Number(product['Display Price'] || 0) * 100);
  const baseCents = Math.round(Number(product['Rancher Base'] || 0) * 100);
  if (!displayCents || !baseCents || baseCents > displayCents) {
    return NextResponse.json({ error: 'That product is not ready to sell yet.' }, { status: 409 });
  }

  const rancherId = String(product['Rancher Record ID'] || '').trim();
  const rancher: any = rancherId ? await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null) : null;
  if (!rancher || String(rancher['Stripe Connect Status'] || '') !== 'active') {
    return NextResponse.json({ error: 'That ranch can\'t take orders right now.' }, { status: 409 });
  }
  const connectAccountId = String(rancher['Stripe Connect Account Id'] || '').trim();
  if (!connectAccountId) {
    return NextResponse.json({ error: 'That ranch can\'t take orders right now.' }, { status: 409 });
  }

  // Ensure the Stripe Product+Price on the connected account (mint-on-first-sell).
  let stripePriceId: string | undefined;
  try {
    const sync = await ensureStripePrice({
      productRecordId: product.id,
      productName: String(product['Product Name'] || 'Product'),
      displayCents,
      connectAccountId,
      existingProductId: String(product['Stripe Product Id'] || '').trim() || undefined,
      existingPriceId: String(product['Stripe Price Id'] || '').trim() || undefined,
      existingPriceCents: Number(product['Stripe Price Cents'] || 0) || undefined,
    });
    stripePriceId = sync.priceId;
    if (sync.changed) {
      updateRecord(TABLES.RANCHER_PRODUCTS, product.id, {
        'Stripe Product Id': sync.productId,
        'Stripe Price Id': sync.priceId,
        'Stripe Price Cents': sync.priceCents,
      }).catch(() => {});
    }
  } catch { /* fall back to inline price */ }

  try {
    const { url } = await createProductCheckout({
      rancherConnectAccountId: connectAccountId,
      productName: String(product['Product Name'] || 'Product'),
      displayCents,
      baseCents,
      // no buyerEmail — Stripe Checkout collects it self-serve
      stripePriceId,
      productId: product.id,
      rancherId,
      rancherName: String(product['Rancher Name'] || rancher['Ranch Name'] || 'the ranch'),
      successUrl: `${SITE_URL}/order/success`,
      cancelUrl: `${SITE_URL}/order/cancelled`,
    });
    return NextResponse.json({ url });
  } catch (e: any) {
    console.error('[checkout/product/buy] session create failed:', e?.message);
    return NextResponse.json({ error: 'Could not start checkout. Try again.' }, { status: 502 });
  }
}
