// BROKER RAIL — Stripe Checkout Session on BHC's OWN platform account.
//
// ⚠️  READ THIS BEFORE EDITING. The single most important property of this file
// is what it does NOT contain:
//
//     • no `stripeAccount` request option        (no connected-account routing)
//     • no `application_fee_amount`              (nothing to split — we keep all)
//     • no `transfer_data` / `on_behalf_of`      (funds never leave BHC)
//     • no `Stripe Connect Account Id` read      (the rancher has none, by design)
//
// The charge lands 100% in BuyHalfCow's own Stripe balance and stays there. That
// full amount IS Ben's commission for brokering the sale (docs/BUSINESS-MODEL.md
// → "Money model 3: the broker rail"). The rancher is off-platform: he has no
// Stripe account, receives no payout, and is never invoiced. He collects
// price − deposit from the buyer himself.
//
// If a future change adds any Connect parameter here, the rancher would be
// double-charged for a commission he already funded out of his price. Don't.
//
// The client comes from lib/stripeConnect.getStripeClient() purely because it is
// the repo's single configured Stripe client (pinned apiVersion). Importing it
// implies NOTHING about using Connect.

import { getStripeClient } from '@/lib/stripeConnect';
import { isDemoMode } from '@/lib/demo/demoMode';
import { BROKER_RAIL_METADATA_VALUE, type Cut } from '@/lib/brokerRail';

export interface CreateBrokerCheckoutInput {
  /** Amount BHC collects and KEEPS, in cents. Equals the rancher's per-cut deposit.
   *  EXACT in both pricing modes — the commission never varies with the weight. */
  depositCents: number;
  /** Full share price in cents — carried in metadata for settlement math. For a
   *  WEIGHT-PRICED cut this is the range FLOOR (what `Total Sale Amount` is
   *  stamped with at settlement — conservative, never overstates). */
  priceCents: number;
  /** WEIGHT-PRICED (range) mode ceiling. Pass ONLY when the quote is weight-
   *  priced (`assertBrokerEligible` → `quote.weightPriced`); must then be
   *  strictly above priceCents. Omit for exact-mode cuts — the session params
   *  stay byte-identical to before range mode existed. */
  priceMaxCents?: number;
  cut: Cut;
  buyerEmail: string;
  referralId: string;
  buyerId: string;
  rancherId: string;
  /** e.g. "Half Cow — Cedar Draw Beef" */
  productLabel: string;
  successUrl: string;
  cancelUrl: string;
}

export interface BrokerCheckoutResult {
  url: string;
  paymentIntentId: string;
  sessionId: string;
}

/**
 * The settlement contract, as a pure function so the exact metadata shape is
 * unit-testable. `rail: 'broker'` is the ONLY trusted rail discriminator in
 * the webhook — Stripe holds it, the buyer cannot edit it, and it is checked
 * with an exact match (lib/brokerRail.isBrokerRailMetadata).
 *
 * `type` deliberately does NOT reuse 'buyer_deposit': that value routes into
 * settleBuyerDeposit, which assumes Connect economics (application_fee,
 * rancher payout, commission-already-skimmed). A broker PI must never reach it.
 *
 * WEIGHT-PRICED mode adds `weightPriced` / `priceMaxCents` /
 * `balanceDueRancherMaxCents` so settlement can render the honest range in the
 * emails without re-reading rancher prices (which could have been edited
 * between checkout and settle). `priceCents` stays the FLOOR. Exact mode emits
 * byte-identical metadata to before these keys existed.
 */
export function buildBrokerCheckoutMetadata(
  input: Pick<
    CreateBrokerCheckoutInput,
    'depositCents' | 'priceCents' | 'priceMaxCents' | 'cut' | 'referralId' | 'buyerId' | 'rancherId'
  >,
): Record<string, string> {
  const balanceCents = input.priceCents - input.depositCents;
  const metadata: Record<string, string> = {
    type: 'broker_deposit',
    rail: BROKER_RAIL_METADATA_VALUE,
    referralId: input.referralId,
    buyerId: input.buyerId,
    rancherId: input.rancherId,
    cut: input.cut,
    // depositCents == what BHC keeps == the whole commission. Same dollars,
    // stamped under both names so neither the ledger nor the P&L has to infer it.
    depositCents: String(input.depositCents),
    brokerCommissionCents: String(input.depositCents),
    priceCents: String(input.priceCents),
    balanceDueRancherCents: String(balanceCents),
  };
  if (isWeightPricedInput(input)) {
    metadata.weightPriced = 'true';
    metadata.priceMaxCents = String(input.priceMaxCents);
    metadata.balanceDueRancherMaxCents = String(input.priceMaxCents! - input.depositCents);
  }
  return metadata;
}

/**
 * Idempotency key. Folds in the amount AND the price so a re-quote (buyer
 * switches quarter → half) is a NEW request rather than a 24h Stripe
 * idempotency wall on a changed body — the exact trap documented on the
 * deposit + final-invoice keys in lib/stripeConnect.
 *
 * A WEIGHT-PRICED session folds the ceiling in too: a ranch flipped from exact
 * to range pricing (same floor, new metadata shape) within the 24h window must
 * mint a NEW session, not 400 against the old key's body. Exact-mode keys are
 * byte-identical to before.
 *
 * BUMP THE SUFFIX whenever the session params change shape.
 */
export function brokerCheckoutIdempotencyKey(
  input: Pick<CreateBrokerCheckoutInput, 'referralId' | 'depositCents' | 'priceCents' | 'priceMaxCents'>,
): string {
  const base = `broker-${input.referralId}-${input.depositCents}-${input.priceCents}`;
  return isWeightPricedInput(input) ? `${base}-max${input.priceMaxCents}-v1` : `${base}-v1`;
}

/** Range mode iff a ceiling was passed at all — createBrokerCheckout has
 *  already refused a present-but-invalid ceiling before either helper runs. */
function isWeightPricedInput(input: { priceCents: number; priceMaxCents?: number }): boolean {
  return (
    input.priceMaxCents !== undefined &&
    Number.isFinite(input.priceMaxCents) &&
    input.priceMaxCents > input.priceCents
  );
}

export async function createBrokerCheckout(
  input: CreateBrokerCheckoutInput,
): Promise<BrokerCheckoutResult> {
  // DEMO MODE (local only) — never true in prod. No Stripe call, no charge.
  if (isDemoMode()) {
    return {
      url: `/checkout/${input.referralId}/broker?demo=1`,
      paymentIntentId: 'pi_DEMO_broker',
      sessionId: 'cs_DEMO_broker',
    };
  }

  if (!Number.isFinite(input.depositCents) || input.depositCents <= 0) {
    throw new Error('broker checkout requires a positive depositCents');
  }
  // Defense in depth behind assertBrokerEligible: a deposit at or above the
  // price means the buyer would owe the ranch nothing (or less than nothing)
  // and the rancher's net would be zero. Never charge that. In WEIGHT-PRICED
  // mode `priceCents` is the range FLOOR, so this stays the strictest check —
  // a deposit below the floor is below the ceiling too.
  if (!(input.depositCents < input.priceCents)) {
    throw new Error('broker checkout requires depositCents < priceCents');
  }
  // A ceiling, when passed at all, must be a real range above the floor. Fail
  // closed rather than silently selling exact — the caller believed this cut
  // was weight-priced and every buyer-facing surface said "estimated".
  if (
    input.priceMaxCents !== undefined &&
    !(Number.isFinite(input.priceMaxCents) && input.priceMaxCents > input.priceCents)
  ) {
    throw new Error('broker checkout requires priceMaxCents > priceCents when provided');
  }

  // Metadata is the settlement contract — see buildBrokerCheckoutMetadata.
  const metadata = buildBrokerCheckoutMetadata(input);

  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      // Card + wallets only. Link stays OFF for the same reason as the Connect
      // deposit rail (2026-07-14 live incident): Link's OTP wall blocked a real
      // deposit at the money moment for an older, less-technical buyer.
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Deposit — ${input.productLabel}`,
              description:
                'Reserves your share. The remaining balance is paid directly to the ranch at pickup or delivery.',
            },
            unit_amount: input.depositCents,
          },
          quantity: 1,
        },
      ],
      customer_email: input.buyerEmail,
      payment_intent_data: {
        // NO application_fee_amount. NO transfer_data. See the file header.
        statement_descriptor_suffix: 'BUYHALFCOW',
        metadata,
      },
      metadata,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // No sales tax on a deposit — mirrors the Connect deposit rail. A surprise
      // tax line at the final step is a top cause of checkout abandonment.
      automatic_tax: { enabled: false },
    },
    {
      // See brokerCheckoutIdempotencyKey — exact-mode keys are unchanged;
      // weight-priced keys fold in the ceiling.
      idempotencyKey: brokerCheckoutIdempotencyKey(input),
    },
  );

  const url = session.url;
  if (!url) {
    throw new Error('Stripe Checkout (broker) returned no url');
  }
  // Clover: the PaymentIntent is created at PAY time, not session-create, so an
  // empty PI id here is EXPECTED. Settlement matches the Payments row by
  // referral and backfills the real PI id (markDepositSucceeded's fallback).
  return {
    url,
    paymentIntentId: session.payment_intent ? String(session.payment_intent) : '',
    sessionId: String(session.id || ''),
  };
}

/**
 * Expire a still-open broker Checkout Session.
 *
 * NOTE the absence of a `stripeAccount` option — unlike
 * lib/stripeConnect.expireCheckoutSession, this session lives on BHC's own
 * account, so passing an account header would 404.
 */
export async function expireBrokerCheckoutSession(sessionId: string): Promise<void> {
  const stripe = getStripeClient();
  await stripe.checkout.sessions.expire(sessionId);
}
