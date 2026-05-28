import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Brand partner tier checkout — creates a Stripe Checkout Session with
// explicit metadata.type='brand-partner-tier' so the webhook can dedupe,
// upsert BRANDS row, send welcome email, fire Telegram alert, and log
// the funnel event.
//
// Why a Checkout Session (and not the Payment Link redirect we had before)?
//   Audit F1 (2026-05-26): Payment Links forward NO metadata to webhooks
//   unless explicitly configured in the Stripe Dashboard. The old version
//   redirected to STRIPE_BRAND_LINK_SPOTLIGHT etc. — Stripe received the
//   payment, fired `checkout.session.completed`, the webhook switch saw
//   `metadata.type === undefined`, and money landed in Stripe with ZERO
//   Airtable rows, no welcome email, and no funnel event. Critical $$$ leak.
//
//   Checkout Sessions created in code carry whatever metadata we stamp,
//   guaranteed end-to-end. We control the contract.
//
// Required env vars (one per tier):
//   STRIPE_BRAND_PRICE_SPOTLIGHT  — price_* id for the $295 tier
//   STRIPE_BRAND_PRICE_FEATURED   — price_* id for the $595 tier
//   STRIPE_BRAND_PRICE_FOUNDING   — price_* id for the $1500 tier
//
// Hard requirement: each tier MUST resolve to a Stripe Price ID. We used
// to silently fall back to a legacy Payment Link (STRIPE_BRAND_LINK_*) if
// the Price ID env var was missing — but Payment Links don't forward
// metadata, so the webhook never fired, and money landed in Stripe with
// zero Airtable / welcome email / Telegram side effects (the F1 revenue
// leak). The fallback is removed. If a tier's Price ID is unset, we hard-
// error to /brand-partners?error=tier-not-configured so the operator sees
// the misconfiguration loudly instead of bleeding revenue silently.

const TIER_TO_PRICE_ENV: Record<string, string> = {
  spotlight: 'STRIPE_BRAND_PRICE_SPOTLIGHT',
  featured: 'STRIPE_BRAND_PRICE_FEATURED',
  founding: 'STRIPE_BRAND_PRICE_FOUNDING', // $1500 co-marketed tier
};

// (Removed) TIER_TO_LEGACY_LINK_ENV — see header note above. Legacy
// STRIPE_BRAND_LINK_* env vars are intentionally no longer consulted; the
// Payment Link path bypassed the webhook and broke attribution. Keep them
// unset / delete from prod env to avoid confusion.

const TIER_NAMES: Record<string, string> = {
  spotlight: 'Spotlight',
  featured: 'Featured',
  founding: 'Co-marketed',
};

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tier = (url.searchParams.get('tier') || '').toLowerCase();

  const priceEnv = TIER_TO_PRICE_ENV[tier];
  if (!priceEnv) {
    return NextResponse.redirect(new URL('/brand-partners#contact', url.origin), 302);
  }

  const priceId = process.env[priceEnv];

  // ── HARD ERROR if Price ID not configured ──
  //    Previously we fell back to the legacy Payment Link, but that path
  //    bypassed the webhook (Payment Links don't forward metadata) and
  //    silently leaked revenue. Now we surface the misconfiguration to
  //    the buyer with a recoverable error param and log loudly so ops
  //    notice immediately.
  if (!priceId) {
    console.error(
      `[checkout/brand] ${priceEnv} not set — refusing to fall back to legacy Payment Link (silent webhook failure risk).`,
    );
    return NextResponse.redirect(new URL('/brand-partners?error=tier-not-configured', url.origin), 302);
  }

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create(
      {
        // Brand partner Prices are RECURRING (monthly/quarterly subscriptions),
        // not one-time. Spotlight $99/mo, Featured $499/mo, Co-marketed
        // $2500/3mo. Mode must match the Price type.
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${SITE_URL}/brand-partners?paid=1&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_URL}/brand-partners?cancelled=1`,
        // CRITICAL: webhook keys off metadata.type='brand-partner-tier' to
        // find the handler. Subscription metadata propagates onto the
        // initial checkout.session.completed event so the webhook fires
        // correctly.
        metadata: {
          type: 'brand-partner-tier',
          tier,
          tier_name: TIER_NAMES[tier] || tier,
        },
        subscription_data: {
          metadata: {
            type: 'brand-partner-tier',
            tier,
          },
        },
        // We don't collect a customer_email up front — Stripe Checkout
        // collects it on the hosted page, which then surfaces on
        // session.customer_details.email in the webhook payload.
        billing_address_collection: 'auto',
        // Allow promo codes — discount levers stay in the Stripe dashboard
        // without code changes.
        allow_promotion_codes: true,
        automatic_tax: { enabled: true },
        customer_update: { address: 'auto' },
        tax_id_collection: { enabled: true },
      },
      {
        idempotencyKey: `brand-tier-${tier}-${Date.now()}`,
      },
    );

    if (!session.url) {
      console.error('[checkout/brand] Stripe session has no url for tier', tier);
      return NextResponse.redirect(new URL('/brand-partners?error=session-failed', url.origin), 302);
    }

    return NextResponse.redirect(session.url, 303);
  } catch (e: any) {
    console.error(`[checkout/brand] Stripe error for tier=${tier}:`, e?.message || e);
    return NextResponse.redirect(new URL('/brand-partners?error=checkout-failed', url.origin), 302);
  }
}
