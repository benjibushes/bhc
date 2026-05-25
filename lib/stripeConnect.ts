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

// SDK auto-sets API version 2026-04-22.dahlia
const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY || '');

export interface CreateConnectAccountInput {
  email: string;
  displayName: string;  // Shown in Stripe dashboard + on payout statements
  rancherId: string;    // For metadata lookup
}

export async function createConnectAccount(input: CreateConnectAccountInput): Promise<{ accountId: string }> {
  const account = await (stripeClient.v2.core.accounts as any).create({
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
  });
  return { accountId: account.id };
}

export interface OnboardingLinkInput {
  accountId: string;
  returnUrl: string;
  refreshUrl: string;
}

export async function createOnboardingLink(input: OnboardingLinkInput): Promise<{ url: string }> {
  const link = await (stripeClient.v2.core.accountLinks as any).create({
    account: input.accountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        configurations: ['merchant', 'customer'],
        refresh_url: input.refreshUrl,
        return_url: input.returnUrl,
      },
    },
  });
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
  const account = await (stripeClient.v2.core.accounts as any).retrieve(accountId, {
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
