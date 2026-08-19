// Stage-3 Task 8 — buyer deposit Stripe Checkout flow.
//
// Tier_v2 ranchers ONLY. Legacy ranchers route via their existing Payment
// Links on /ranchers/[slug] (not handled here).
//
// POST body: { referralId, cutSize: 'quarter'|'half'|'whole' }
// Reads rancher's tier + per-cut price + Connect account, creates
// direct-charge Checkout Session w/ application_fee_amount per tier.
//
// GET ?refId=X — returns rancher info + fulfillment details for the deposit page.

import { NextResponse } from 'next/server';
import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { createDepositCheckout, getConnectAccountStatus } from '@/lib/stripeConnect';
import { validateDepositConsent } from '@/lib/depositConsent';
import { recordDeposit } from '@/lib/contracts/payments';
import { depositRequestStampFields } from '@/lib/depositRequestStamp';
import { MIN_TIER_PRICE } from '@/lib/pricing';
// THE deposit resolution — one implementation, called by BOTH the POST charge
// path and the GET render path so the displayed total and the charged total
// cannot diverge (P0 2026-08-18; see lib/depositResolve.ts).
import { resolveDepositMoney, CUT_PRICE_FIELD, type DepositCut } from '@/lib/depositResolve';
import { tierFor, depositCommissionRate } from '@/lib/tiers';
import { resolveDepositAuth } from '@/lib/buyerAuth';
import { claimOnce } from '@/lib/rancherCapacity';
import { checkOriginGuard } from '@/lib/csrfGuard';
import { rateLimitStrict, getTrustedClientIp } from '@/lib/rateLimit';
import { fireCapi, buildUserData, getMetaCookiesFromRequest } from '@/lib/metaCapi';
import { metaEventId } from '@/lib/analytics';
import { absorbStripeFee } from '@/lib/feeMath';
import { isDepositAlreadyPaid } from '@/lib/depositPaidState';
import { hasServiceZipGate, buyerZipServedBy } from '@/lib/exclusiveZip';
import { ZIP_OUT_OF_AREA_MESSAGE } from '@/lib/buyerZip';
import { referralRailForRancher } from '@/lib/brokerRail';
import { depositRailForReferral, brokerSheetDelivery } from '@/lib/depositSuccessCopy';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

const CUT_LABELS: Record<string, string> = {
  quarter: 'Quarter Cow',
  half: 'Half Cow',
  whole: 'Whole Cow',
};

// ---------------------------------------------------------------------------
// POST — create Stripe Checkout Session
// ---------------------------------------------------------------------------

// Per-IP ceiling for the deposit Checkout Session mint (ad-readiness
// 2026-08-17). This route mints the card-charge PaymentIntent and had NO
// throughput ceiling at all, while its sibling money-mint
// (app/api/checkout/product/intent) has run rateLimitStrict since the checkout
// audit. Same helper, same posture: rateLimitStrict NEVER fails open — with
// Upstash missing or erroring it degrades to a per-instance in-memory window
// rather than unbounded (see lib/rateLimit.ts). A ceiling that evaporates
// exactly when Redis does is not a ceiling.
//
// WHY 20/min RATHER THAN THE SIBLING'S 12: this route is auth-gated (member
// session or referral-scoped deposit grant), so it is not the open anonymous
// card-testing farm the 12 was sized against — the limit here is a
// retry-storm/spike ceiling, not an abuse gate. Against that, paid Meta
// traffic is overwhelmingly mobile, and mobile carriers CGNAT many subscribers
// behind ONE egress IP: a per-IP bucket can legitimately carry several
// distinct buyers at once. 20 keeps real headroom for that while still capping
// a runaway retry loop at 20 Stripe session creates per minute per IP.
//
// It cannot block a real buyer: a declined card does NOT re-hit this route
// (the Payment Element retries client-side against the existing clientSecret),
// so one buyer's whole session is a handful of POSTs — continue-click, an
// optional hosted-fallback re-POST, a cut change, a cancel-and-retry. The
// per-referral claimOnce below already serializes those to one create per 30s.
const DEPOSIT_MINTS_PER_MINUTE_PER_IP = 20;

export async function POST(req: Request) {
  const rl = await rateLimitStrict(`deposit-session:${getTrustedClientIp(req)}`, {
    requests: DEPOSIT_MINTS_PER_MINUTE_PER_IP,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many attempts — wait a minute and try again. Your card was not charged.' },
      { status: 429 },
    );
  }

  if (process.env.STRIPE_CONNECT_ENABLED !== 'true') {
    return NextResponse.json({ error: 'Stripe Connect not enabled' }, { status: 503 });
  }

  // CSRF defense-in-depth — Origin allowlist on top of SameSite=lax cookie.
  // Blocks malicious sites from auto-submitting forms that POST here with
  // a logged-in buyer's cookie. Added 2026-06-04 audit fix.
  const originCheck = checkOriginGuard(req);
  if (!originCheck.ok && originCheck.response) return originCheck.response;

  let body: any = {};
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

  const referralId = String(body.referralId || '').trim();
  const cutSize = String(body.cutSize || '').toLowerCase();
  // WHITELABEL (2026-07-07): the deposit page requests { mode: 'embedded' } to
  // render checkout ON buyhalfcow.com; anything else stays hosted-redirect
  // (emailed/texted links, no-publishable-key fallback). Same money path.
  const wantEmbedded = body.mode === 'embedded';
  if (!referralId) return NextResponse.json({ error: 'referralId required' }, { status: 400 });
  if (!CUT_LABELS[cutSize]) return NextResponse.json({ error: 'cutSize must be quarter|half|whole' }, { status: 400 });

  // F2/A4 consent gate — NEW session creates require explicit ToS + refund-
  // policy acceptance (the deposit page's required checkbox sends
  // termsAccepted: true). No acceptance record = weak chargeback rebuttal.
  // Strict boolean check (see lib/depositConsent). GET is untouched.
  if (!validateDepositConsent(body)) {
    return NextResponse.json(
      { error: 'terms_required', message: 'Please agree to the Terms and refund policy to continue.' },
      { status: 400 },
    );
  }

  // Auth: full member session OR the referral-scoped deposit grant (campaign
  // 1-tap link). resolveDepositAuth pins the grant to THIS referralId, so a
  // forwarded link's grant can't pay a different referral. Ownership is still
  // re-checked below against referral.Buyer.
  const session = await resolveDepositAuth(req, referralId);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  // Look up referral + verify buyer ownership
  let referral: any;
  try {
    referral = await getRecordById(TABLES.REFERRALS, referralId);
  } catch {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  }
  if (!referral) return NextResponse.json({ error: 'Referral not found' }, { status: 404 });

  const buyerLinks: string[] = referral['Buyer'] || [];
  if (!buyerLinks.includes(session.consumerId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Terminal-status gate. A closed referral must not be re-paid — without
  // this, a buyer who hits the deposit page after closure can pay a second
  // PaymentIntent, create a duplicate Payments row, re-fire recordClose,
  // and trigger a second Telegram celebration. Block both POST + GET so
  // the deposit page surfaces "already paid" state via the 409.
  const refStatus = String(referral['Status'] || '');
  // Re-pay guard — lib/depositPaidState (pure, tested). A settled deposit
  // stamps `Deposit Paid At` (+ Status 'Awaiting Payment'); a rancher REQUEST
  // also flips Status to 'Awaiting Payment' but stamps only 'Deposit Requested
  // At' — that requested-but-unpaid state MUST stay payable (2026-07-14
  // bricked-buyer bug: bare status===Awaiting Payment read as paid → every
  // requested deposit 409'd "already paid" while the emailed Stripe link died
  // at 24h — 8 requested, 0 payable).
  const depositAlreadyPaid = isDepositAlreadyPaid(referral);
  if (refStatus === 'Closed Won' || refStatus === 'Closed Lost' || depositAlreadyPaid) {
    return NextResponse.json(
      {
        error: 'referral_closed',
        status: refStatus,
        message: refStatus === 'Closed Lost'
          ? 'This referral is closed and can\'t be reopened — contact us to re-route.'
          : 'This reservation is already paid. Check your email for the confirmation.',
      },
      { status: 409 },
    );
  }

  const rancherLinks: string[] = referral['Rancher'] || referral['Suggested Rancher'] || [];
  const rancherId = rancherLinks[0];
  if (!rancherId) return NextResponse.json({ error: 'No rancher on referral' }, { status: 409 });

  // Look up rancher
  let rancher: any;
  try {
    rancher = await getRecordById(TABLES.RANCHERS, rancherId);
  } catch {
    return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
  }

  // ── RAIL GATE (RAIL-MATRIX 2026-08-04) — this route charges CONNECT
  // economics only (deposit + BHC fee ON TOP via application_fee on the
  // rancher's connected account). It must therefore refuse any rancher whose
  // rail is not unambiguously Connect, mirroring the broker route's mirror-
  // image gates:
  //   'ambiguous' — flagged Broker Rail AND carrying a Connect footprint. The
  //     broker route refuses this as a data error a human resolves; without
  //     this check the CONNECT route silently won the conflict and charged the
  //     buyer a fee on top for a rancher Ben may be representing. Refuse — a
  //     coin flip with money is not code's call.
  //   'broker' — a represented ranch. Its deposit is BHC's whole commission on
  //     BHC's own account; charging it here would route the money to a Connect
  //     account it doesn't have (and the legacy branch below would emit a
  //     broken /ranchers/ redirect, since a represented ranch has no slug).
  //     Redirect to the broker checkout, which re-gates everything.
  const railForRancher = referralRailForRancher(rancher);
  if (railForRancher === 'ambiguous') {
    console.error(
      `[checkout/deposit] AMBIGUOUS RAIL for rancher ${rancherId} — flagged Broker Rail AND carrying a Stripe Connect footprint. Refusing to charge.`,
    );
    return NextResponse.json(
      { error: 'ambiguous_rail', message: 'This ranch is misconfigured — we can\'t take a payment for it. Please contact us.' },
      { status: 409 },
    );
  }
  if (railForRancher === 'broker') {
    return NextResponse.json(
      {
        error: 'not_connect_rail',
        redirectUrl: `/checkout/${referralId}/broker`,
        message: 'This ranch checks out through our represented-seller flow.',
      },
      { status: 409 },
    );
  }

  // Legacy rancher? Redirect buyer to their landing page payment links
  const pricingModel = String(rancher['Pricing Model'] || 'legacy');
  if (pricingModel === 'legacy') {
    return NextResponse.json(
      {
        error: 'legacy_rancher',
        redirectUrl: `/ranchers/${rancher['Slug'] || ''}`,
        message: `${rancher['Operator Name'] || rancher['Ranch Name']} uses their own checkout — same beef, just a different payment page.`,
      },
      { status: 409 },
    );
  }

  // ── EXCLUSIVE-ZIP GATE (2026-07-25) ──────────────────────────────────────
  // Last money gate before a charge, so it runs here too — reserve/qualify are
  // upstream doors, but an emailed or campaign deposit link lands straight on
  // this route. `hasServiceZipGate` short-circuits FIRST on purpose: for every
  // rancher alive today (no `Service ZIP Prefixes`) this block does nothing at
  // all — not even the extra Consumers read — so the deposit path keeps its
  // exact current latency and call count. Only a contracted-territory rancher
  // pays for the lookup. Fail CLOSED: a read failure leaves the ZIP unknown,
  // and buyerZipServedBy rejects an unknown ZIP for a gated rancher.
  if (hasServiceZipGate(rancher)) {
    const buyerRec: any = await getRecordById(TABLES.CONSUMERS, session.consumerId).catch(() => null);
    if (!buyerZipServedBy(buyerRec?.['Zip'], rancher)) {
      return NextResponse.json(
        { error: 'out_of_area', message: ZIP_OUT_OF_AREA_MESSAGE, redirectUrl: '/access' },
        { status: 409 },
      );
    }
  }

  // Tier_v2 gates
  const tier = tierFor(rancher);
  if (!tier) {
    return NextResponse.json({ error: 'Rancher tier not set — cannot accept deposits yet' }, { status: 409 });
  }
  if (String(rancher['Stripe Connect Status'] || '') !== 'active') {
    return NextResponse.json({ error: 'Rancher bank not connected — cannot accept deposits yet' }, { status: 409 });
  }
  const connectAccountId = String(rancher['Stripe Connect Account Id'] || '');
  if (!connectAccountId) {
    return NextResponse.json({ error: 'Rancher Stripe Connect Account missing' }, { status: 409 });
  }

  // Live Connect status re-check — self-heal only, OFF the response path (E2/m8).
  // The cached `Stripe Connect Status` gate above already passed. Previously we
  // AWAITED a live Stripe account read here (~200-500ms, serial) on EVERY
  // deposit POST just to catch the rare stale-'active' case. The buyer-facing
  // money guard doesn't need the await: a genuinely restricted/disabled account
  // fails createDepositCheckout at Stripe below, which maps to the friendly
  // 'checkout_failed' response ("your card was not charged") — no charge can
  // ever land on a dead account. What IS load-bearing is the SELF-HEAL write:
  // when Stripe flips a rancher active→restricted and the Connect webhook
  // misses it (CONNECT_WEBHOOK_SECRET has been unset/wrong in prod), this
  // correction is the only mechanism that un-sticks the cached field so
  // ROUTING stops sending new buyers to the broken rancher. Keep the
  // correction, fire-and-forget — same pattern as the CAPI fires below.
  void (async () => {
    try {
      const live = await getConnectAccountStatus(connectAccountId);
      if (live.status !== 'active') {
        console.warn(`[checkout/deposit] stale Connect status for rancher ${rancherId}: cached=active live=${live.status} — self-healing`);
        await updateRecord(TABLES.RANCHERS, rancherId, { 'Stripe Connect Status': live.status });
      }
    } catch (statusErr: any) {
      console.error('[checkout/deposit] background Connect status re-check failed (cached gate already passed):', statusErr?.message);
    }
  })();

  // Subscription status gate. past_due/unpaid/canceled ranchers cannot accept
  // deposits — prevents payments to ranchers in Stripe collections.
  const subscriptionStatus = String(rancher['Subscription Status'] || '');
  if (subscriptionStatus === 'past_due' || subscriptionStatus === 'unpaid' || subscriptionStatus === 'canceled') {
    return NextResponse.json(
      {
        error: `Rancher subscription is ${subscriptionStatus} — checkout temporarily unavailable. Please contact hello@buyhalfcow.com.`,
      },
      { status: 409 }
    );
  }

  // Compute per-cut price + deposit (Airtable fields hold dollars).
  // Full Price = total sale value. Deposit = upfront payment the rancher
  // requires before going to slaughter. Commission is calculated on FULL
  // Price and collected upfront — rancher collects the remaining balance
  // (Full − Deposit) directly at fulfillment.
  const cut = cutSize as DepositCut;
  const fullSaleDollars = Number(rancher[CUT_PRICE_FIELD[cut]]);
  if (!Number.isFinite(fullSaleDollars) || fullSaleDollars <= 0) {
    return NextResponse.json(
      { error: `Rancher hasn't set a ${CUT_LABELS[cutSize]} price yet — contact rancher` },
      { status: 409 },
    );
  }
  // Charge-time per-lb mis-entry guard: a positive price below MIN_TIER_PRICE is
  // almost certainly a per-pound value typed as a total. Refuse to charge rather
  // than bill a buyer ~$7.40 for a whole cow. Backstops the setup-route floor in
  // case a broken price was published before that guard existed (e.g. DD Ranch).
  if (fullSaleDollars < MIN_TIER_PRICE) {
    return NextResponse.json(
      { error: `${CUT_LABELS[cutSize]} pricing looks misconfigured — please contact the rancher before paying` },
      { status: 409 },
    );
  }
  // ── THE deposit + fee resolution (P0 2026-08-18) ─────────────────────────
  // resolveDepositMoney (lib/depositResolve) is the SINGLE implementation, and
  // the GET render path below calls the very same function with the very same
  // arguments. Before this, the charge honored a rancher's custom quote while
  // buildCut did not even read the referral for money — so a quoted referral
  // rendered one number and charged another (Silverline Quarter: page $695.00,
  // card $795.00). There is now exactly one number, by construction.
  //
  // Precedence (see lib/depositResolve): rancher's quote for THIS cut and ask →
  // rancher's stored per-cut deposit → derived ~25% reserve. Every rung is
  // bounded 0 < deposit ≤ price, so the buyer always pays a real partial and
  // the balance at pickup stays positive.
  //
  // RATE SOURCE (finding 1, 2026-07-02): the rancher's LOCKED Commission Rate
  // wins over the tier constant (depositCommissionRate — same precedence the
  // billing page displays and the tier-subscription webhook preserves), so the
  // charged fee, the displayed fee, and the emailed fee are all the locked
  // rate. Resolved HERE (rather than further down, where it used to live) so
  // one call produces the deposit AND the fee together — a split between the
  // two resolutions is exactly the class of drift this P0 was.
  const feeRate = depositCommissionRate(rancher, tier);
  // BHC service fee is computed against the FULL sale price — not the deposit.
  // Rancher collects the fulfillment balance directly outside BHC, so the
  // commission is paid in full at deposit time, ADDED ON TOP of the rancher's
  // deposit (rancher receives the full deposit, buyer pays deposit + fee).
  const money = resolveDepositMoney(referral, rancher, cut, feeRate);
  if (!money) {
    // Unreachable — the price guards above already rejected a missing/invalid
    // price, which is the only way resolveDepositMoney returns null. Kept as a
    // fail-closed backstop: never fall through to a guessed amount.
    return NextResponse.json(
      { error: `Rancher hasn't set a ${CUT_LABELS[cutSize]} price yet — contact rancher` },
      { status: 409 },
    );
  }

  const fullSaleCents = money.fullCents;
  const amountCents = money.depositCents;

  const buyerEmail = String(referral['Buyer Email'] || '').trim();
  if (!buyerEmail) return NextResponse.json({ error: 'Buyer email missing on referral' }, { status: 409 });

  const productLabel = `${CUT_LABELS[cutSize]} — ${rancher['Ranch Name'] || rancher['Operator Name']}`;

  // Tier capitalization for Payments table.
  // Hybrid path: 'legacy_connect' → 'Legacy Connect' (space, title case to match Airtable singleSelect choice).
  // Standard tiers: pasture/ranch/operator → Pasture/Ranch/Operator.
  const tierCapitalized = (
    tier === 'legacy_connect'
      ? 'Legacy Connect'
      : (tier.charAt(0).toUpperCase() + tier.slice(1))
  ) as 'Pasture' | 'Ranch' | 'Operator' | 'Legacy Connect';

  // NET-YOUR-NUMBER (2026-07-08): buyer total still carries the GROSS
  // commission (price unchanged), but the application fee Stripe actually
  // takes is absorbed down by the processing estimate (lib/feeMath) so the
  // rancher nets their full deposit. This mirror of createDepositCheckout's
  // math exists ONLY so recorded fee === charged fee (the #247 invariant);
  // both sides call the same absorbStripeFee. Absorption moves the
  // platform/rancher SPLIT only — totalChargedCents (what the buyer's card is
  // hit for, and what the deposit page renders as dueNowCents) is built from
  // the GROSS fee and is untouched by it.
  const grossPlatformFeeCents = money.feeCents;
  const totalChargedCents = money.dueNowCents;
  const { feeCents: platformFeeCents } = absorbStripeFee({
    grossFeeCents: grossPlatformFeeCents,
    totalChargeCents: totalChargedCents,
  });

  // M5/C5 concurrent-create serialization. The re-pay guard above only trips
  // on POST-settlement signals (Deposit Paid At / Awaiting Payment / Slot
  // Locked) — nothing is stamped while a Checkout Session is merely LIVE.
  // Two concurrent POSTs for DIFFERENT cuts (Tab A=Quarter, Tab B=Half) both
  // pass it, and the Stripe idempotency key varies by cut (amount+fullSale
  // folded in), so each tab gets its own live hosted page → the buyer can
  // complete both and pay TWO deposits. Serialize session creation per
  // referral with a short-lived atomic claim (SET NX EX via claimOnce).
  // No release helper exists — on any failure after the claim (Stripe error,
  // recordDeposit fail) the TTL expires naturally and the buyer retries.
  //
  // TTL 30s (was 120s — buyer-trust tail #3): the claim also traps the
  // HIGHEST-recovery buyer — one who cancels on Stripe's hosted page and
  // immediately retries hits this 409 until the TTL lapses. 120s meant up to
  // two minutes locked out at the exact moment they were ready to pay again.
  // 30s still comfortably covers the concurrent-tab create window (the Stripe
  // session create is sub-second; serial stacking barely changes), while the
  // cancel→retry path is usually past 30s by the time the buyer is back and
  // re-clicks. Copy below matches the number so the wait is honest.
  let depositCreateClaimed = true;
  try {
    depositCreateClaimed = await claimOnce(`deposit-create:${referralId}`, 30);
  } catch (claimErr: any) {
    // Never let claim infrastructure block a legitimate buyer — fail open.
    console.warn('[checkout/deposit] deposit-create claim errored (allowing):', claimErr?.message);
    depositCreateClaimed = true;
  }
  if (!depositCreateClaimed) {
    return NextResponse.json(
      {
        error: 'checkout_in_progress',
        message: 'Hang on — a checkout for this reservation was just started (maybe in another tab). Use that tab, or give it ~30 seconds and try again.',
      },
      { status: 409 },
    );
  }

  // Create Stripe Checkout Session
  let result: { url?: string; clientSecret?: string; paymentIntentId: string; sessionId: string; connectAccountId: string };
  try {
    result = await createDepositCheckout({
      rancherConnectAccountId: connectAccountId,
      tier,
      // Same locked-rate-aware rate as platformFeeCents above — the actual
      // Stripe application_fee and the recorded fee can never diverge.
      commissionRate: feeRate,
      amountCents,
      fullSaleCents,
      buyerEmail,
      referralId,
      buyerId: session.consumerId,
      rancherId,
      productLabel,
      successUrl: `${SITE_URL}/checkout/${referralId}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${SITE_URL}/checkout/${referralId}/deposit?canceled=1`,
      mode: wantEmbedded ? 'embedded' : 'hosted',
      returnUrl: `${SITE_URL}/checkout/${referralId}/success?session_id={CHECKOUT_SESSION_ID}`,
    });
  } catch (e: any) {
    // Log the technical detail server-side ONLY. Return a stable machine code +
    // a customer-safe message — never the raw Stripe/SDK string (that leaked to
    // buyers as "Checkout failed: ...incomplete fields..."). The deposit page
    // maps 'checkout_failed' to a friendly retry state.
    console.error('[checkout/deposit] Stripe Checkout create failed:', e?.message);
    return NextResponse.json(
      { error: 'checkout_failed', message: 'We could not start your reservation. Your card was not charged.' },
      { status: 500 },
    );
  }

  // Record pending payment. If this fails the buyer must NOT be sent to Stripe —
  // a paid PaymentIntent with no Payments row is invisible to the webhook
  // (markDepositSucceeded looks up by Stripe Payment Intent Id) and produces
  // an orphan deposit. Fail the request and let the buyer retry; the Stripe
  // session will expire harmlessly.
  try {
    await recordDeposit({
      referralId,
      buyerId: session.consumerId,
      rancherId,
      tier: tierCapitalized,
      amountCents,
      platformFeeCents,
      stripePaymentIntentId: result.paymentIntentId,
      // Clover: paymentIntentId is EMPTY at create time (PI is created when
      // the buyer pays). The session id is the only Stripe key the row has
      // until settlement backfills the PI — the orphan-reaper heals via it.
      stripeCheckoutSessionId: result.sessionId,
    });
  } catch (e: any) {
    console.error('[checkout/deposit] recordDeposit failed — expiring Stripe Session to prevent orphan payment:', e);
    // 2026-06-09 fix: previously left Stripe Session live. Buyer could
    // still complete checkout → succeeded PI with no Payments row →
    // markDepositSucceeded silent no-op → money lands in rancher's
    // Connect account with NO referral close + NO Telegram celebration.
    // Expire the Session NOW so the buyer can't complete it.
    try {
      const { expireCheckoutSession } = await import('@/lib/stripeConnect');
      await expireCheckoutSession({
        sessionId: result.sessionId,
        connectAccountId: result.connectAccountId,
      });
    } catch (expireErr: any) {
      // Best-effort. Log loudly so operator can manually expire via Stripe Dashboard.
      console.error(
        '[checkout/deposit] CRITICAL: Stripe Session expire ALSO failed — orphan risk:',
        expireErr?.message,
        'sessionId:', result.sessionId,
        'rancherId:', rancherId,
      );
      try {
        const { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } = await import('@/lib/telegram');
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🚨 <b>ORPHAN STRIPE SESSION</b>\n\nrecordDeposit + expireCheckoutSession both failed.\n\nSession id: <code>${result.sessionId}</code>\nRancher: ${rancherId}\nReferral: ${referralId}\n\n<i>Manually expire in Stripe Dashboard NOW or buyer can complete + cause silent succeeded PI with no Payments row.</i>`,
        );
      } catch {}
    }
    return NextResponse.json({ error: 'Could not record deposit. Please try again.' }, { status: 500 });
  }

  // F2/A4 consent stamp — record WHEN the buyer accepted the Terms + refund
  // policy on the referral itself, so a chargeback rebuttal can cite it.
  // BEST-EFFORT by design: no updateRecord touches the Referral at create
  // time today (Payments row via recordDeposit is the only write), so this is
  // its own call — and a stamp failure must NEVER block the money path.
  // Requires a 'Terms Accepted At' dateTime field on Referrals; Airtable
  // rejects/strips unknown fields, which the catch tolerates. When
  // STRIPE_CONSENT_COLLECTION is on, Stripe records acceptance on their side
  // as the primary evidence; this stamp is the operator-visible copy.
  //
  // The SAME write also marks the deal as an outstanding ask (2026-08-19).
  // Three routes stamped 'Deposit Requested At' when a rancher or admin asked
  // for the deposit; this one — the main self-serve rail — stamped nothing, so
  // a buyer who minted their own session was invisible to the strong chase
  // query AND({Status}="Awaiting Payment", NOT({Deposit Requested At}=""),
  // {Deposit Paid At}="") and absent from owed-deposit totals. A live $900
  // checkout sat at 'Rancher Contacted' for two days in no open-ask report.
  //
  // ⚠️ Status and the request stamp are INSEPARABLE — lib/depositPaidState
  // reads a bare 'Awaiting Payment' with no request stamp as ALREADY PAID, so
  // writing the status alone would 409 the buyer "already paid" having paid
  // nothing (the 2026-07-14 bricked-buyer bug). lib/depositRequestStamp emits
  // both keys or neither, and returns null when the referral is already
  // stamped so a retry cannot push the timestamp forward and quietly reset the
  // nudge cadence.
  //
  // No 'Deposit Checkout URL' is written: the only URL this route holds is
  // Stripe's hosted one, which dies at 24h, and persisting it would hand the
  // nudge emails a dead link. The nudge path mints its own durable /r/ link.
  const stampNowISO = new Date().toISOString();
  const requestStamp = depositRequestStampFields(referral, {
    cut: cutSize,
    depositDollars: Math.round(amountCents / 100),
    fullSaleDollars: Math.round(fullSaleCents / 100),
    checkoutUrl: '',
    nowISO: stampNowISO,
  });
  try {
    await updateRecord(TABLES.REFERRALS, referralId, {
      'Terms Accepted At': stampNowISO,
      ...(requestStamp || {}),
    });
  } catch (stampErr: any) {
    console.warn(
      '[checkout/deposit] referral stamp failed (non-blocking — Stripe session + Payments row already exist):',
      stampErr?.message,
    );
  }

  // ── Meta Conversions API: server-side `InitiateCheckout` event ──────
  // Buyer landed on the deposit page and clicked through to Stripe Checkout.
  // Client Pixel loses 30-50% to iOS 14.5+ ATT + adblockers. Deduped with
  // client Pixel via event_id=<referralId>. Fire-and-forget. We look up
  // the buyer's Consumer row best-effort for richer user_data (state,
  // first name) — failure logs but never blocks the Stripe redirect.
  // E4 efficiency (m8): that Consumer read used to be AWAITED on the response
  // path — an Airtable round-trip serialized in front of the buyer's redirect
  // to Stripe, purely for analytics enrichment. Capture the request-derived
  // bits synchronously (headers/cookies), then do the read + fire inside the
  // same detached async block so the {url} response never waits on it.
  try {
    const capiIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const capiUserAgent = req.headers.get('user-agent') || undefined;
    const { fbp: capiFbp, fbc: capiFbc } = getMetaCookiesFromRequest(req);

    void (async () => {
      let buyer: any = null;
      try {
        buyer = await getRecordById(TABLES.CONSUMERS, session.consumerId);
      } catch {}
      const buyerFullName = String(buyer?.['Full Name'] || '').trim();
      const buyerFirstName = buyerFullName.split(/\s+/)[0] || undefined;
      const buyerState = String(buyer?.['State'] || '') || undefined;
      const buyerPhone = String(buyer?.['Phone'] || '') || undefined;

      await fireCapi([{
        event_name: 'InitiateCheckout',
        event_time: Math.floor(Date.now() / 1000),
        event_id: metaEventId(referralId),
        action_source: 'website',
        event_source_url: `${SITE_URL}/checkout/${referralId}/deposit`,
        user_data: buildUserData({
          email: buyerEmail,
          phone: buyerPhone,
          firstName: buyerFirstName,
          state: buyerState,
          ip: capiIp,
          userAgent: capiUserAgent,
          fbp: capiFbp,
          fbc: capiFbc,
        }),
        custom_data: {
          // Pixel/CAPI value = TOTAL the buyer will charge to their card
          // (deposit + BHC service fee) so it matches the eventual Purchase
          // event value + buyer's bank statement. Keeps ROAS attribution clean.
          value: totalChargedCents / 100,
          currency: 'usd',
          content_name: `Beef deposit — ${CUT_LABELS[cutSize]}`,
          content_category: tier,
        },
      }]);
    })().catch((e) => console.error('[meta-capi] deposit InitiateCheckout fire failed:', e));
  } catch (e) {
    console.error('[meta-capi] deposit InitiateCheckout setup failed:', e);
  }

  if (wantEmbedded) {
    // connectAccountId is NOT a secret — the browser needs it to scope
    // Stripe.js to the connected account for the direct-charge embedded form.
    return NextResponse.json({ clientSecret: result.clientSecret, connectAccountId: result.connectAccountId });
  }
  return NextResponse.json({ url: result.url });
}

// ---------------------------------------------------------------------------
// GET ?refId=X — deposit info for the buyer deposit page
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  const url = new URL(req.url);
  const referralId = url.searchParams.get('refId') || '';
  if (!referralId) return NextResponse.json({ error: 'refId required' }, { status: 400 });

  // Member session OR referral-scoped deposit grant (campaign 1-tap link).
  const session = await resolveDepositAuth(req, referralId);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  let referral: any;
  try { referral = await getRecordById(TABLES.REFERRALS, referralId); }
  catch { return NextResponse.json({ error: 'Referral not found' }, { status: 404 }); }
  if (!referral) return NextResponse.json({ error: 'Referral not found' }, { status: 404 });

  const buyerLinks: string[] = referral['Buyer'] || [];
  if (!buyerLinks.includes(session.consumerId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // LEAK 3 (2026-07-05, deposit-rail visibility): stamp 'Deposit Link Opened
  // At' ONCE on the buyer's first authed load of their deposit page — proof
  // the buyer SAW the link, independent of email-open tracking (which is
  // unwired). Drives the sent→opened→paid status line on the rancher card.
  // Fire-and-forget + once-only: NEVER blocks or fails the GET; a strip
  // (field missing) just loses the breadcrumb, nothing else.
  if (!referral['Deposit Link Opened At']) {
    updateRecord(TABLES.REFERRALS, referralId, {
      'Deposit Link Opened At': new Date().toISOString(),
    }).catch((e: any) =>
      console.warn('[checkout/deposit] opened-at stamp failed (non-fatal):', e?.message),
    );
  }

  // Terminal-status gate. A closed referral must not be re-paid — without
  // this, a buyer who hits the deposit page after closure can pay a second
  // PaymentIntent, create a duplicate Payments row, re-fire recordClose,
  // and trigger a second Telegram celebration. Block both POST + GET so
  // the deposit page surfaces "already paid" state via the 409.
  const refStatus = String(referral['Status'] || '');
  // Re-pay guard — lib/depositPaidState (pure, tested). A settled deposit
  // stamps `Deposit Paid At` (+ Status 'Awaiting Payment'); a rancher REQUEST
  // also flips Status to 'Awaiting Payment' but stamps only 'Deposit Requested
  // At' — that requested-but-unpaid state MUST stay payable (2026-07-14
  // bricked-buyer bug: bare status===Awaiting Payment read as paid → every
  // requested deposit 409'd "already paid" while the emailed Stripe link died
  // at 24h — 8 requested, 0 payable).
  const depositAlreadyPaid = isDepositAlreadyPaid(referral);
  if (refStatus === 'Closed Won' || refStatus === 'Closed Lost' || depositAlreadyPaid) {
    // Resolve the linked rancher's slug even on the already-paid branch. The
    // success page renders AFTER payment (Status flips to Awaiting Payment),
    // so EVERY success-page GET hits this 409 — without surfacing the slug,
    // the refer-a-friend share link could never build a real /ranchers/<slug>
    // deep-link and always fell back to /access. Best-effort: a lookup failure
    // just omits the slug (link degrades to the /access fallback, never dead).
    let paidSlug = '';
    // T2.2 (2026-07-02): also surface the buyer's OWN affiliate code (minted
    // silently at deposit-settle, stamped on Consumers). The success page
    // appends it to the share link as ?ref=<code> so shared reservations
    // attribute + pay the referrer at close. Best-effort — a missing code
    // degrades the share link to untracked, never blocks the paid state.
    let paidAffiliateCode = '';
    // Buyer-paid total (deposit + baked-in commission) for the success-page
    // client Purchase Pixel. Read from the settled Payments row's Total Charged
    // Cents so the client Purchase value MATCHES the server CAPI deposit Purchase
    // exactly (both = pi.amount). Falls back to the referral's Deposit Amount
    // (rancher portion) when the Payments row/field is unreadable — a value the
    // buyer still recognizes; never blocks the paid state. In the SAME parallel
    // batch as the rancher/consumer reads, so it adds no latency.
    let depositValue = 0;
    // RAIL (broker-rail truthfulness, 2026-08-17). Every success-page load
    // lands on this branch, and this is the ONLY place the page can learn which
    // rail it is rendering for: the deposit success page is the success_url of
    // BOTH the Connect and the broker checkout, and its "what happens next"
    // story (message thread, rancher accepts the slot, Stripe payout) is
    // Connect machinery a represented ranch does not have. The rancher record
    // is already being read here, so the rail costs no extra Airtable call.
    // A FAILED rancher read does not downgrade a broker sale to the Connect
    // story: depositRailForReferral falls back to the referral's own Match
    // Type, which is stamped at mint and needs no extra read.
    let paidRail: 'connect' | 'broker' = depositRailForReferral(referral, null);
    // Broker only: did the represented ranch actually receive the fulfillment
    // sheet? Derived from the settlement stamp on the referral's Notes; the
    // page claims "we told them" only when that says so. `Notes` itself is
    // operator-internal and never leaves the server — only this verdict does.
    let rancherNotified: 'delivered' | 'not-delivered' | 'unknown' | undefined;
    // Rancher/ranch name for the post-deposit copy. Previously only the slug
    // came back, so the page addressed every paid buyer's ranch as "your
    // rancher"; the broker copy in particular has to name the ranch the buyer
    // will actually be dealing with.
    let paidRancherName = '';
    let paidRanchName = '';
    try {
      const paidRancherId = (referral['Rancher'] || referral['Suggested Rancher'] || [])[0];
      const { findPaymentsByReferral } = await import('@/lib/contracts/payments');
      const [paidRancher, paidConsumer, paidPayments]: any[] = await Promise.all([
        paidRancherId
          ? getRecordById(TABLES.RANCHERS, paidRancherId).catch(() => null)
          : Promise.resolve(null),
        getRecordById(TABLES.CONSUMERS, session.consumerId).catch(() => null),
        findPaymentsByReferral(referralId, { statusClause: `{Status} = "succeeded"` }).catch(() => []),
      ]);
      paidSlug = String(paidRancher?.['Slug'] || '');
      paidRancherName = String(paidRancher?.['Operator Name'] || paidRancher?.['Ranch Name'] || '');
      paidRanchName = String(paidRancher?.['Ranch Name'] || '');
      paidRail = depositRailForReferral(referral, paidRancher);
      paidAffiliateCode = String(paidConsumer?.['Affiliate Code'] || '').trim();
      const settledRow = Array.isArray(paidPayments) ? paidPayments[0] : null;
      const totalChargedCents = Number(settledRow?.['Total Charged Cents'] || 0);
      depositValue = totalChargedCents > 0
        ? totalChargedCents / 100
        : Number(referral['Deposit Amount'] || 0);
    } catch {}
    // Outside the try: the verdict must be computed even if the reads above
    // threw, because 'broker' can be known from the referral alone.
    rancherNotified = paidRail === 'broker' ? brokerSheetDelivery(referral) : undefined;
    return NextResponse.json(
      {
        error: 'referral_closed',
        status: refStatus,
        // Surfaced so the success page can deep-link the share to the rancher
        // and name the ranch in its post-deposit copy.
        rancher: { slug: paidSlug, name: paidRancherName, ranchName: paidRanchName },
        // Which deposit rail this was, and (broker only) whether the ranch was
        // actually sent the order. The success page renders rail-correct next
        // steps off these two.
        rail: paidRail,
        rancherNotified,
        affiliateCode: paidAffiliateCode,
        // Buyer's share size (raw Order Type). The success page's affiliate
        // GearBlock maps this via cutForBuyer to pick cut-appropriate gear
        // (whole-cow → pins a chest freezer first). Best-effort; a blank
        // Order Type just yields universal-only gear (cut=null).
        orderType: String(referral['Order Type'] || ''),
        // Attribution (2026-07-28): the success page's GearBlock threads this
        // into /go/product?buyer= click logging. This is the AUTHED buyer
        // (ownership-checked against referral.Buyer above) — not new data
        // exposure, the session already belongs to this consumer.
        buyerId: session.consumerId,
        // Buyer-paid deposit total (dollars) — the success page fires the client
        // Purchase Pixel with this value + event_id=deposit_<refId> to dedup
        // against the server CAPI deposit Purchase.
        depositValue,
        message: refStatus === 'Closed Lost'
          ? 'This referral is closed and can\'t be reopened — contact us to re-route.'
          : 'This reservation is already paid. Check your email for the confirmation.',
      },
      { status: 409 },
    );
  }

  const rancherLinks: string[] = referral['Rancher'] || referral['Suggested Rancher'] || [];
  const rancherId = rancherLinks[0];
  if (!rancherId) return NextResponse.json({ error: 'No rancher on referral' }, { status: 409 });

  // U25: guard the rancher lookup (matches the POST handler). An unguarded
  // throw here 500'd the deposit page AND the success page's status poll on any
  // transient Airtable blip — a raw error at the money step. Return a soft
  // load_failed the client renders as a retry, and the success poll treats as
  // terminal instead of hanging on "confirming…".
  let rancher: any;
  try {
    rancher = await getRecordById(TABLES.RANCHERS, rancherId);
  } catch (e: any) {
    console.error('[checkout/deposit GET] rancher lookup failed:', e?.message);
    return NextResponse.json({ error: 'load_failed' }, { status: 503 });
  }
  if (!rancher) {
    return NextResponse.json({ error: 'load_failed' }, { status: 503 });
  }

  // RAIL GATE — mirror of the POST gate above. The deposit PAGE must never
  // render Connect pricing (deposit + fee on top) for a rancher whose rail is
  // broker or ambiguous; the POST would refuse the charge anyway, but showing
  // the wrong money first is its own lie.
  const railForRancherGet = referralRailForRancher(rancher);
  if (railForRancherGet === 'ambiguous') {
    return NextResponse.json(
      { error: 'ambiguous_rail', message: 'This ranch is misconfigured — we can\'t take a payment for it. Please contact us.' },
      { status: 409 },
    );
  }
  if (railForRancherGet === 'broker') {
    return NextResponse.json(
      {
        error: 'not_connect_rail',
        redirectUrl: `/checkout/${referralId}/broker`,
        message: 'This ranch checks out through our represented-seller flow.',
        // The success page reaches this branch in the webhook-lag window right
        // after a broker deposit is paid (the referral has not been stamped
        // Deposit Paid At yet, so the already-paid 409 above hasn't taken
        // over). Naming the rail + the ranch here means the page renders
        // broker-correct copy for those seconds instead of the Connect story.
        rail: 'broker',
        rancher: {
          name: String(rancher['Operator Name'] || rancher['Ranch Name'] || ''),
          ranchName: String(rancher['Ranch Name'] || ''),
          slug: String(rancher['Slug'] || ''),
        },
      },
      { status: 409 },
    );
  }

  const pricingModel = String(rancher['Pricing Model'] || 'legacy');

  // Per-cut money breakdown for the buyer deposit page, via resolveDepositMoney
  // (lib/depositResolve) — literally the SAME function, the SAME referral, the
  // SAME rancher, and the SAME rate the POST charge path above calls, so
  // dueNowCents is EXACTLY what the card is charged (no surprises at Stripe).
  //
  // P0 (2026-08-18) — WHY THE REFERRAL IS PASSED HERE: this used to call
  // depositDisplay(price, rancher's stored per-cut deposit, rate) and never
  // read the referral for money at all. The charge path DID honor a rancher's
  // custom quote (`Deposit Amount` + matching `Order Type` + `Deposit Requested
  // At`), so every custom ask rendered the per-cut DEFAULT and charged the
  // quote — Silverline Quarter showed $695.00 and hit the card for $795.00,
  // with five live payable referrals in that state and an hourly nudge cron
  // driving buyers at the page. The referral is money input on this surface;
  // dropping it is what made the last screen before the card lie.
  //
  // Rate resolved via depositCommissionRate exactly like POST (locked
  // Commission Rate wins, else the tier constant, else the legacy default when
  // tier is unset).
  //
  // FEE-INVISIBLE (founder directive 2026-07-01): the buyer UI renders ONLY
  // dueNowCents. depositCents/feeCents stay on the payload for API-shape
  // compat (and internal tooling) but are never displayed buyer-side.
  const tier = tierFor(rancher);
  const commissionRate = depositCommissionRate(rancher, tier);
  // The price comes from CUT_PRICE_FIELD, the same map resolveDepositMoney
  // reads — one field map, so the rendered `price` and the price the deposit
  // math is built on can never be two different numbers.
  const buildCut = (slug: DepositCut, label: string, lbsField: string) => {
    const price = Number(rancher[CUT_PRICE_FIELD[slug]]) || null;
    const lbs = String(rancher[lbsField] || '');
    const d = price === null ? null : resolveDepositMoney(referral, rancher, slug, commissionRate);
    if (price === null || price <= 0 || !d) {
      return { slug, label, price: null, lbs, depositCents: null, feeCents: null, dueNowCents: null, balanceCents: null };
    }
    return {
      slug,
      label,
      price,
      lbs,
      depositCents: d.depositCents,
      feeCents: d.feeCents,
      dueNowCents: d.dueNowCents,
      balanceCents: d.balanceCents,
    };
  };

  return NextResponse.json({
    rancher: {
      name: String(rancher['Operator Name'] || rancher['Ranch Name'] || ''),
      ranchName: String(rancher['Ranch Name'] || ''),
      slug: String(rancher['Slug'] || ''),
      state: String(rancher['State'] || ''),
    },
    pricingModel,
    tierConnected: pricingModel === 'tier_v2' && String(rancher['Stripe Connect Status'] || '') === 'active',
    legacyRedirectUrl: pricingModel === 'legacy' ? `/ranchers/${rancher['Slug'] || ''}` : null,
    cuts: [
      buildCut('quarter', 'Quarter Cow', 'Quarter lbs'),
      buildCut('half', 'Half Cow', 'Half lbs'),
      buildCut('whole', 'Whole Cow', 'Whole lbs'),
    ].filter((c) => c.price !== null && c.price > 0),
    fulfillment: {
      types: (rancher['Fulfillment Types'] || []).map((t: any) => typeof t === 'object' ? t.name : t),
      pickupCity: String(rancher['Pickup City'] || ''),
      // Pickup truth (2026-07-29): the actual address, shown pre-payment so
      // the buyer knows where they'd be driving. ADDRESS only — Pickup
      // Instructions stay on post-deposit surfaces (receipt email).
      pickupAddress: String(rancher['Pickup Address'] || ''),
      deliveryRadiusMiles: Number(rancher['Delivery Radius Miles']) || null,
      shippingLeadTimeDays: Number(rancher['Shipping Lead Time Days']) || null,
      costNotes: String(rancher['Fulfillment Cost Notes'] || ''),
      nextProcessingDate: String(rancher['Next Processing Date'] || ''),
    },
    refundPolicy: String(rancher['Refund Policy'] || ''),
  });
}
