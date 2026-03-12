import Stripe from 'stripe';

// Lazy-init Stripe so builds succeed without STRIPE_SECRET_KEY
let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
    _stripe = new Stripe(key, { apiVersion: '2026-02-25.clover' });
  }
  return _stripe;
}

// Brand listing fee — configurable via env
export const BRAND_LISTING_PRICE_CENTS = parseInt(process.env.BRAND_LISTING_PRICE_CENTS || '29900'); // $299 default
export const BRAND_LISTING_PRICE_LABEL = `$${(BRAND_LISTING_PRICE_CENTS / 100).toFixed(0)}`;
