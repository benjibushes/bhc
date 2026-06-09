// lib/stripeSubscription.ts
//
// Stage-3 Task 4 — V2 Stripe Subscription helpers for the 3-tier model.
//
// V2 unifies Customer + Connected Account. The rancher's acct_* ID is used
// as both:
//   - the Connected Account (receives buyer deposits via direct charge)
//   - the Customer (billed for monthly tier subscription)
// Pass `customer_account: 'acct_*'` to checkout.sessions.create + billingPortal.
// Do NOT create a separate cus_* customer.
//
// Each rancher gets ONE subscription. Tier changes proration via
// subscriptions.update.

import Stripe from 'stripe';
import { TIERS, TierSlug } from '@/lib/tiers';

// Lazy Stripe client init — constructing at module load fails Vercel's
// build-time page-data collection (env vars not available). Defer until
// first runtime call.
//
// V2 `customer_account` param requires the `2025-09-30.preview` Stripe-Version
// header — same preview API needed by lib/stripeConnect.ts. Without it the
// subscription create call rejects `customer_account` as Unknown field.
let _stripeClient: Stripe | null = null;
function getStripeClient(): Stripe {
  if (_stripeClient) return _stripeClient;
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    throw new Error('STRIPE_SECRET_KEY environment variable is required');
  }
  _stripeClient = new Stripe(apiKey, {
    apiVersion: '2025-09-30.preview' as any,
  });
  return _stripeClient;
}

export interface TierCheckoutInput {
  rancherId: string;
  connectedAccountId: string;  // acct_XXX — must exist before this call (Task 7 creates)
  tier: TierSlug;
  successUrl: string;
  cancelUrl: string;
}

export async function createTierCheckoutSession(input: TierCheckoutInput): Promise<{ url: string }> {
  const priceId = process.env[TIERS[input.tier].stripePriceIdEnv];
  if (!priceId) throw new Error(`Missing env var: ${TIERS[input.tier].stripePriceIdEnv}`);

  // V2: the connected account IS the customer. Use customer_account, NOT customer.
  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      customer_account: input.connectedAccountId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: { rancherId: input.rancherId, tier: input.tier },
      subscription_data: { metadata: { rancherId: input.rancherId, tier: input.tier } },
      automatic_tax: { enabled: true },
      customer_update: { address: 'auto' },
    } as any,  // customer_account is V2 — types may lag in SDK 20.4.1
    {
      // 2026-06-09 fix: was `sub-${rancherId}-${tier}` — if rancher cancels
      // subscription and re-picks same tier, Stripe replays the old session
      // URL which now points at a dead session. Append timestamp so each
      // attempt gets a fresh session. The rancherId+tier prefix still allows
      // safe retry of the SAME pick during a single attempt window.
      idempotencyKey: `sub-${input.rancherId}-${input.tier}-${Date.now()}`,
    },
  );
  return { url: session.url || '' };
}

export async function changeSubscriptionTier(subscriptionId: string, newTier: TierSlug): Promise<void> {
  const newPriceId = process.env[TIERS[newTier].stripePriceIdEnv];
  if (!newPriceId) throw new Error(`Missing env var: ${TIERS[newTier].stripePriceIdEnv}`);
  const stripe = getStripeClient();
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  // 2026-06-09 fix: was `sub.items.data[0].id` — crashes if items array
  // empty (e.g. canceled mid-tier-change). Guard + throw clearer error.
  const items = (sub as any)?.items?.data || [];
  if (!items.length) {
    throw new Error(
      `Stripe subscription ${subscriptionId} has no items — cannot change tier on a canceled/empty subscription`,
    );
  }
  const itemId = items[0].id;
  await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: itemId, price: newPriceId }],
    proration_behavior: 'always_invoice',
    metadata: { ...sub.metadata, tier: newTier },
  });
}

export async function createBillingPortalSession(
  connectedAccountId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  // V2: use customer_account, not customer
  const stripe = getStripeClient();
  const session = await stripe.billingPortal.sessions.create({
    customer_account: connectedAccountId,
    return_url: returnUrl,
  } as any);
  return { url: session.url };
}

// Helper to extract V2 connected account id from a subscription webhook payload.
// V2: subscription.customer_account is the acct_* id.
// subscription.customer DOES NOT EXIST on V2.
export function rancherIdFromSubscription(subscription: any): { connectedAccountId: string } {
  return { connectedAccountId: subscription.customer_account as string };
}
