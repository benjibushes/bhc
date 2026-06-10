// lib/reservationHold.ts
//
// F7 — $49 Reservation Hold (feature-flagged).
//
// Decision B from spec: "No deposit but we should be able to flip to
// deposit lock spot feature when needed."
//
// Flag default: OFF. When ON:
//   - Cal book CTA on /qualify result requires $49 hold first
//   - Hold = 100% refundable until rancher accepts slot
//   - Filters tire-kickers, reduces no-show calls, creates float
//
// Env:
//   ENABLE_RESERVATION_HOLD          — '1' to enable, anything else off
//   RESERVATION_HOLD_PRICE_CENTS     — default 4900 ($49)
//   STRIPE_SECRET_KEY                — already required
//
// Stripe Checkout metadata:
//   consumerId, hold_for: 'cal_booking', referrer: 'qualify'
//
// On stripe.webhook checkout.session.completed: stamps
// Consumer.Reservation Hold Paid At + Reservation Hold Session Id.

import Stripe from 'stripe';

export const HOLD_FEATURE_FLAG = 'ENABLE_RESERVATION_HOLD';
export const HOLD_PRICE_DEFAULT_CENTS = 4900;

export function isReservationHoldEnabled(): boolean {
  return process.env[HOLD_FEATURE_FLAG] === '1';
}

export function getHoldPriceCents(): number {
  const env = Number(process.env.RESERVATION_HOLD_PRICE_CENTS);
  if (isNaN(env) || env <= 0) return HOLD_PRICE_DEFAULT_CENTS;
  return env;
}

/**
 * Create a Stripe Checkout session for the $49 hold.
 * Returns null if feature disabled or Stripe not configured.
 *
 * The hold is captured as a one-time payment, NOT pre-auth — we
 * keep it simple and refund on slot-cancel via the existing refund
 * endpoint. Capture-later would require manual capture + risks
 * expiry; simpler is better at MVP.
 */
export async function createHoldCheckoutSession(input: {
  consumerId: string;
  consumerEmail: string;
  buyerName: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string; sessionId: string } | null> {
  if (!isReservationHoldEnabled()) return null;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.warn('[reservationHold] STRIPE_SECRET_KEY missing — cannot create hold');
    return null;
  }

  const stripe = new Stripe(key);
  const cents = getHoldPriceCents();

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'Reservation Hold — BuyHalfCow',
          description: `Refundable $${(cents / 100).toFixed(0)} hold to book your call with Ben. Refunded if no match.`,
        },
        unit_amount: cents,
      },
      quantity: 1,
    }],
    customer_email: input.consumerEmail,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: {
      type: 'reservation_hold',
      consumer_id: input.consumerId,
      buyer_name: input.buyerName,
      referrer: 'qualify',
    },
    payment_intent_data: {
      metadata: {
        type: 'reservation_hold',
        consumer_id: input.consumerId,
      },
      description: `Reservation hold for ${input.buyerName} (${input.consumerEmail})`,
    },
  });

  return { url: session.url || '', sessionId: session.id };
}

/**
 * Whether a Consumer record has paid the hold (field stamped by webhook).
 * Used by Cal booking gate + intro email branching.
 */
export function hasReservationHold(consumer: any): boolean {
  if (!isReservationHoldEnabled()) return true; // flag off = no gate
  return Boolean(consumer && consumer['Reservation Hold Paid At']);
}
