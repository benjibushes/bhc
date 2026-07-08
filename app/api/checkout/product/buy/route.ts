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
import { hasStock } from '@/lib/marketplaceProducts';
import { createProductCheckout } from '@/lib/productCheckout';
import { ensureStripePrice } from '@/lib/productStripeSync';
import { rateLimit } from '@/lib/rateLimit';
import { fireCapi, buildUserData, getMetaCookiesFromRequest } from '@/lib/metaCapi';

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
  // Audit fix C-5: mirror the isSellableRow shipping gate at CHARGE time. A
  // product explicitly un-checked for nationwide shipping is hidden from /shop
  // and 404s on its PDP — a stale/shared link must not be able to charge it
  // anyway (the rancher would get a paid ship-it order they marked
  // un-shippable). Blank counts as shippable, same as the marketplace gate.
  if (product['Ships Nationwide'] === false) {
    return NextResponse.json({ error: 'That product is unavailable.' }, { status: 404 });
  }
  // INVENTORY (Phase 11): sold-out is un-buyable at charge time too — an ad
  // click or stale link can never oversell a rancher's stock.
  if (!hasStock(product)) {
    return NextResponse.json({ error: 'That one just sold out — more coming.' }, { status: 409 });
  }

  const displayCents = Math.round(Number(product['Display Price'] || 0) * 100);
  const baseCents = Math.round(Number(product['Rancher Base'] || 0) * 100);
  if (!displayCents || !baseCents || baseCents > displayCents) {
    return NextResponse.json({ error: 'That product is not ready to sell yet.' }, { status: 409 });
  }
  // Shipping passthrough: buyer pays it, rancher keeps 100% of it. Deposit-style
  // products always 0 — shipping settles with the balance the rancher collects.
  const shippingCents =
    product['Deposit Style'] === true
      ? 0
      : Math.max(0, Math.round(Number(product['Shipping Cost'] || 0) * 100));

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

  // Whitelabel: the storefront requests { mode: 'embedded' } to render checkout
  // ON buyhalfcow.com. If it can't (no publishable key), it asks for hosted and
  // we return a redirect URL — checkout never breaks. Same direct charge either way.
  const wantEmbedded = body?.mode === 'embedded';

  try {
    const result = await createProductCheckout({
      rancherConnectAccountId: connectAccountId,
      productName: String(product['Product Name'] || 'Product'),
      displayCents,
      baseCents,
      // no buyerEmail — Stripe Checkout collects it self-serve
      stripePriceId,
      productId: product.id,
      rancherId,
      rancherName: String(product['Rancher Name'] || rancher['Ranch Name'] || 'the ranch'),
      // C-1.5: the flag rides PI metadata so settlement sends deposit-truthful
      // receipts + a "confirm BEFORE shipping" rancher email.
      depositStyle: product['Deposit Style'] === true,
      shippingCents,
      mode: wantEmbedded ? 'embedded' : 'hosted',
      returnUrl: `${SITE_URL}/order/success`,
      successUrl: `${SITE_URL}/order/success`,
      cancelUrl: `${SITE_URL}/order/cancelled`,
    });
    // ── Meta Conversions API: server-side InitiateCheckout ──────────────
    // Buyer started checkout for this product. Server fire survives ATT/adblock
    // and carries fbp/fbc from the request cookies (best match quality). Deduped
    // per checkout session so two different buyers of the same product each
    // count. content_ids=[productId] is what a Meta retargeting audience matches
    // on. Fire-and-forget — fireCapi fails open, never blocks the checkout.
    try {
      const capiIp = clientIp(request);
      const capiUserAgent = request.headers.get('user-agent') || undefined;
      const { fbp, fbc } = getMetaCookiesFromRequest(request);
      void fireCapi([{
        event_name: 'InitiateCheckout',
        event_time: Math.floor(Date.now() / 1000),
        event_id: `product_ic_${result.sessionId}`,
        action_source: 'website',
        event_source_url: `${SITE_URL}/shop/${product.id}`,
        user_data: buildUserData({ ip: capiIp, userAgent: capiUserAgent, fbp, fbc }),
        custom_data: {
          value: (displayCents + shippingCents) / 100,
          currency: 'usd',
          content_ids: [product.id],
          content_type: 'product',
          content_name: String(product['Product Name'] || 'Product'),
        },
      }]).catch(() => {});
    } catch { /* analytics only — never blocks checkout */ }

    if (wantEmbedded) {
      // connectAccountId is NOT a secret — the browser needs it to scope Stripe.js
      // to the connected account for the direct-charge embedded form.
      return NextResponse.json({ clientSecret: result.clientSecret, connectAccountId });
    }
    return NextResponse.json({ url: result.url });
  } catch (e: any) {
    console.error('[checkout/product/buy] session create failed:', e?.message);
    return NextResponse.json({ error: 'Could not start checkout. Try again.' }, { status: 502 });
  }
}
