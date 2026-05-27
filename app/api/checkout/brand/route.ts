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
// Graceful degradation: if a Price ID env var is missing for a tier BUT
// the legacy Payment Link env var (STRIPE_BRAND_LINK_*) is set, we fall
// back to the legacy redirect. This preserves any current revenue flow
// during the env var migration window — webhook still won't fire on the
// Payment Link path, but at least the purchase completes (better than
// dropping the buyer on /brand-partners#contact). Operator must populate
// Price ID env vars to fully close the leak.

const TIER_TO_PRICE_ENV: Record<string, string> = {
  spotlight: 'STRIPE_BRAND_PRICE_SPOTLIGHT',
  featured: 'STRIPE_BRAND_PRICE_FEATURED',
  founding: 'STRIPE_BRAND_PRICE_FOUNDING', // $1500 co-marketed tier
};

const TIER_TO_LEGACY_LINK_ENV: Record<string, string> = {
  spotlight: 'STRIPE_BRAND_LINK_SPOTLIGHT',
  featured: 'STRIPE_BRAND_LINK_FEATURED',
  founding: 'STRIPE_BRAND_LINK_COMARKETED',
};

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

  // ── Graceful fallback: if Price ID not configured but legacy Payment
  //    Link is, use the legacy Payment Link so we don't drop the buyer.
  //    NOTE: webhook will still skip this purchase because Payment Links
  //    don't forward metadata. Operator MUST set Price ID env var to
  //    fully fix the leak.
  if (!priceId) {
    const legacyLinkEnv = TIER_TO_LEGACY_LINK_ENV[tier];
    const legacyLink = legacyLinkEnv ? process.env[legacyLinkEnv] : undefined;
    if (legacyLink) {
      console.warn(
        `[checkout/brand] ${priceEnv} not set — falling back to legacy Payment Link (webhook will NOT fire). ` +
        `Set ${priceEnv} to a Stripe Price ID to close the metadata gap.`
      );
      return NextResponse.redirect(legacyLink, 302);
    }
    console.warn(`[checkout/brand] ${priceEnv} not set — falling back to /brand-partners#contact`);
    return NextResponse.redirect(new URL('/brand-partners#contact', url.origin), 302);
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
