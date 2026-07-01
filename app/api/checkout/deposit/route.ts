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
import { recordDeposit } from '@/lib/contracts/payments';
import { MIN_TIER_PRICE, deriveDeposit } from '@/lib/pricing';
import { tierFor, TIERS, commissionRateForTier } from '@/lib/tiers';
import { resolveDepositAuth } from '@/lib/buyerAuth';
import { checkOriginGuard } from '@/lib/csrfGuard';
import { fireCapi, buildUserData, getMetaCookiesFromRequest } from '@/lib/metaCapi';
import { metaEventId } from '@/lib/analytics';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

const CUT_LABELS: Record<string, string> = {
  quarter: 'Quarter Cow',
  half: 'Half Cow',
  whole: 'Whole Cow',
};

// ---------------------------------------------------------------------------
// POST — create Stripe Checkout Session
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
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
  if (!referralId) return NextResponse.json({ error: 'referralId required' }, { status: 400 });
  if (!CUT_LABELS[cutSize]) return NextResponse.json({ error: 'cutSize must be quarter|half|whole' }, { status: 400 });

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
  // Re-pay guard. A settled deposit stamps `Deposit Paid At` and flips Status to
  // `Awaiting Payment` (NOT Closed Won). Without keying on those, a buyer who
  // returns to the deposit page (back button, re-clicked magic link, reorder,
  // funnel CTA) passes this gate and is charged a SECOND deposit — a fresh
  // PaymentIntent is not deduped by the pi.id idempotency anchors. `Deposit Paid
  // At` is the reliable signal (a date field, immune to select-option stripping).
  const depositAlreadyPaid =
    !!referral['Deposit Paid At'] || refStatus === 'Awaiting Payment' || refStatus === 'Slot Locked';
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

  // Live Connect status re-check. The cached `Stripe Connect Status` field
  // above can go stale when Stripe flips a rancher active→restricted and the
  // Connect webhook misses it (CONNECT_WEBHOOK_SECRET is often unset in prod).
  // A stale 'active' would route buyers here and then blow up inside
  // createDepositCheckout at Stripe (a 500) instead of a clean rejection.
  // Read live, self-heal Airtable so routing recovers, and reject with the
  // SAME 409 as the cached gate. Transient read failures fall back to the
  // cached value already validated above — never block a deposit on a flaky
  // Stripe read.
  try {
    const live = await getConnectAccountStatus(connectAccountId);
    if (live.status !== 'active') {
      try {
        await updateRecord(TABLES.RANCHERS, rancherId, { 'Stripe Connect Status': live.status });
      } catch (persistErr: any) {
        console.error('[checkout/deposit] failed to persist corrected Connect status:', persistErr?.message);
      }
      return NextResponse.json({ error: 'Rancher bank not connected — cannot accept deposits yet' }, { status: 409 });
    }
  } catch (statusErr: any) {
    console.error('[checkout/deposit] live Connect status read failed — falling back to cached field:', statusErr?.message);
  }

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
  const priceFieldMap: Record<string, string> = {
    quarter: 'Quarter Price',
    half: 'Half Price',
    whole: 'Whole Price',
  };
  const depositFieldMap: Record<string, string> = {
    quarter: 'Quarter Deposit',
    half: 'Half Deposit',
    whole: 'Whole Deposit',
  };
  const fullSaleDollars = Number(rancher[priceFieldMap[cutSize]]);
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
  // Deposit: use the rancher's set per-cut deposit when valid (0 < dep ≤ price);
  // otherwise DERIVE the standard reserve (25% of price, lib/pricing) rather than
  // charging the full price upfront. This keeps the charge consistent with what
  // the deposit page DISPLAYS (the GET handler shows deriveDeposit when the field
  // is empty) and means an un-backfilled rancher charges a true partial reserve,
  // never 100%. deriveDeposit is always < price for any price ≥ MIN_TIER_PRICE
  // (gated above), so the buyer always pays a partial and the balance is real.
  const depositDollarsRaw = Number(rancher[depositFieldMap[cutSize]]);
  const depositDollars =
    Number.isFinite(depositDollarsRaw) && depositDollarsRaw > 0 && depositDollarsRaw <= fullSaleDollars
      ? depositDollarsRaw
      : deriveDeposit(fullSaleDollars);

  const fullSaleCents = Math.round(fullSaleDollars * 100);
  const amountCents = Math.round(depositDollars * 100);

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

  // BHC service fee is computed against the FULL sale price — not the
  // deposit. Rancher collects the fulfillment balance directly outside BHC,
  // so commission is paid in full at deposit time. ADDED ON TOP of the
  // rancher's deposit (rancher receives full deposit, buyer pays
  // deposit + platform fee).
  const platformFeeCents = Math.round(fullSaleCents * TIERS[tier].commissionRate);
  const totalChargedCents = amountCents + platformFeeCents;

  // Create Stripe Checkout Session
  let result: { url: string; paymentIntentId: string; sessionId: string; connectAccountId: string };
  try {
    result = await createDepositCheckout({
      rancherConnectAccountId: connectAccountId,
      tier,
      amountCents,
      fullSaleCents,
      buyerEmail,
      referralId,
      buyerId: session.consumerId,
      rancherId,
      productLabel,
      successUrl: `${SITE_URL}/checkout/${referralId}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${SITE_URL}/checkout/${referralId}/deposit?canceled=1`,
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

  // ── Meta Conversions API: server-side `InitiateCheckout` event ──────
  // Buyer landed on the deposit page and clicked through to Stripe Checkout.
  // Client Pixel loses 30-50% to iOS 14.5+ ATT + adblockers. Deduped with
  // client Pixel via event_id=<referralId>. Fire-and-forget. We look up
  // the buyer's Consumer row best-effort for richer user_data (state,
  // first name) — failure logs but never blocks the Stripe redirect.
  try {
    let buyer: any = null;
    try {
      buyer = await getRecordById(TABLES.CONSUMERS, session.consumerId);
    } catch {}
    const buyerFullName = String(buyer?.['Full Name'] || '').trim();
    const buyerFirstName = buyerFullName.split(/\s+/)[0] || undefined;
    const buyerState = String(buyer?.['State'] || '') || undefined;
    const buyerPhone = String(buyer?.['Phone'] || '') || undefined;
    const capiIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const capiUserAgent = req.headers.get('user-agent') || undefined;
    const { fbp: capiFbp, fbc: capiFbc } = getMetaCookiesFromRequest(req);

    fireCapi([{
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
    }]).catch((e) => console.error('[meta-capi] deposit InitiateCheckout fire failed:', e));
  } catch (e) {
    console.error('[meta-capi] deposit InitiateCheckout setup failed:', e);
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

  // Terminal-status gate. A closed referral must not be re-paid — without
  // this, a buyer who hits the deposit page after closure can pay a second
  // PaymentIntent, create a duplicate Payments row, re-fire recordClose,
  // and trigger a second Telegram celebration. Block both POST + GET so
  // the deposit page surfaces "already paid" state via the 409.
  const refStatus = String(referral['Status'] || '');
  // Re-pay guard. A settled deposit stamps `Deposit Paid At` and flips Status to
  // `Awaiting Payment` (NOT Closed Won). Without keying on those, a buyer who
  // returns to the deposit page (back button, re-clicked magic link, reorder,
  // funnel CTA) passes this gate and is charged a SECOND deposit — a fresh
  // PaymentIntent is not deduped by the pi.id idempotency anchors. `Deposit Paid
  // At` is the reliable signal (a date field, immune to select-option stripping).
  const depositAlreadyPaid =
    !!referral['Deposit Paid At'] || refStatus === 'Awaiting Payment' || refStatus === 'Slot Locked';
  if (refStatus === 'Closed Won' || refStatus === 'Closed Lost' || depositAlreadyPaid) {
    // Resolve the linked rancher's slug even on the already-paid branch. The
    // success page renders AFTER payment (Status flips to Awaiting Payment),
    // so EVERY success-page GET hits this 409 — without surfacing the slug,
    // the refer-a-friend share link could never build a real /ranchers/<slug>
    // deep-link and always fell back to /access. Best-effort: a lookup failure
    // just omits the slug (link degrades to the /access fallback, never dead).
    let paidSlug = '';
    try {
      const paidRancherId = (referral['Rancher'] || referral['Suggested Rancher'] || [])[0];
      if (paidRancherId) {
        const paidRancher: any = await getRecordById(TABLES.RANCHERS, paidRancherId);
        paidSlug = String(paidRancher?.['Slug'] || '');
      }
    } catch {}
    return NextResponse.json(
      {
        error: 'referral_closed',
        status: refStatus,
        // Surfaced so the success page can deep-link the share to the rancher.
        rancher: { slug: paidSlug },
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

  const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);

  const pricingModel = String(rancher['Pricing Model'] || 'legacy');

  // Per-cut money breakdown for the buyer deposit page. Mirrors the POST
  // handler so the page shows the EXACT charge (no surprises at Stripe):
  //   • fee   = round(fullPrice × commissionRate)  — ADDED ON TOP of deposit
  //             (POST route.ts:230, stripeConnect.ts:232). Rate resolved via
  //             tierFor(rancher) exactly like POST route.ts:120; falls back to
  //             the legacy default (commissionRateForTier) when tier is unset
  //             so an un-tiered rancher still itemizes instead of NaN.
  //   • deposit = stored `{Cut} Deposit` if a valid 0<dep≤price, ELSE
  //             deriveDeposit(price) (a sane ~25% partial). This is the SAME
  //             resolution POST uses (route.ts ~202), so the page shows exactly
  //             what the card is charged — no full-price-upfront surprise for an
  //             un-backfilled rancher.
  //   • dueNow  = deposit + fee   (what the card is actually charged)
  //   • balance = fullPrice − deposit (paid rancher-direct at pickup)
  const tier = tierFor(rancher);
  const commissionRate = tier ? TIERS[tier].commissionRate : commissionRateForTier(null);
  const depositFieldByCut: Record<string, string> = {
    quarter: 'Quarter Deposit',
    half: 'Half Deposit',
    whole: 'Whole Deposit',
  };
  const buildCut = (slug: 'quarter' | 'half' | 'whole', label: string, priceField: string, lbsField: string) => {
    const price = Number(rancher[priceField]) || null;
    if (price === null || price <= 0) {
      return { slug, label, price: null, lbs: String(rancher[lbsField] || ''), depositCents: null, feeCents: null, dueNowCents: null, balanceCents: null };
    }
    const fullCents = Math.round(price * 100);
    const storedDeposit = Number(rancher[depositFieldByCut[slug]]);
    const depositDollars =
      Number.isFinite(storedDeposit) && storedDeposit > 0 && storedDeposit <= price
        ? storedDeposit
        : deriveDeposit(price);
    const depositCents = Math.round(depositDollars * 100);
    const feeCents = Math.round(price * 100 * commissionRate);
    return {
      slug,
      label,
      price,
      lbs: String(rancher[lbsField] || ''),
      depositCents,
      feeCents,
      dueNowCents: depositCents + feeCents,
      balanceCents: fullCents - depositCents,
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
      buildCut('quarter', 'Quarter Cow', 'Quarter Price', 'Quarter lbs'),
      buildCut('half', 'Half Cow', 'Half Price', 'Half lbs'),
      buildCut('whole', 'Whole Cow', 'Whole Price', 'Whole lbs'),
    ].filter((c) => c.price !== null && c.price > 0),
    fulfillment: {
      types: (rancher['Fulfillment Types'] || []).map((t: any) => typeof t === 'object' ? t.name : t),
      pickupCity: String(rancher['Pickup City'] || ''),
      deliveryRadiusMiles: Number(rancher['Delivery Radius Miles']) || null,
      shippingLeadTimeDays: Number(rancher['Shipping Lead Time Days']) || null,
      costNotes: String(rancher['Fulfillment Cost Notes'] || ''),
      nextProcessingDate: String(rancher['Next Processing Date'] || ''),
    },
    refundPolicy: String(rancher['Refund Policy'] || ''),
  });
}
