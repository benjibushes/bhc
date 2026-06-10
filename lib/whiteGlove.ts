// lib/whiteGlove.ts
//
// F8 — $497 White Glove Onboarding upsell (feature-flagged).
//
// Decision D from spec: "$497 optional" — bundle Stripe Payment Link
// or full Checkout for ranchers who want Ben to personally handle
// their first 3 buyer matches end-to-end.
//
// Flag default: OFF. When ON, wizard Step 4 surfaces an opt-in
// checkbox + Stripe Checkout link.
//
// Env:
//   ENABLE_WHITE_GLOVE          — '1' to enable
//   WHITE_GLOVE_PRICE_CENTS     — default 49700 ($497)
//   STRIPE_SECRET_KEY           — already required
//
// On Stripe webhook checkout.session.completed:
//   metadata.type='white_glove' → stamp Ranchers.White Glove Paid At
//   + White Glove Session Id + send Telegram alert.

import Stripe from 'stripe';

export const WG_FEATURE_FLAG = 'ENABLE_WHITE_GLOVE';
export const WG_PRICE_DEFAULT_CENTS = 49700;

export function isWhiteGloveEnabled(): boolean {
  return process.env[WG_FEATURE_FLAG] === '1';
}

export function getWhiteGlovePriceCents(): number {
  const env = Number(process.env.WHITE_GLOVE_PRICE_CENTS);
  if (isNaN(env) || env <= 0) return WG_PRICE_DEFAULT_CENTS;
  return env;
}

export async function createWhiteGloveCheckoutSession(input: {
  rancherId: string;
  rancherEmail: string;
  ranchName: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string; sessionId: string } | null> {
  if (!isWhiteGloveEnabled()) return null;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.warn('[whiteGlove] STRIPE_SECRET_KEY missing — cannot create');
    return null;
  }

  const stripe = new Stripe(key);
  const cents = getWhiteGlovePriceCents();

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'White Glove Onboarding — BuyHalfCow',
          description: `One-time \$${(cents / 100).toFixed(0)} for Ben to personally handle your first 3 buyer matches end-to-end (qualification + Cal call + deposit + slot lock).`,
        },
        unit_amount: cents,
      },
      quantity: 1,
    }],
    customer_email: input.rancherEmail,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: {
      type: 'white_glove',
      rancher_id: input.rancherId,
      ranch_name: input.ranchName,
    },
    payment_intent_data: {
      metadata: {
        type: 'white_glove',
        rancher_id: input.rancherId,
      },
      description: `White Glove onboarding for ${input.ranchName}`,
    },
  });

  return { url: session.url || '', sessionId: session.id };
}

export function hasWhiteGlove(rancher: any): boolean {
  return Boolean(rancher && rancher['White Glove Paid At']);
}
