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
import { absorbStripeFee } from '@/lib/feeMath';

export interface ProductChargeInput {
  /** What the buyer pays for the product, in cents (the fee-invisible Display Price). */
  displayCents: number;
  /** What the rancher nets on the product, in cents (Rancher Base). */
  baseCents: number;
  /**
   * Optional per-order shipping charge, in cents ('Shipping Cost' on the row).
   * Added ON TOP of the display price at checkout and passed through to the
   * rancher 100% — BHC never skims shipping (the application fee stays
   * Display − Base). Omitted/0 = shipping included in the display price.
   */
  shippingCents?: number;
  /**
   * Units purchased (default 1). Product price + margin scale by quantity;
   * shipping is charged ONCE per order (flat, ships in one box).
   */
  quantity?: number;
}

export interface ProductCharge {
  totalChargedCents: number;   // buyer pays this (display×qty + shipping)
  applicationFeeCents: number; // fee actually charged: gross margin − absorbed processing (net-your-number)
  grossMarginCents: number;    // (display − base)×qty — margin before absorption; shipping never skimmed
  absorbedCents: number;       // processing cost BHC absorbed for the rancher
  rancherNetCents: number;     // rancher receives this (base×qty + shipping)
  shippingCents: number;       // normalized shipping component (0 = included)
  quantity: number;            // normalized units (>= 1)
}

/**
 * Pure money math for a low-ticket product charge. Validates the invariant
 * that keeps the platform safe: the base must be a positive amount no greater
 * than the display price, so the margin (fee) is always in [0, display).
 * Shipping is a pure passthrough — it raises the buyer total and the rancher
 * net by the same amount and can never change the fee. Throws on invalid
 * input — a bad product must NEVER reach Stripe.
 */
export function computeProductCharge(input: ProductChargeInput): ProductCharge {
  const display = Math.round(Number(input.displayCents));
  const base = Math.round(Number(input.baseCents));
  const shipping = Math.round(Number(input.shippingCents ?? 0));
  const quantity = Math.round(Number(input.quantity ?? 1));
  if (!Number.isFinite(display) || display <= 0) {
    throw new Error(`invalid display price: ${input.displayCents}`);
  }
  if (!Number.isFinite(base) || base <= 0) {
    throw new Error(`invalid rancher base: ${input.baseCents}`);
  }
  if (base > display) {
    throw new Error(`rancher base (${base}) exceeds display price (${display}) — margin would be negative`);
  }
  if (!Number.isFinite(shipping) || shipping < 0) {
    throw new Error(`invalid shipping cost: ${input.shippingCents}`);
  }
  // Quantity is bounded here as the last line of defense — the buy route
  // clamps user input, but a fee computed off an absurd qty must be impossible.
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 10) {
    throw new Error(`invalid quantity: ${input.quantity}`);
  }
  // NET-YOUR-NUMBER (2026-07-08): the gross margin (display − base) is what
  // BHC would keep in a world without card fees. Stripe's processing fee
  // comes out of the RANCHER's balance on a direct charge, so before this
  // the dashboard's "you net $X" quietly overstated their payout by ~2.9%.
  // We now shrink the application fee by the processing estimate (floored,
  // lib/feeMath) so the rancher's real payout lands on the promised number.
  // Buyer price unchanged; the absorption is BHC-margin only.
  const grossMarginCents = (display - base) * quantity;
  const totalChargedCents = display * quantity + shipping;
  const { feeCents: applicationFeeCents, absorbedCents } = absorbStripeFee({
    grossFeeCents: grossMarginCents,
    totalChargeCents: totalChargedCents,
  });
  return {
    totalChargedCents,
    applicationFeeCents,
    grossMarginCents,
    absorbedCents,
    rancherNetCents: base * quantity + shipping,
    shippingCents: shipping,
    quantity,
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
  // WHITELABEL (2026-07-06): checkout surface.
  //   'hosted'   (default) → Stripe-hosted redirect (checkout.stripe.com).
  //                          Operator texted links + the graceful fallback when
  //                          the storefront can't run embedded (no publishable key).
  //   'embedded' → <EmbeddedCheckout> in an iframe ON buyhalfcow.com. No redirect,
  //                BHC-domain. Money model is byte-identical (same direct charge,
  //                same application_fee, same metadata, same webhook).
  mode?: 'embedded' | 'hosted';
  // Hosted mode uses success/cancel. Embedded mode uses returnUrl instead (Stripe
  // 400s if you mix them). Each is required only for its own mode.
  successUrl?: string;
  cancelUrl?: string;
  returnUrl?: string;              // required for embedded; absolute https URL
  // PRODUCTS-IN-STRIPE (2026-07-06): when set, the line item references this
  // real Stripe Price (created on the connected account by ensureStripePrice)
  // instead of an inline price_data. The margin (application_fee) is unchanged.
  // Omitted → falls back to inline price_data (demo / not-yet-synced).
  stripePriceId?: string;
  // DEPOSIT-STYLE (2026-07-06 audit fix C-1.5): price-range products (e.g. the
  // $95–355 ground box) charge Display Price as a DEPOSIT; the rancher confirms
  // size + balance before shipping. Threading the flag into PI metadata lets
  // settlement send truthful emails ("deposit paid — confirm details") instead
  // of "paid, ship it". Charge mechanics are IDENTICAL either way.
  depositStyle?: boolean;
  // SHIPPING COST (2026-07-07): optional per-order shipping the buyer pays as
  // a separate Stripe shipping line. 100% passthrough to the rancher — the
  // application fee stays Display − Base. Omitted/0 = shipping included.
  // Callers must pass 0 for deposit-style products (shipping settles with the
  // balance the rancher collects directly).
  shippingCents?: number;
  // QUANTITY (2026-07-07): units purchased (default 1, capped by the buy
  // route). Product line + fee scale by qty; shipping stays flat per order.
  // Deposit-style is always 1 (one reservation).
  quantity?: number;
  // LOCAL PICKUP (2026-07-07): pickup-at-the-ranch product. Callers pass the
  // resolver's flag; shippingCents must already be 0 for these.
  localOnly?: boolean;
}

/**
 * THE settlement contract — the ONE metadata builder both mint paths share
 * (Checkout Session here, raw PaymentIntent in lib/productPaymentIntent.ts).
 * settleProductPurchase reads ONLY these keys; sharing the builder makes
 * metadata drift between the two paths structurally impossible. Pure —
 * unit-tested key-for-key in lib/productCheckout.test.ts. Add a key here and
 * BOTH rails carry it.
 */
export function buildProductMetadata(
  input: Pick<
    CreateProductCheckoutInput,
    'productId' | 'productName' | 'rancherId' | 'rancherName' | 'buyerEmail' | 'buyerName' | 'displayCents' | 'baseCents' | 'depositStyle' | 'localOnly'
  >,
  charge: ProductCharge,
): Record<string, string> {
  return {
    type: 'product_purchase',
    productId: input.productId,
    productName: input.productName,
    rancherId: input.rancherId,
    rancherName: input.rancherName,
    buyerEmail: input.buyerEmail || '',
    buyerName: input.buyerName || '',
    displayCents: String(input.displayCents),
    baseCents: String(input.baseCents),
    marginCents: String(charge.applicationFeeCents),
    grossMarginCents: String(charge.grossMarginCents),
    absorbedStripeFeeCents: String(charge.absorbedCents),
    // Shipping passthrough — settlement adds it to Buyer Paid + Rancher
    // Payout; it is never part of the margin.
    shippingCents: String(charge.shippingCents),
    // Units — settlement scales Buyer Paid/Payout + decrements stock by this.
    quantity: String(charge.quantity),
    // C-1.5: settlement branches receipt/rancher/operator copy on this.
    depositStyle: input.depositStyle ? 'true' : 'false',
    // LOCAL PICKUP — settlement branches emails/signals to "coordinate
    // pickup" instead of "ship to". Absent/legacy PIs read as 'ship'.
    fulfillment: input.localOnly ? 'pickup' : 'ship',
  };
}

/**
 * Create the Stripe Connect direct-charge Checkout Session for a low-ticket
 * product. Collects the shipping address (the rancher ships it). Shipping
 * charge: when the product carries a 'Shipping Cost' (shippingCents > 0) it
 * renders as Stripe's native Shipping line and passes through 100% to the
 * rancher; otherwise the Display Price is all-in and no shipping line appears.
 * metadata.type = 'product_purchase' routes the webhook to settleProductPurchase.
 */
export async function createProductCheckout(
  input: CreateProductCheckoutInput,
): Promise<{ url?: string; clientSecret?: string; sessionId: string }> {
  const charge = computeProductCharge({
    displayCents: input.displayCents,
    baseCents: input.baseCents,
    shippingCents: input.shippingCents,
    quantity: input.quantity,
  });
  const isEmbedded = input.mode === 'embedded';

  // Fail loud on a mode/URL mismatch — a half-configured session must never
  // reach Stripe (embedded needs return_url; hosted needs success+cancel).
  if (isEmbedded && !input.returnUrl) {
    throw new Error('embedded checkout requires a returnUrl');
  }
  if (!isEmbedded && (!input.successUrl || !input.cancelUrl)) {
    throw new Error('hosted checkout requires successUrl and cancelUrl');
  }

  // DEMO MODE (local only) — never true in prod. No Stripe call.
  if (isDemoMode()) {
    return isEmbedded
      ? { clientSecret: 'cs_DEMO_product_secret', sessionId: 'cs_DEMO_product' }
      : { url: '/checkout/DEMO/product', sessionId: 'cs_DEMO_product' };
  }

  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      // Sessions default to a 24h life — a link minted before a sell-out
      // could pay a full day later. 30 min (Stripe's floor) shrinks the
      // oversell window; settlement still rings OVERSOLD if one slips through.
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      // Whitelabel: embedded renders in an iframe on buyhalfcow.com. The direct
      // charge, application_fee, metadata, and webhook are all identical to hosted.
      ...(isEmbedded ? { ui_mode: 'embedded' as const } : {}),
      // Prefill for operator links; omit for self-serve (Stripe collects it).
      ...(input.buyerEmail ? { customer_email: input.buyerEmail } : {}),
      // Rancher ships → we must collect where. When the product carries a
      // 'Shipping Cost', it renders as Stripe's native Shipping line (buyer
      // sees product + shipping, one total); otherwise the Display Price is
      // all-in and no shipping line appears.
      shipping_address_collection: { allowed_countries: ['US'] },
      ...(charge.shippingCents > 0
        ? {
            shipping_options: [
              {
                shipping_rate_data: {
                  type: 'fixed_amount' as const,
                  fixed_amount: { amount: charge.shippingCents, currency: 'usd' },
                  display_name: 'Shipping from the ranch',
                },
              },
            ],
          }
        : {}),
      // Prefer a real Stripe Price (on the connected account) when synced;
      // otherwise inline price_data. Either way the charge total = display and
      // the application_fee (margin) below is unchanged.
      line_items: [
        input.stripePriceId
          ? { price: input.stripePriceId, quantity: charge.quantity }
          : {
              price_data: {
                currency: 'usd',
                product_data: {
                  name: `${input.productName} — ${input.rancherName}`,
                  // Deposit-style must be honest INSIDE Stripe too — the hosted
                  // fallback + operator-texted links show only this page.
                  description: input.depositStyle
                    ? 'Deposit — the ranch confirms your size + the balance with you before shipping.'
                    : input.localOnly
                      ? 'Local pickup at the ranch — no shipping.'
                      : 'Ships direct from the ranch.',
                },
                // Product line = the UNIT display price; qty scales the line,
                // shipping (when set) rides shipping_options so receipts itemize.
                unit_amount: input.displayCents,
              },
              quantity: charge.quantity,
            },
      ],
      payment_intent_data: {
        application_fee_amount: charge.applicationFeeCents,
        metadata: buildProductMetadata(input, charge),
        // Card-statement anchor — direct charges print the rancher's Stripe
        // descriptor; the suffix adds the name the buyer recognizes (dispute
        // prevention). Stripe truncates prefix+suffix to 22 chars.
        statement_descriptor_suffix: 'BUYHALFCOW',
      },
      // Embedded ⇒ return_url (Stripe redirects the parent page out of the iframe
      // on completion). Hosted ⇒ success/cancel. Never both — Stripe 400s.
      ...(isEmbedded
        ? { return_url: input.returnUrl }
        : { success_url: input.successUrl, cancel_url: input.cancelUrl }),
    },
    { stripeAccount: input.rancherConnectAccountId },
  );

  if (isEmbedded) {
    // session.url is null in embedded mode — the client mounts on client_secret.
    if (!session.client_secret) throw new Error('Stripe did not return a client secret');
    return { clientSecret: session.client_secret, sessionId: session.id };
  }
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return { url: session.url, sessionId: session.id };
}
