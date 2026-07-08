// lib/productPaymentIntent.ts
//
// BRAND-OWNED CHECKOUT mint (Payment Element migration, PR A — spec:
// docs/CHECKOUT-PAYMENT-ELEMENT-SPEC.md). Mints a raw PaymentIntent directly
// on the rancher's connected account for the on-domain Payment Element flow.
//
// DEFERRED-INTENT design: this runs at PAY-CLICK, not page load — the stock/
// Active/rancher gates execute seconds before the charge (the strongest
// oversell guard we have), and an abandoned checkout page mints NOTHING.
//
// MONEY MODEL — byte-identical to the Checkout Session path:
//   amount              = display×qty + shipping   (computeProductCharge)
//   application_fee     = (display−base)×qty       (shipping never skimmed)
//   metadata            = buildProductMetadata      (THE shared settlement
//                         contract — settleProductPurchase needs zero changes;
//                         a raw PI fires the same payment_intent.succeeded on
//                         the same connected-account webhook)
//
// Shipping address: confirmPayment + AddressElement stamps pi.shipping at
// confirm — which settlement's formatShipping() already reads (and MORE
// reliably than the Checkout path's charges-array sourcing).

import { getStripeClient } from '@/lib/stripeConnect';
import { isDemoMode } from '@/lib/demo/demoMode';
import { computeProductCharge, buildProductMetadata } from '@/lib/productCheckout';

export interface CreateProductPaymentIntentInput {
  rancherConnectAccountId: string;
  productId: string;
  productName: string;
  rancherId: string;
  rancherName: string;
  displayCents: number; // UNIT price
  baseCents: number;    // UNIT base
  shippingCents?: number;
  quantity?: number;
  depositStyle?: boolean;
  localOnly?: boolean;
  /** Buyer email from our own brand input — settlement receipt fallback #1. */
  buyerEmail?: string;
  /**
   * Client-generated uuid, one per checkout-page mount. Stripe idempotency
   * key `product-pi-<attemptId>` — a double-click can never double-mint.
   */
  attemptId: string;
}

export async function createProductPaymentIntent(
  input: CreateProductPaymentIntentInput,
): Promise<{ clientSecret: string; paymentIntentId: string; totalCents: number }> {
  const charge = computeProductCharge({
    displayCents: input.displayCents,
    baseCents: input.baseCents,
    shippingCents: input.shippingCents,
    quantity: input.quantity,
  });

  // DEMO MODE (local only) — no Stripe call, fake secret.
  if (isDemoMode()) {
    return { clientSecret: 'pi_DEMO_product_secret', paymentIntentId: 'pi_DEMO_product', totalCents: charge.totalChargedCents };
  }

  const attemptId = String(input.attemptId || '').trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(attemptId)) {
    throw new Error('invalid attemptId');
  }

  const stripe = getStripeClient();
  const pi = await stripe.paymentIntents.create(
    {
      amount: charge.totalChargedCents,
      currency: 'usd',
      application_fee_amount: charge.applicationFeeCents,
      automatic_payment_methods: { enabled: true },
      // Card-statement anchor (2026-07-08): direct charges print the RANCHER's
      // Stripe descriptor — if that's an LLC name the buyer doesn't recognize,
      // statement-time confusion becomes disputes. The suffix appends a name
      // the buyer definitely knows. Stripe truncates prefix+suffix to 22 chars.
      statement_descriptor_suffix: 'BUYHALFCOW',
      description: `${charge.quantity > 1 ? `${charge.quantity}× ` : ''}${input.productName} — ${input.rancherName}`,
      // receipt_email deliberately OMITTED (spec R8): the connected account's
      // ranch-named Stripe auto-receipt must never double-send against BHC's
      // branded settlement receipt. Settlement emails via metadata.buyerEmail.
      metadata: {
        ...buildProductMetadata(
          {
            productId: input.productId,
            productName: input.productName,
            rancherId: input.rancherId,
            rancherName: input.rancherName,
            buyerEmail: (input.buyerEmail || '').trim().toLowerCase(),
            buyerName: '',
            displayCents: input.displayCents,
            baseCents: input.baseCents,
            depositStyle: input.depositStyle,
            localOnly: input.localOnly,
          },
          charge,
        ),
        // Additive forensics key — settlement ignores unknown keys.
        mintedAt: new Date().toISOString(),
      },
    },
    {
      stripeAccount: input.rancherConnectAccountId,
      idempotencyKey: `product-pi-${attemptId}`,
    },
  );

  if (!pi.client_secret) throw new Error('Stripe did not return a client secret');
  return { clientSecret: pi.client_secret, paymentIntentId: pi.id, totalCents: charge.totalChargedCents };
}
