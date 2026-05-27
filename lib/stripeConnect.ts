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
  amountCents: number;
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
  const platformFeeCents = Math.round(input.amountCents * feeRate);

  // Direct charge w/ application_fee_amount. stripeAccount header routes
  // the charge to the rancher's Connect account; Stripe splits funds
  // automatically (rancher gets amount - fee, platform gets fee).
  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: input.productLabel },
            unit_amount: input.amountCents,
          },
          quantity: 1,
        },
      ],
      customer_email: input.buyerEmail,
      payment_intent_data: {
        application_fee_amount: platformFeeCents,
        metadata: {
          type: 'buyer_deposit',
          referralId: input.referralId,
          buyerId: input.buyerId,
          rancherId: input.rancherId,
          tier: input.tier,
        },
      },
      metadata: {
        type: 'buyer_deposit',
        referralId: input.referralId,
        buyerId: input.buyerId,
        rancherId: input.rancherId,
        tier: input.tier,
        platformFeeCents: String(platformFeeCents),
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
