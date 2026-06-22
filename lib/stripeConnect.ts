// lib/stripeConnect.ts
//
// Stage-3 Task 7 — Stripe Connect V2 helpers for rancher onboarding.
//
// 2026-06-09 v3 (post-blueprint): implementation matches the Stripe
// "Subscriptions and embedded payments" blueprint EXACTLY:
//   - V2 /v2/core/accounts.create with `include` array, `identity.country` +
//     `identity.business_details`, `dashboard: 'full'`,
//     `defaults.responsibilities.{losses,fees}_collector = 'stripe'`
//   - V2 /v2/core/account_links.create with use_case.account_onboarding
//     and configurations: ['merchant', 'customer']
//   - V2 /v2/core/accounts.retrieve with include for requirements +
//     configuration.merchant capability status
//
// V2 unifies Express/Standard/Custom into one Account object with a
// configuration block per role (merchant for accepting buyer payments,
// customer for paying SaaS subscriptions). Same account = same KYC = same
// dashboard for rancher.
//
// SUBSCRIPTION BILLING (lib/stripeSubscription.ts):
//   Per blueprint, the rancher's monthly tier fee is auto-deducted from
//   their Stripe Connect *balance* (incoming buyer payments) via a
//   SetupIntent w/ payment_method_types=['stripe_balance']. NO card on
//   file = lower churn = no involuntary cancels.
//
// BUYER DEPOSIT (createDepositCheckout below):
//   Same as before — V1 checkout.sessions.create on the rancher's acct
//   with application_fee_amount. V2 accounts are plug-compatible w/ V1
//   direct charges since the Stripe-Account header takes acct_* of either
//   type.
//
// PLATFORM REQUIREMENTS (one-time, in Stripe Dashboard):
//   1. Connect platform-profile complete in sandbox (then enable live)
//   2. V2 Connect API enrolled (request from Stripe support if not auto-on)
//   3. `losses_collector=stripe` accepted on platform profile (so Stripe
//      covers negative rancher balances, no reserve required on BHC)
//
// Status reads are LIVE — never cache. The Ranchers.Stripe Connect Status
// field is a UI hint that gets refreshed by the webhook (V2 events:
// v2.core.account[configuration.merchant].capability_status_updated +
// v2.core.account[requirements].updated).

import Stripe from 'stripe';

// Lazy Stripe client init — constructing at module load fails Vercel's
// build-time page-data collection (env vars not available). Defer until
// first runtime call.
//
// V2 Connect Accounts API is currently a *preview* feature on Stripe and
// requires the `2025-09-30.preview` Stripe-Version header on every call.
// Without it Stripe returns `not_found` with the hint: "In order to access
// this preview feature, you must explicitly specify a .preview Stripe-Version
// in your request header." We confirmed this empirically against the BHC
// sandbox on 2026-06-09.
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

export interface CreateConnectAccountInput {
  email: string;
  displayName: string;  // Shown in Stripe dashboard + on payout statements
  rancherId: string;    // For metadata lookup
}

export async function createConnectAccount(input: CreateConnectAccountInput): Promise<{ accountId: string }> {
  const stripe = getStripeClient();
  // Match Stripe blueprint "Subscriptions and embedded payments" exactly.
  // `include` array forces Stripe to return the requested sub-resources on
  // the create response so we have everything we need (capability statuses,
  // requirements) without a second retrieve call.
  //
  // `losses_collector = 'stripe'` keeps BHC off the hook for rancher
  // negative balances. Required platform-profile acknowledgement in Stripe
  // Dashboard (one-time per environment).
  //
  // `dashboard = 'full'` gives the rancher access to the full Stripe
  // dashboard — they manage their own bank acct + payout schedule + tax
  // forms without us building proxy UI for any of it.
  const params: any = {
    display_name: input.displayName,
    contact_email: input.email,
    configuration: {
      merchant: {},
      customer: {},
    },
    include: [
      'configuration.merchant',
      'configuration.recipient',
      'identity',
      'defaults',
      'configuration.customer',
    ],
    identity: {
      country: 'us',
      business_details: {
        // Placeholder — rancher will set real phone during KYC. Required
        // by V2 even though we don't have it yet.
        phone: '0000000000',
      },
    },
    dashboard: 'full',
    defaults: {
      responsibilities: {
        losses_collector: 'stripe',
        fees_collector: 'stripe',
      },
    },
    metadata: { rancherId: input.rancherId },
  };
  // simulate_accept_tos_obo is documented in the Stripe Workbench blueprint
  // but rejected by the live V2 API as Unknown field (verified 2026-06-09).
  // Real rancher always goes through Stripe-hosted TOS — no bypass needed.
  const account = await (stripe.v2.core.accounts as any).create(params, {
    idempotencyKey: `connect-acct-${input.rancherId}`,
  });
  return { accountId: account.id };
}

export interface OnboardingLinkInput {
  accountId: string;
  returnUrl: string;
  refreshUrl: string;
}

export async function createOnboardingLink(input: OnboardingLinkInput): Promise<{ url: string }> {
  const stripe = getStripeClient();
  // V2 account_links — onboards both merchant (accept buyer payments) and
  // customer (subscription billed from Connect balance) in one flow.
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
  // V2 retrieve w/ include — Stripe returns the full configuration +
  // requirements blocks needed to compute live status without a second
  // round-trip. The legacy minimum_deadline field is the canonical
  // requirements-status indicator on V2; capability_status_updated webhook
  // events drive incremental refresh.
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
      // CUT-SPECIFIC idempotency key (2026-06-15). Previously
      // `deposit-${referralId}` — keyed on the referral ALONE. A buyer who
      // started one cut, abandoned, then returned and picked a DIFFERENT cut
      // (different amount) hit Stripe's idempotency error: same key, different
      // request body → 500 → buyer locked out of checkout for ~24h (Stripe's
      // idempotency-key retention window). The cut is captured by the charge
      // composition (deposit amountCents + that cut's fullSaleCents — each cut
      // has distinct Quarter/Half/Whole Price), so folding both into the key
      // makes a cut change a NEW idempotent request instead of a hard wall,
      // while a true double-submit of the SAME cut still dedupes safely.
      idempotencyKey: `deposit-${input.referralId}-${input.amountCents}-${input.fullSaleCents}`,
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

// ---------------------------------------------------------------------------
// Phase 1B — commerce cart checkout (multi-line direct-charge Checkout Session)
// ---------------------------------------------------------------------------
//
// The MONEY path for the commerce platform (catalog → cart → checkout). Mirrors
// createDepositCheckout EXACTLY (same V2 direct-charge pattern on the rancher's
// connected account via the `stripeAccount` header, same apiVersion, same
// automatic_tax, same deterministic idempotency-key discipline) but for an
// arbitrary multi-variant cart instead of a single cow-share cut.
//
// Charge composition (what the buyer's card is hit for):
//   • one line item PER variant for its DEPOSIT × qty (the upfront reserve the
//     rancher collects now; the fulfillment balance is settled rancher-direct
//     later, exactly like the cow-share deposit flow)
//   • one COMBINED "BuyHalfCow service fee" line == applicationFeeCents (the
//     platform commission across every line, already summed by the caller)
//   • application_fee_amount == applicationFeeCents routes that combined fee to
//     the BHC platform account; the rest stays in the rancher's Connect balance.
//
// MONEY INVARIANT: application_fee_amount must be ≤ the charged total. The
// charged total is (Σ depositCents×qty) + applicationFeeCents, so the fee is
// always strictly less than the total by exactly the deposits sum (which is
// > 0 for any real cart). The caller additionally guarantees per-variant
// deposit < price and fee ≤ ~10% of price, so deposits comfortably exceed the
// fee. We do NOT clamp here — an inverted cart is a caller bug we want to
// surface, not silently paper over.

export interface CartCheckoutLineItem {
  /** Display label for the variant (shown on the buyer's Stripe receipt). */
  label: string;
  /** Per-unit deposit collected upfront, in cents. */
  depositCents: number;
  /** Per-unit full sale price in cents (for the receipt fee description only). */
  fullPriceCents: number;
  /** Quantity ordered for this variant. */
  qty: number;
}

export interface CreateCartCheckoutInput {
  rancherConnectAccountId: string; // acct_* — direct charge target
  tier: TierSlug;
  lineItems: CartCheckoutLineItem[];
  /**
   * Total platform commission across ALL lines, in cents, pre-computed by the
   * caller (Σ round(price_cents × qty × commissionRate)). Collected in full at
   * checkout as a single combined fee line + set as application_fee_amount.
   */
  applicationFeeCents: number;
  referralId?: string;
  buyerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  /**
   * Extra metadata stamped on BOTH the Checkout Session and the PaymentIntent.
   * The cart route passes { orderId } so the webhook can cross-check, though the
   * authoritative lookup is by Checkout Session id (stripe_checkout_session_id).
   */
  metadata?: Record<string, string>;
  /**
   * Caller-supplied STABLE idempotency key for the Stripe session create. When
   * set, it is used verbatim (the caller owns dedupe semantics) — the cart route
   * passes a key derived from {rancherId + sorted variantId:qty + buyer/ip} so a
   * rapid double-submit of the SAME cart reuses the FIRST Stripe session instead
   * of opening a second one. When unset, falls back to the legacy order-id seed
   * below (kept so any other caller's behavior is unchanged).
   */
  idempotencyKey?: string;
}

export async function createCartCheckout(
  input: CreateCartCheckoutInput,
): Promise<{ url: string; sessionId: string }> {
  const stripe = getStripeClient();

  // Build one Stripe line item per variant for its DEPOSIT × qty. The deposit
  // (not the full price) is what the buyer pays now — same upfront-reserve
  // model as createDepositCheckout. fullPriceCents only feeds the receipt
  // description so the buyer can see the balance owed at fulfillment.
  const lineItems: any[] = input.lineItems.map((li) => {
    const balancePerUnit = Math.max(0, li.fullPriceCents - li.depositCents);
    return {
      price_data: {
        currency: 'usd',
        product_data: {
          name: li.label,
          ...(balancePerUnit > 0
            ? {
                description: `Deposit now $${(li.depositCents / 100).toFixed(2)}/ea · balance $${(balancePerUnit / 100).toFixed(2)}/ea due to rancher at fulfillment`,
              }
            : {}),
        },
        unit_amount: li.depositCents,
      },
      quantity: li.qty,
    };
  });

  // Combined BHC service fee — ONE line for the whole cart (== application fee).
  // Omitted entirely when zero (e.g. Operator tier at 0% commission) so the
  // buyer's receipt has no $0.00 noise + application_fee_amount stays unset.
  if (input.applicationFeeCents > 0) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'BuyHalfCow service fee',
          description: 'Platform commission across your order — covers Stripe processing and order routing.',
        },
        unit_amount: input.applicationFeeCents,
      },
      quantity: 1,
    });
  }

  // Deterministic idempotency key.
  //
  // PREFERRED: the caller passes a STABLE key (input.idempotencyKey) derived
  // from the cart's identity {rancherId + sorted variantId:qty + buyer/ip}, NOT
  // from the freshly-minted order id. Keying on the cart's identity is what makes
  // a rapid double-submit reuse the FIRST session: the legacy order-id seed gave
  // each POST a brand-new order id → a brand-new key → a second Stripe session
  // (and the route created a second order + second reservation alongside it).
  //
  // FALLBACK (no key supplied — other callers): legacy behavior, keyed on the
  // order id + fee so a re-priced retry of the same order is treated as new
  // rather than colliding with a different request body (the failure mode the
  // deposit route's cut-specific key was added to avoid).
  let idempotencyKey: string;
  if (input.idempotencyKey) {
    idempotencyKey = input.idempotencyKey;
  } else {
    const idemSeed = input.metadata?.orderId || `${input.rancherConnectAccountId}-${input.lineItems.map((l) => `${l.label}:${l.depositCents}x${l.qty}`).join('|')}`;
    idempotencyKey = `cart-${idemSeed}-${input.applicationFeeCents}`;
  }

  const baseMetadata: Record<string, string> = {
    type: 'commerce_order',
    tier: input.tier,
    applicationFeeCents: String(input.applicationFeeCents),
    ...(input.referralId ? { referralId: input.referralId } : {}),
    ...(input.metadata || {}),
  };

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      line_items: lineItems,
      ...(input.buyerEmail ? { customer_email: input.buyerEmail } : {}),
      payment_intent_data: {
        // application_fee_amount routes the combined service fee to the BHC
        // platform account; the deposit lines stay in the rancher's Connect
        // balance. Omitted when zero (Operator tier) so Stripe doesn't reject
        // a 0-amount application fee.
        ...(input.applicationFeeCents > 0
          ? { application_fee_amount: input.applicationFeeCents }
          : {}),
        metadata: baseMetadata,
      },
      metadata: baseMetadata,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // Same as createDepositCheckout: customer_update intentionally omitted
      // (no `customer` set), automatic_tax still collects the buyer's address
      // during Checkout for tax calculation.
      automatic_tax: { enabled: true },
    },
    {
      stripeAccount: input.rancherConnectAccountId,
      idempotencyKey,
    },
  );

  const url = session.url;
  if (!url) {
    throw new Error('Stripe Checkout Session (cart) returned no url');
  }
  return { url, sessionId: session.id };
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
