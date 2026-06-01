// lib/stripeConnect.ts
//
// Stage-3 Task 7 — Stripe Connect V2 helpers for rancher onboarding.
//
// V2 unifies Express / Standard / Custom into a single account object
// with configuration.{merchant,customer} capability blocks. NO top-level
// `type:` field. See https://docs.stripe.com/api/v2/core/accounts/object
//
// Status reads are LIVE — never cache. The Ranchers.Stripe Connect Status
// field is a UI hint that gets refreshed by the webhook (Task 6), not a
// source of truth.

import Stripe from 'stripe';

// Lazy Stripe client init — constructing at module load fails Vercel's
// build-time page-data collection (env vars not available). Defer until
// first runtime call.
let _stripeClient: Stripe | null = null;
function getStripeClient(): Stripe {
  if (_stripeClient) return _stripeClient;
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    throw new Error('STRIPE_SECRET_KEY environment variable is required');
  }
  _stripeClient = new Stripe(apiKey);
  return _stripeClient;
}

export interface CreateConnectAccountInput {
  email: string;
  displayName: string;  // Shown in Stripe dashboard + on payout statements
  rancherId: string;    // For metadata lookup
}

export async function createConnectAccount(input: CreateConnectAccountInput): Promise<{ accountId: string }> {
  const stripe = getStripeClient();
  const account = await (stripe.v2.core.accounts as any).create(
    {
      display_name: input.displayName,
      contact_email: input.email,
      identity: { country: 'us' },
      dashboard: 'full',  // V2 equivalent of legacy Express dashboard
      defaults: {
        responsibilities: {
          fees_collector: 'stripe',
          losses_collector: 'stripe',
        },
      },
      configuration: {
        customer: {},  // Enables as customer (for tier subscription billing)
        merchant: {
          capabilities: {
            card_payments: { requested: true },  // Enables as merchant (buyer deposits)
          },
        },
      },
      metadata: { rancherId: input.rancherId },
    },
    {
      idempotencyKey: `connect-acct-${input.rancherId}`,
    },
  );
  return { accountId: account.id };
}

export interface OnboardingLinkInput {
  accountId: string;
  returnUrl: string;
  refreshUrl: string;
}

export async function createOnboardingLink(input: OnboardingLinkInput): Promise<{ url: string }> {
  const stripe = getStripeClient();
  const link = await (stripe.v2.core.accountLinks as any).create(
    {
      account: input.accountId,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['merchant', 'customer'],
          refresh_url: input.refreshUrl,
          return_url: input.returnUrl,
        },
      },
    },
    {
      idempotencyKey: `connect-link-${input.accountId}-${Date.now()}`,
    },
  );
  return { url: link.url };
}

export type ConnectAccountStatus = 'not_connected' | 'onboarding' | 'active' | 'restricted';

export interface ConnectStatusReadResult {
  cardPaymentsActive: boolean;
  onboardingComplete: boolean;
  requirementsStatus: string | null;
  status: ConnectAccountStatus;
}

export async function getConnectAccountStatus(accountId: string): Promise<ConnectStatusReadResult> {
  const stripe = getStripeClient();
  const account = await (stripe.v2.core.accounts as any).retrieve(accountId, {
    include: ['configuration.merchant', 'requirements'],
  });
  const cardPaymentsActive =
    (account as any)?.configuration?.merchant?.capabilities?.card_payments?.status === 'active';
  const reqStatus = (account as any)?.requirements?.summary?.minimum_deadline?.status ?? null;
  const onboardingComplete = reqStatus !== 'currently_due' && reqStatus !== 'past_due';
  const status: ConnectAccountStatus =
    cardPaymentsActive && onboardingComplete ? 'active' :
    reqStatus === 'past_due' ? 'restricted' :
    'onboarding';
  return { cardPaymentsActive, onboardingComplete, requirementsStatus: reqStatus, status };
}

// ---------------------------------------------------------------------------
// Stage-3 Task 8 — buyer deposit direct-charge Checkout Session
// ---------------------------------------------------------------------------

import { TIERS, TierSlug } from '@/lib/tiers';

export interface CreateDepositCheckoutInput {
  rancherConnectAccountId: string;  // acct_* — direct charge target
  tier: TierSlug;
  /**
   * Rancher's self-selected deposit amount in cents. This is the portion
   * collected upfront and routed to the rancher's Connect acct as the
   * sale price. The buyer pays this + the BHC service fee on top.
   */
  amountCents: number;
  /**
   * Full sale price for this cut in cents (Quarter/Half/Whole Price). The
   * BHC service fee is calculated as `fullSaleCents × commissionRate` and
   * collected IN FULL at deposit time. This guarantees BHC commission is
   * baked into the deal up front — the rancher collects the balance
   * (fullSale − deposit) directly at fulfillment with no further BHC
   * involvement.
   *
   * If the rancher hasn't set a separate deposit (deposit = full price),
   * pass the same value for amountCents and fullSaleCents — the math
   * still works (commission % of full = commission % of single payment).
   */
  fullSaleCents: number;
  buyerEmail: string;
  referralId: string;
  buyerId: string;   // Consumers record id — fans out to webhook routing
  rancherId: string; // Ranchers record id — fans out to webhook routing
  productLabel: string;  // e.g. "Half Cow — Ashcraft Beef"
  successUrl: string;
  cancelUrl: string;
}

export async function createDepositCheckout(input: CreateDepositCheckoutInput): Promise<{ url: string; paymentIntentId: string }> {
  const feeRate = TIERS[input.tier].commissionRate;  // 0.07 / 0.03 / 0
  // CRITICAL: commission is calculated on the FULL sale price, not on the
  // deposit. Rancher takes their full deposit upfront, BHC takes its full
  // commission upfront, and the rancher collects the fulfillment balance
  // (fullSaleCents − depositCents) directly outside BHC. Net result:
  // BHC commission is paid in full at deposit time regardless of how the
  // rancher splits the rest.
  const platformFeeCents = Math.round(input.fullSaleCents * feeRate);
  // Buyer pays the rancher's full deposit PLUS the full BHC service fee.
  // Rancher receives exactly `input.amountCents` (Stripe routes the total
  // to rancher's Connect acct, then transfers application_fee_amount to
  // the BHC platform acct).
  const totalChargedCents = input.amountCents + platformFeeCents;
  const feePct = Math.round(feeRate * 100);
  // Balance the rancher will collect later at fulfillment (outside BHC).
  // Stamped in metadata so the rancher dashboard + buyer receipt can
  // surface it without re-computing.
  const fulfillmentBalanceCents = Math.max(0, input.fullSaleCents - input.amountCents);

  // Direct charge w/ application_fee_amount. stripeAccount header routes
  // the total charge to the rancher's Connect account; Stripe splits funds
  // automatically (rancher gets total - fee = deposit, platform gets fee).
  // Two line items chosen over one so the buyer's Stripe-hosted receipt
  // shows the breakdown explicitly — "deposit" + "BHC service fee" — and
  // there's no ambiguity about what the buyer is paying.
  const stripe = getStripeClient();
  const lineItems: any[] = [
    {
      price_data: {
        currency: 'usd',
        product_data: { name: input.productLabel },
        unit_amount: input.amountCents,
      },
      quantity: 1,
    },
  ];
  if (platformFeeCents > 0) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'BuyHalfCow service fee',
          description: `${feePct}% of full sale price ($${(input.fullSaleCents / 100).toFixed(2)}) — covers Stripe processing and platform routing.`,
        },
        unit_amount: platformFeeCents,
      },
      quantity: 1,
    });
  }

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      line_items: lineItems,
      customer_email: input.buyerEmail,
      payment_intent_data: {
        application_fee_amount: platformFeeCents,
        metadata: {
          type: 'buyer_deposit',
          referralId: input.referralId,
          buyerId: input.buyerId,
          rancherId: input.rancherId,
          tier: input.tier,
          // Webhook reads `depositCents` (not the total charged) when stamping
          // Referral Sale Amount + downstream commission math. Without this,
          // the deposit+fee total would inflate the rancher's recorded sale.
          depositCents: String(input.amountCents),
          fullSaleCents: String(input.fullSaleCents),
          platformFeeCents: String(platformFeeCents),
          totalChargedCents: String(totalChargedCents),
          fulfillmentBalanceCents: String(fulfillmentBalanceCents),
        },
      },
      metadata: {
        type: 'buyer_deposit',
        referralId: input.referralId,
        buyerId: input.buyerId,
        rancherId: input.rancherId,
        tier: input.tier,
        depositCents: String(input.amountCents),
        fullSaleCents: String(input.fullSaleCents),
        platformFeeCents: String(platformFeeCents),
        totalChargedCents: String(totalChargedCents),
        fulfillmentBalanceCents: String(fulfillmentBalanceCents),
      },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      automatic_tax: { enabled: true },
      customer_update: { address: 'auto' },
    },
    {
      stripeAccount: input.rancherConnectAccountId,
      idempotencyKey: `deposit-${input.referralId}`,
    },
  );
  const url = session.url;
  const paymentIntentId = session.payment_intent ? String(session.payment_intent) : '';
  if (!url || !paymentIntentId) {
    // Stripe should always populate both for a payment-mode Checkout Session.
    // If either is missing the downstream Airtable + webhook lookup keys break.
    throw new Error(`Stripe Checkout Session returned incomplete fields (url=${!!url}, payment_intent=${!!paymentIntentId})`);
  }
  return { url, paymentIntentId };
}

// ─── FINAL INVOICE (balance owed after deposit) ────────────────────────────
//
// Rancher-initiated invoice for the FULL fulfillment balance — sent to the
// buyer AFTER the deposit landed + processing date is locked. application_fee
// is ZERO: BHC's commission was already collected upfront via the deposit
// (bundled in there alongside the processor recoup). The final invoice is
// purely between buyer and rancher; BHC takes nothing.
//
// Use case (e.g. $2000 Half cow):
//   Deposit ($1200) — already paid via createDepositCheckout
//     • $1000 to rancher (covers processing fee they fronted)
//     • $200 to BHC (10% commission on full $2000)
//   Final invoice ($800) — created here
//     • $800 to rancher
//     • $0 to BHC
//   Total: rancher $1800, BHC $200, exactly 10% of $2000.

export interface CreateFinalInvoiceCheckoutInput {
  rancherConnectAccountId: string;
  /**
   * Balance owed by the buyer, in cents. Typically:
   *   fullSaleCents − depositAmountCents
   * Validated upstream — endpoint refuses if <= 0 or > $25k.
   */
  amountCents: number;
  buyerEmail: string;
  referralId: string;
  buyerId: string;
  rancherId: string;
  productLabel: string;       // e.g. "Half Cow Final Balance — Ashcraft Beef"
  processingDate?: string;    // ISO date string for buyer receipt context
  notes?: string;             // optional rancher message to buyer
  successUrl: string;
  cancelUrl: string;
}

export async function createFinalInvoiceCheckout(
  input: CreateFinalInvoiceCheckoutInput,
): Promise<{ url: string; paymentIntentId: string }> {
  if (input.amountCents <= 0) {
    throw new Error('Final invoice amount must be greater than zero');
  }

  const stripe = getStripeClient();
  const description = [
    input.processingDate ? `Processing date: ${input.processingDate}` : null,
    input.notes,
    'Final balance — collected by rancher direct, no BuyHalfCow fee.',
  ]
    .filter(Boolean)
    .join('\n');

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: input.productLabel,
              description,
            },
            unit_amount: input.amountCents,
          },
          quantity: 1,
        },
      ],
      customer_email: input.buyerEmail,
      payment_intent_data: {
        // application_fee_amount intentionally OMITTED (== 0). BHC takes no
        // commission on the final invoice — already collected upfront on
        // the deposit charge.
        metadata: {
          type: 'final_invoice',
          kind: 'final-invoice',  // webhook distinguish vs 'buyer_deposit'
          referralId: input.referralId,
          buyerId: input.buyerId,
          rancherId: input.rancherId,
          ...(input.processingDate ? { processingDate: input.processingDate } : {}),
        },
      },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // Tax handling kept off for final invoice — rancher's tax setup applies
      // (this is direct billing, BHC doesn't touch tax collection here).
    },
    {
      stripeAccount: input.rancherConnectAccountId,
      idempotencyKey: `final-invoice-${input.referralId}`,
    },
  );

  const url = session.url;
  const paymentIntentId = session.payment_intent ? String(session.payment_intent) : '';
  if (!url || !paymentIntentId) {
    throw new Error(`Stripe Checkout (final invoice) returned incomplete fields (url=${!!url}, payment_intent=${!!paymentIntentId})`);
  }
  return { url, paymentIntentId };
}
