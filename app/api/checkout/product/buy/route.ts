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
import { updateRecord, TABLES } from '@/lib/airtable';
import { resolveProductPurchase } from '@/lib/productBuyGates';
import { createProductCheckout } from '@/lib/productCheckout';
import { ensureStripePrice } from '@/lib/productStripeSync';
import { rateLimitStrict, getTrustedClientIp } from '@/lib/rateLimit';
import { fireCapi, buildUserData, getMetaCookiesFromRequest } from '@/lib/metaCapi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export async function POST(request: Request) {
  // Rate limit — public endpoint. 12 checkout starts / min / IP is generous for
  // a human, tight enough to stop a script minting sessions in a loop.
  const rl = await rateLimitStrict(`product-buy:${getTrustedClientIp(request)}`, { requests: 12 });
  if (!rl.ok) {
    return NextResponse.json({ error: 'Too many attempts — wait a minute and try again.' }, { status: 429 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  // ALL purchase gates live in the shared resolver (Payment Element PR A) —
  // this route and /api/checkout/product/intent can never drift.

  // Consent (checkout audit 2026-07-14): the charge relies on the written
  // shipping/refund/perishable policy at /promise. The client sends
  // consent:true only after the buyer acknowledges it — enforce server-side
  // so a hand-crafted request can't skip the disclosure.
  if (body?.consent !== true) {
    return NextResponse.json({ error: 'consent required — agree to the shipping & refund policy.' }, { status: 400 });
  }

  const resolved = await resolveProductPurchase({
    productId: String(body?.productId || ''),
    quantity: Number(body?.quantity || 1),
  });
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const { product, connectAccountId, rancherId, displayCents, baseCents, shippingCents, quantity } = resolved;

  // Wallets (PR D): same lazy registration on the session path, so hosted/
  // embedded Checkout buyers grow Apple Pay too. Fire-and-forget.
  const { ensureApplePayDomains } = await import('@/lib/applePayDomain');
  void ensureApplePayDomains({
    id: rancherId,
    connectAccountId,
    alreadyRegistered: resolved.rancher['Apple Pay Domain Registered'] === true,
  }).catch(() => {});

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
      rancherName: resolved.rancherName,
      // C-1.5: the flag rides PI metadata so settlement sends deposit-truthful
      // receipts + a "confirm BEFORE shipping" rancher email.
      depositStyle: product['Deposit Style'] === true,
      localOnly: resolved.localOnly,
      shippingCents,
      quantity,
      mode: wantEmbedded ? 'embedded' : 'hosted',
      returnUrl: `${SITE_URL}/order/success`,
      successUrl: `${SITE_URL}/order/success`,
      cancelUrl: `${SITE_URL}/order/cancelled?pid=${product.id}`,
    });
    // ── Meta Conversions API: server-side InitiateCheckout ──────────────
    // Buyer started checkout for this product. Server fire survives ATT/adblock
    // and carries fbp/fbc from the request cookies (best match quality). Deduped
    // per checkout session so two different buyers of the same product each
    // count. content_ids=[productId] is what a Meta retargeting audience matches
    // on. Fire-and-forget — fireCapi fails open, never blocks the checkout.
    try {
      const capiIp = getTrustedClientIp(request);
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
          value: (displayCents * quantity + shippingCents) / 100,
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
