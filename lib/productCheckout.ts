// lib/productCheckout.ts
//
// LOW-TICKET PRODUCT RAIL (2026-07-06) — the ship-nationwide, low-resistance
// offer (jerky/sticks/boxes). Same money model as the deposit, one gear
// simpler: a FULL one-time charge (no deposit, no fulfillment balance).
//
//   buyer pays  = Display Price          (fee-invisible, one number)
//   rancher nets = Rancher Base          (routed to their Connect account)
//   BHC margin  = Display − Base         (skimmed as the Stripe application fee)
//
// Stripe Connect DIRECT charge on the rancher's account + application_fee_amount
// = margin. Identical mechanic to createDepositCheckout — the buyer's card is
// charged the full display price into the rancher's account, Stripe transfers
// the application fee to the BHC platform account. Rancher ships; BHC keeps the
// spread and owns the order.

import { getStripeClient } from '@/lib/stripeConnect';
import { isDemoMode } from '@/lib/demo/demoMode';

export interface ProductChargeInput {
  /** What the buyer pays, in cents (the fee-invisible Display Price). */
  displayCents: number;
  /** What the rancher nets, in cents (Rancher Base). */
  baseCents: number;
}

export interface ProductCharge {
  totalChargedCents: number;   // buyer pays this
  applicationFeeCents: number; // BHC margin
  rancherNetCents: number;     // rancher receives this
}

/**
 * Pure money math for a low-ticket product charge. Validates the invariant
 * that keeps the platform safe: the base must be a positive amount no greater
 * than the display price, so the margin (fee) is always in [0, display).
 * Throws on invalid input — a bad product must NEVER reach Stripe.
 */
export function computeProductCharge(input: ProductChargeInput): ProductCharge {
  const display = Math.round(Number(input.displayCents));
  const base = Math.round(Number(input.baseCents));
  if (!Number.isFinite(display) || display <= 0) {
    throw new Error(`invalid display price: ${input.displayCents}`);
  }
  if (!Number.isFinite(base) || base <= 0) {
    throw new Error(`invalid rancher base: ${input.baseCents}`);
  }
  if (base > display) {
    throw new Error(`rancher base (${base}) exceeds display price (${display}) — margin would be negative`);
  }
  const applicationFeeCents = display - base;
  return {
    totalChargedCents: display,
    applicationFeeCents,
    rancherNetCents: base,
  };
}

export interface CreateProductCheckoutInput {
  rancherConnectAccountId: string; // acct_* — direct-charge target
  productName: string;
  displayCents: number;            // buyer pays
  baseCents: number;               // rancher nets
  // Optional: prefilled for operator-generated links; OMITTED for self-serve
  // storefront buys — Stripe Checkout collects the email itself, and the
  // webhook falls back to the charge's billing email.
  buyerEmail?: string;
  buyerName?: string;
  productId: string;               // Rancher Products record id (webhook lookup)
  rancherId: string;               // Ranchers record id
  rancherName: string;
  successUrl: string;
  cancelUrl: string;
  // PRODUCTS-IN-STRIPE (2026-07-06): when set, the line item references this
  // real Stripe Price (created on the connected account by ensureStripePrice)
  // instead of an inline price_data. The margin (application_fee) is unchanged.
  // Omitted → falls back to inline price_data (demo / not-yet-synced).
  stripePriceId?: string;
}

/**
 * Create the Stripe Connect direct-charge Checkout Session for a low-ticket
 * product. Collects the shipping address (the rancher ships it) but adds NO
 * shipping line — the catalog Display Price is all-in (Silverline's per-lb
 * price already covers shipping; other ranchers set an all-in Display Price).
 * metadata.type = 'product_purchase' routes the webhook to settleProductPurchase.
 */
export async function createProductCheckout(
  input: CreateProductCheckoutInput,
): Promise<{ url: string; sessionId: string }> {
  const charge = computeProductCharge({ displayCents: input.displayCents, baseCents: input.baseCents });

  // DEMO MODE (local only) — never true in prod. No Stripe call.
  if (isDemoMode()) {
    return { url: '/checkout/DEMO/product', sessionId: 'cs_DEMO_product' };
  }

  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      // Prefill for operator links; omit for self-serve (Stripe collects it).
      ...(input.buyerEmail ? { customer_email: input.buyerEmail } : {}),
      // Rancher ships → we must collect where. No shipping_options: the
      // Display Price is all-in, so we don't add a separate shipping charge.
      shipping_address_collection: { allowed_countries: ['US'] },
      // Prefer a real Stripe Price (on the connected account) when synced;
      // otherwise inline price_data. Either way the charge total = display and
      // the application_fee (margin) below is unchanged.
      line_items: [
        input.stripePriceId
          ? { price: input.stripePriceId, quantity: 1 }
          : {
              price_data: {
                currency: 'usd',
                product_data: {
                  name: `${input.productName} — ${input.rancherName}`,
                  description: 'Ships direct from the ranch.',
                },
                unit_amount: charge.totalChargedCents,
              },
              quantity: 1,
            },
      ],
      payment_intent_data: {
        application_fee_amount: charge.applicationFeeCents,
        metadata: {
          type: 'product_purchase',
          productId: input.productId,
          productName: input.productName,
          rancherId: input.rancherId,
          rancherName: input.rancherName,
          buyerEmail: input.buyerEmail || '',
          buyerName: input.buyerName || '',
          displayCents: String(charge.totalChargedCents),
          baseCents: String(charge.rancherNetCents),
          marginCents: String(charge.applicationFeeCents),
        },
      },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    },
    { stripeAccount: input.rancherConnectAccountId },
  );

  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return { url: session.url, sessionId: session.id };
}
