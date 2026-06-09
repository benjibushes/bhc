// lib/stripeConnect.ts
//
// Stage-3 Task 7 — Stripe Connect V1 Express helpers for rancher onboarding.
//
// 2026-06-09 P0 fix: V2 Connect (v2/core/accounts) requires platform
// approval from Stripe and is in preview — our platform account
// (acct_1TSn5PGTWWNqassH) is NOT enrolled, so v2.core.accounts.create
// returned permission-denied for every rancher. Switched the entire
// onboarding surface to V1 Express which is GA + works on every Connect
// platform from day one.
//
// V1 Express:
//   - stripe.accounts.create({ type: 'express', ... }) returns acct_*
//   - stripe.accountLinks.create({ account, type: 'account_onboarding' })
//     returns a one-time hosted onboarding URL
//   - stripe.accounts.retrieve(acct) returns charges_enabled / payouts_enabled
//     / requirements.currently_due (the V1 source of truth)
//
// Buyer Direct Charges (createDepositCheckout below) already use V1
// stripe.checkout.sessions.create with `stripeAccount` header, so the
// V1 Express acct is plug-compatible — no other code change needed.
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
  // V1 Express: hosted dashboard, hosted onboarding, full BHC control via
  // application_fee_amount on direct charges. card_payments + transfers
  // capabilities are the standard "accept money + receive payouts" pair.
  const account = await stripe.accounts.create(
    {
      type: 'express',
      country: 'US',
      email: input.email,
      business_type: 'individual',
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: {
        name: input.displayName,
        product_description: 'Direct-to-consumer beef sales via BuyHalfCow marketplace',
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
  // V1 accountLinks — single-use URL, 30-minute TTL. Frontend handles
  // refresh_url callback when the link expires before user starts.
  const link = await stripe.accountLinks.create({
    account: input.accountId,
    refresh_url: input.refreshUrl,
    return_url: input.returnUrl,
    type: 'account_onboarding',
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
  const stripe = getStripeClient();
  // V1 Express retrieve. charges_enabled + payouts_enabled are the
  // canonical "this account can transact" flags. card_payments capability
  // status mirrors charges_enabled for Express accounts; we surface the
  // capability for parity with the V2-shape consumers.
  const account = await stripe.accounts.retrieve(accountId);
  const cardPaymentsActive =
    (account.capabilities?.card_payments as any) === 'active' ||
    Boolean(account.charges_enabled);
  const currentlyDue = account.requirements?.currently_due || [];
  const pastDue = account.requirements?.past_due || [];
  const reqStatus = pastDue.length > 0
    ? 'past_due'
    : currentlyDue.length > 0
      ? 'currently_due'
      : 'satisfied';
  const onboardingComplete = Boolean(account.charges_enabled && account.payouts_enabled);
  const status: ConnectAccountStatus =
    cardPaymentsActive && onboardingComplete ? 'active' :
    pastDue.length > 0 ? 'restricted' :
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

export async function createDepositCheckout(input: CreateDepositCheckoutInput): Promise<{ url: string; paymentIntentId: string; sessionId: string; connectAccountId: string }> {
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
          // NRD policy (2026-06-05): refundable until rancher accepts the
          // slot, then non-refundable. Tag the PaymentIntent so Stripe
          // Dashboard refunds can surface the policy + so external auditors
          // (chargeback responses, etc.) see the disclosure.
          nonRefundablePolicy: 'rancher_accept',
          nonRefundablePolicyVersion: 'NRD-2026-06-05',
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
        nonRefundablePolicy: 'rancher_accept',
        nonRefundablePolicyVersion: 'NRD-2026-06-05',
      },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // 2026-06-09 fix: previously had `customer_update: { address: 'auto' }`
      // alongside `customer_email` only. Stripe rejects `customer_update`
      // when no `customer` parameter is set on the session (customer_email
      // alone is insufficient — customer_update requires the customer object
      // to already exist). Dropping customer_update lets automatic_tax still
      // function (Stripe collects address during Checkout for tax calc).
      // Without this fix EVERY tier_v2 buyer deposit attempt 400'd at the
      // Stripe API layer, silently breaking the buyer-side checkout flow.
      automatic_tax: { enabled: true },
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
  // 2026-06-09 fix: expose sessionId so caller can expire() the session if
  // a downstream recordDeposit fails (otherwise orphan session = buyer
  // completes → succeeded PI with no Payments row → webhook silent no-op).
  return { url, paymentIntentId, sessionId: session.id, connectAccountId: input.rancherConnectAccountId };
}

/**
 * Cancel a still-open Checkout Session. Used by /api/checkout/deposit when
 * Airtable recordDeposit fails AFTER the Stripe Session was created — without
 * this, the buyer could complete the Session and we'd have a succeeded
 * PaymentIntent with no Payments row to match against. The webhook's
 * markDepositSucceeded looks up by PI Id; missing row → silent no-op → money
 * lands in rancher's Connect account with NO referral close, NO commission
 * recorded, NO Telegram celebration.
 *
 * Must pass the connectAccountId because deposit sessions are created on the
 * rancher's Connect account (stripeAccount header), and Stripe scopes session
 * IDs per account. Calling expire without the account header throws 404.
 */
export async function expireCheckoutSession(opts: {
  sessionId: string;
  connectAccountId: string;
}): Promise<void> {
  const stripe = getStripeClient();
  await stripe.checkout.sessions.expire(opts.sessionId, undefined, {
    stripeAccount: opts.connectAccountId,
  });
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
