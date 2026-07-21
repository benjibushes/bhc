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
// DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
// lib/demo/demoMode.ts. Pure import, no side effect when the flag is off.
import { isDemoMode } from '@/lib/demo/demoMode';

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
export function getStripeClient(): Stripe {
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

// Status classification lives in a zero-import module so it can be unit-tested
// without dragging in the Stripe client or the secrets chain. Re-exported here
// so existing callers (`import { ConnectAccountStatus } from '@/lib/stripeConnect'`)
// keep working unchanged.
import {
  classifyConnectStatus,
  canResumeConnectOnboarding,
  type ConnectAccountStatus,
  type ConnectStatusSignals,
} from './connectStatusClassify';
export { classifyConnectStatus, canResumeConnectOnboarding };
export type { ConnectAccountStatus, ConnectStatusSignals };

export interface ConnectStatusReadResult {
  cardPaymentsActive: boolean;
  onboardingComplete: boolean;
  requirementsStatus: string | null;
  status: ConnectAccountStatus;
  /** requirements.summary.currently_due length — how many KYC items Stripe is
   *  still actively blocking on. Surfaced so the dashboard can tell a stuck
   *  rancher EXACTLY how much is left ("Stripe still needs 2 things") instead of
   *  a vague "incomplete". */
  currentlyDueCount: number;
  /**
   * True when this account is NOT active because Stripe still has outstanding
   * KYC requirements (currently_due / past_due) — i.e. the kind of block a
   * fresh Stripe-hosted onboarding account-link resolves. This is the dominant
   * case for ranchers stuck mid-KYC (no bank / unaccepted TOS).
   *
   * When this is true the correct resume action is /api/rancher/connect/start
   * (which re-mints an onboarding link), NOT the subscription customer portal
   * (which cannot clear identity/bank/TOS requirements). When it's false on a
   * restricted account, the block is something an account-link can't fix (e.g.
   * a Stripe-side hold) and the rancher needs the portal / support.
   *
   * Does NOT affect `status` or the deposit gate — purely a routing hint.
   */
  canResumeOnboarding: boolean;
}

export async function getConnectAccountStatus(accountId: string): Promise<ConnectStatusReadResult> {
  const stripe = getStripeClient();
  // V2 retrieve w/ include — Stripe returns the full configuration +
  // requirements blocks needed to compute live status without a second
  // round-trip. The minimum_deadline field is one requirements-status
  // indicator on V2; capability_status_updated webhook events drive
  // incremental refresh.
  const account = await (stripe.v2.core.accounts as any).retrieve(accountId, {
    include: ['configuration.merchant', 'requirements'],
  });
  const cardPaymentsActive =
    (account as any)?.configuration?.merchant?.capabilities?.card_payments?.status === 'active';
  const summary = (account as any)?.requirements?.summary ?? {};
  const reqStatus = summary?.minimum_deadline?.status ?? null;
  const disabledReason = summary?.disabled_reason ?? null;
  // currently_due can come back as an array of entries; count its length.
  const currentlyDueRaw = summary?.currently_due;
  const currentlyDueCount = Array.isArray(currentlyDueRaw) ? currentlyDueRaw.length : 0;

  const { status, onboardingComplete } = classifyConnectStatus({
    cardPaymentsActive,
    requirementsStatus: reqStatus,
    disabledReason,
    chargesEnabled: cardPaymentsActive,
    currentlyDueCount,
  });

  // Routing hint (does NOT change `status` / the deposit gate). Pure + shared
  // with the classifier module so it's unit-tested in isolation.
  const canResumeOnboarding = canResumeConnectOnboarding(status, {
    requirementsStatus: reqStatus,
    currentlyDueCount,
  });

  return {
    cardPaymentsActive,
    onboardingComplete,
    requirementsStatus: reqStatus,
    status,
    currentlyDueCount,
    canResumeOnboarding,
  };
}

// ---------------------------------------------------------------------------
// Stage-3 Task 8 — buyer deposit direct-charge Checkout Session
// ---------------------------------------------------------------------------

import { TierSlug } from '@/lib/tiers';
import { absorbStripeFee } from '@/lib/feeMath';

export interface CreateDepositCheckoutInput {
  rancherConnectAccountId: string;  // acct_* — direct charge target
  tier: TierSlug;
  /**
   * THE commission rate for this deposit's application_fee — REQUIRED
   * (GO-LIVE MONEY HARDENING finding 1, 2026-07-02). Callers MUST resolve it
   * via depositCommissionRate(rancher, tier) (lib/tiers.ts) so a rancher's
   * locked `Commission Rate` field takes precedence over the tier constant.
   * Previously this was computed here from TIERS[tier].commissionRate alone,
   * which charged negotiated-rate ranchers' buyers the tier constant while
   * the billing page displayed the locked rate. Required (not defaulted) so
   * no call site can silently fall back to the tier constant again.
   */
  commissionRate: number;
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
  // WHITELABEL (2026-07-07): 'embedded' renders the deposit checkout in an
  // iframe ON buyhalfcow.com (mirrors createProductCheckout). Money model,
  // metadata, idempotency, and webhooks are byte-identical — presentation
  // only. Default 'hosted' keeps emailed/texted deposit links working
  // (admin invoice + rancher request-deposit callers).
  mode?: 'embedded' | 'hosted';
  returnUrl?: string; // required for embedded; absolute https URL
}

export async function createDepositCheckout(input: CreateDepositCheckoutInput): Promise<{ url?: string; clientSecret?: string; paymentIntentId: string; sessionId: string; connectAccountId: string }> {
  // DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
  // lib/demo/demoMode.ts. Return a fake checkout so the reserve/deposit button
  // doesn't error mid-video — NO Stripe call, no charge.
  if (isDemoMode()) {
    return {
      url: '/checkout/DEMO/deposit',
      clientSecret: 'cs_DEMO_deposit_secret',
      paymentIntentId: 'pi_DEMO_deposit',
      sessionId: 'cs_DEMO_deposit',
      connectAccountId: 'acct_DEMO',
    };
  }
  const isEmbedded = input.mode === 'embedded';
  // Fail loud on a mode/URL mismatch (mirrors createProductCheckout) — a
  // half-configured session must never reach Stripe.
  if (isEmbedded && !input.returnUrl) {
    throw new Error('embedded deposit checkout requires a returnUrl');
  }
  // Locked-rate precedence lives at the caller (depositCommissionRate) —
  // this function just applies the rate it was handed. Math below is
  // byte-identical to the old TIERS[tier].commissionRate path.
  const feeRate = input.commissionRate;
  // CRITICAL: commission is calculated on the FULL sale price, not on the
  // deposit. Rancher takes their full deposit upfront, BHC takes its full
  // commission upfront, and the rancher collects the fulfillment balance
  // (fullSaleCents − depositCents) directly outside BHC. Net result:
  // BHC commission is paid in full at deposit time regardless of how the
  // rancher splits the rest.
  const grossPlatformFeeCents = Math.round(input.fullSaleCents * feeRate);
  // Buyer pays the rancher's full deposit PLUS the full BHC service fee.
  // Rancher receives exactly `input.amountCents` (Stripe routes the total
  // to rancher's Connect acct, then transfers application_fee_amount to
  // the BHC platform acct).
  const totalChargedCents = input.amountCents + grossPlatformFeeCents;
  // NET-YOUR-NUMBER (2026-07-08): Stripe's processing fee comes out of the
  // rancher's balance (fees_collector='stripe'), so before this the rancher
  // actually netted deposit − ~2.9%. We now shrink our application fee by
  // the estimated processing cost (floored — see lib/feeMath) so the
  // rancher's payout lands on the promised deposit amount. Buyer price is
  // UNCHANGED (still amount + gross fee); the absorption comes out of BHC's
  // side only.
  const { feeCents: platformFeeCents, absorbedCents } = absorbStripeFee({
    grossFeeCents: grossPlatformFeeCents,
    totalChargeCents: totalChargedCents,
  });
  // Balance the rancher will collect later at fulfillment (outside BHC).
  // Stamped in metadata so the rancher dashboard + buyer receipt can
  // surface it without re-computing.
  const fulfillmentBalanceCents = Math.max(0, input.fullSaleCents - input.amountCents);

  // Direct charge w/ application_fee_amount. stripeAccount header routes
  // the total charge to the rancher's Connect account; Stripe splits funds
  // automatically (rancher gets total - fee = deposit, platform gets fee).
  // ONE line item (founder directive 2026-07-01): the BHC commission is baked
  // into the deposit price — the buyer must never see a "service fee" split.
  // Previously two line items ("deposit" + "BuyHalfCow service fee"); the fee
  // itemization caused checkout drop-off. unit_amount = totalChargedCents, so
  // the charge total is byte-identical to the old two-line sum; only the
  // hosted page/receipt PRESENTATION changed. application_fee_amount (below)
  // still routes the commission to the platform — rancher-side reporting is
  // untouched. Metadata keeps the full split for settlement/refund math.
  const stripe = getStripeClient();
  const lineItems: any[] = [
    {
      price_data: {
        currency: 'usd',
        product_data: {
          name: `Deposit — ${input.productLabel}`,
          description: 'Reserves your share. Remaining balance is paid directly to the rancher at fulfillment.',
        },
        unit_amount: totalChargedCents,
      },
      quantity: 1,
    },
  ];

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      line_items: lineItems,
      customer_email: input.buyerEmail,
      payment_intent_data: {
        application_fee_amount: platformFeeCents,
        // Card-statement anchor — direct charges print the rancher's Stripe
        // descriptor; the suffix adds the name the buyer recognizes (dispute
        // prevention on the highest-ticket charge). Truncated to 22 chars total.
        statement_descriptor_suffix: 'BUYHALFCOW',
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
          // NET-YOUR-NUMBER split: gross commission at the tier rate and the
          // processing absorption BHC granted (gross − platform fee). The
          // Monday scorecard's processing P&L reads these.
          grossPlatformFeeCents: String(grossPlatformFeeCents),
          absorbedStripeFeeCents: String(absorbedCents),
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
      // Embedded ⇒ ui_mode + return_url (Stripe redirects the parent page out
      // of the iframe on completion). Hosted ⇒ success/cancel. Never both.
      ...(isEmbedded
        ? { ui_mode: 'embedded' as const, return_url: input.returnUrl }
        : { success_url: input.successUrl, cancel_url: input.cancelUrl }),
      // CARD + WALLETS ONLY — Link is deliberately OFF (2026-07-14, live
      // incident): with dynamic payment methods, Stripe Link recognized a
      // buyer's email and walled the ENTIRE payment form behind "Confirm
      // it's you — enter the code sent to (•••) ••96" — an OTP to a possibly
      // years-old phone number, with only a tiny "Pay without Link" escape.
      // Blocked a real $827 deposit (Dave @ Champion Valley). Our ICP skews
      // older/less-technical; an OTP wall at the money moment costs more
      // than Link's one-tap saves. `payment_method_types: ['card']` still
      // renders Apple Pay / Google Pay (wallets ride the card method once
      // the domain is registered) — it removes only the Link OTP takeover.
      // Do NOT add `automatic_payment_methods` — PaymentIntent-only param,
      // 400s a Checkout Session.
      payment_method_types: ['card'],
      // No sales tax on deposits. BHC is Montana-based (no state sales tax) and
      // a deposit is a refundable reservation, not the final taxable sale.
      // Mirrors createTierCheckoutSession (#118). Keeping automatic_tax ON
      // previously ADDED tax on top of the deposit + the BHC service-fee line at
      // the hosted page, so the card was charged MORE than the "due now" the
      // deposit page quotes (deposit + fee, no tax line) → surprise-tax at the
      // final step = a top cause of deposit-checkout abandonment under paid ads.
      // (Note: `customer_update` must NOT be set without a `customer` param —
      // customer_email alone is insufficient — so we omit it. Disabling tax also
      // removes Stripe's address-collection requirement entirely.)
      automatic_tax: { enabled: false },
      // F2/A4 consent record on Stripe's side — Stripe requires the buyer to
      // tick "I agree to the terms" on the hosted page and stores the
      // acceptance on THEIR records: the strongest chargeback evidence.
      // ENV-GATED OFF BY DEFAULT: Stripe 400s session creation if the account
      // has no Terms of Service URL configured (and this is a direct charge on
      // the rancher's connected account, so the setting applies THERE). The
      // money path must never break on a Dashboard settings gap — Ben sets the
      // ToS URL in Stripe (Settings → Public details / Checkout), verifies one
      // session, then flips STRIPE_CONSENT_COLLECTION=true.
      ...(process.env.STRIPE_CONSENT_COLLECTION === 'true'
        ? { consent_collection: { terms_of_service: 'required' as const } }
        : {}),
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
      // v2 suffix (2026-07-14): Stripe pins an idempotency key to the EXACT
      // params of its first use for ~24h. Shipping the Link-off param change
      // under the old key made every re-mint 400 for referrals with a prior
      // attempt (live: Dave/Champion Valley, "that didn't go through").
      // BUMP THIS SUFFIX whenever session params change shape.
      idempotencyKey: `deposit-${input.referralId}-${input.amountCents}-${input.fullSaleCents}-v3`,
    },
  );
  const url = session.url;
  const paymentIntentId = session.payment_intent ? String(session.payment_intent) : '';
  // CLOVER (apiVersion 2026-02-25): Stripe creates the Checkout Session's
  // PaymentIntent when the buyer PAYS, not at session create — so
  // `session.payment_intent` is null here. That is EXPECTED, not an error.
  // The old guard `if (!paymentIntentId) throw` killed every deposit before
  // the buyer could pay (root cause of "0 deposits ever settled"). We now only
  // require the url; settlement matches the Payments row by referral
  // (pi.metadata.referralId) and backfills the real PI id on the
  // payment_intent.succeeded webhook (see markDepositSucceeded referral fallback).
  if (isEmbedded) {
    // session.url is null in embedded mode — the client mounts on client_secret.
    if (!session.client_secret) {
      throw new Error('Stripe Checkout Session returned no client secret');
    }
    return {
      clientSecret: session.client_secret,
      paymentIntentId,
      sessionId: session.id,
      connectAccountId: input.rancherConnectAccountId,
    };
  }
  if (!url) {
    throw new Error('Stripe Checkout Session returned no url');
  }
  // 2026-06-09: expose sessionId so caller can expire() the session if a
  // downstream recordDeposit fails. The Payments row is keyed on the referral
  // (PI id is empty until payment under Clover), so the webhook can still settle.
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
  /**
   * Override the fixed per-referral idempotency key. /r/f click-time re-mints
   * pass a varying key so a fresh session is minted after the old one expired;
   * send-final-invoice omits it (fixed key = double-submit protection).
   */
  idempotencyKey?: string;
}

export async function createFinalInvoiceCheckout(
  input: CreateFinalInvoiceCheckoutInput,
): Promise<{ url: string; paymentIntentId: string; sessionId: string }> {
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
      // Link OFF here too (2026-07-14) — same OTP-wall trap as the deposit
      // session, on the LARGER final-balance charge. Card + wallets only.
      payment_method_types: ['card'],
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
      // v2: same param-pinning rule as the deposit key above. Click-time
      // re-mints from /r/f pass their own varying key — the fixed key would
      // hand back the same (possibly expired) session for 24h.
      idempotencyKey: input.idempotencyKey || `final-invoice-${input.referralId}-v3`,
    },
  );

  const url = session.url;
  const paymentIntentId = session.payment_intent ? String(session.payment_intent) : '';
  // CLOVER: PaymentIntent is null until the buyer pays (see createDepositCheckout).
  // Final-invoice settlement anchors on Referral.Status='Closed Won' via
  // pi.metadata.referralId (settleFinalInvoice), NOT the PI id at create, so a
  // null PI here is fine — only the url is required to send the buyer to pay.
  if (!url) {
    throw new Error('Stripe Checkout (final invoice) returned no url');
  }
  return { url, paymentIntentId, sessionId: String(session.id || '') };
}
