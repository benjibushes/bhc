// app/api/checkout/product/intent/route.ts
//
// BRAND-OWNED CHECKOUT mint endpoint (Payment Element migration — spec:
// docs/CHECKOUT-PAYMENT-ELEMENT-SPEC.md §3). The on-domain PaymentForm calls
// this at PAY-CLICK (deferred intent): every purchase gate re-runs seconds
// before the charge, then a raw PaymentIntent is minted on the rancher's
// connected account. Public, so it's rate-limited and NEVER accepts a price
// from the client — all money derives from the trusted Rancher Products row;
// expectedTotalCents is only an equality check so a price edit mid-session
// surfaces as an honest "price updated" instead of a surprise charge.

import { NextResponse } from 'next/server';
import { resolveProductPurchase } from '@/lib/productBuyGates';
import { createProductPaymentIntent } from '@/lib/productPaymentIntent';
import { ensureApplePayDomains } from '@/lib/applePayDomain';
import { isDemoMode } from '@/lib/demo/demoMode';
import { rateLimit } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for') || '';
  return xff.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}

export async function POST(request: Request) {
  // Same budget as the session mint: generous for a human, tight for a script.
  const rl = await rateLimit(`product-intent:${clientIp(request)}`, { requests: 12, window: '1m' });
  if (!rl.ok) {
    return NextResponse.json({ error: 'Too many attempts — wait a minute and try again.' }, { status: 429 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const attemptId = String(body?.attemptId || '').trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(attemptId)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const email = String(body?.email || '').trim().toLowerCase();
  if (email && (!email.includes('@') || email.length > 200)) {
    return NextResponse.json({ error: 'that email doesn\'t look right — check it and try again.' }, { status: 400 });
  }

  // ALL purchase gates — shared with the session route via resolveProductPurchase.
  const resolved = await resolveProductPurchase({
    productId: String(body?.productId || ''),
    quantity: Number(body?.quantity || 1),
  });
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  // Price-drift check (spec R4): the wallet sheet / pay button showed the
  // page-load total. If Airtable changed mid-session, 409 with the new truth
  // instead of charging a number the buyer never saw.
  const expected = Number(body?.expectedTotalCents || 0);
  if (expected > 0 && expected !== resolved.totalCents) {
    return NextResponse.json(
      { error: 'price_changed', message: 'the price was just updated — refresh to see the current total. nothing was charged.', totalCents: resolved.totalCents },
      { status: 409 },
    );
  }

  // DEMO MODE: no Stripe call — client redirects to the demo surface.
  if (isDemoMode()) {
    return NextResponse.json({ demoUrl: '/checkout/DEMO/product' });
  }

  // Wallets (PR D): register our payment-method domains on this rancher's
  // account so Apple Pay renders. Fire-and-forget — never blocks the mint;
  // an unvalidated domain silently degrades to card-only.
  void ensureApplePayDomains({
    id: resolved.rancherId,
    connectAccountId: resolved.connectAccountId,
    alreadyRegistered: resolved.rancher['Apple Pay Domain Registered'] === true,
  }).catch(() => {});

  try {
    const { clientSecret, totalCents } = await createProductPaymentIntent({
      rancherConnectAccountId: resolved.connectAccountId,
      productId: resolved.product.id,
      productName: resolved.productName,
      rancherId: resolved.rancherId,
      rancherName: resolved.rancherName,
      displayCents: resolved.displayCents,
      baseCents: resolved.baseCents,
      shippingCents: resolved.shippingCents,
      quantity: resolved.quantity,
      depositStyle: resolved.depositStyle,
      localOnly: resolved.localOnly,
      buyerEmail: email,
      attemptId,
    });
    // connectAccountId is NOT a secret — the browser needs it to scope
    // Stripe.js to the connected account for the direct-charge confirm.
    return NextResponse.json({ clientSecret, totalCents, connectAccountId: resolved.connectAccountId });
  } catch (e: any) {
    console.error('[checkout/product/intent] mint failed:', e?.message);
    return NextResponse.json({ error: 'Could not start checkout. Try again.' }, { status: 502 });
  }
}
