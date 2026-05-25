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
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { getRecordById, TABLES } from '@/lib/airtable';
import { createDepositCheckout } from '@/lib/stripeConnect';
import { recordDeposit } from '@/lib/contracts/payments';
import { tierFor, TIERS } from '@/lib/tiers';
import { JWT_SECRET } from '@/lib/secrets';

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

  const cookieStore = await cookies();
  const memberCookie = cookieStore.get('bhc-member-auth');
  if (!memberCookie?.value) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  let decoded: any;
  try { decoded = jwt.verify(memberCookie.value, JWT_SECRET); }
  catch { return NextResponse.json({ error: 'Session expired' }, { status: 401 }); }
  if (decoded.type !== 'member-session') {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }

  let body: any = {};
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

  const referralId = String(body.referralId || '').trim();
  const cutSize = String(body.cutSize || '').toLowerCase();
  if (!referralId) return NextResponse.json({ error: 'referralId required' }, { status: 400 });
  if (!CUT_LABELS[cutSize]) return NextResponse.json({ error: 'cutSize must be quarter|half|whole' }, { status: 400 });

  // Look up referral + verify buyer ownership
  let referral: any;
  try {
    referral = await getRecordById(TABLES.REFERRALS, referralId);
  } catch {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  }
  if (!referral) return NextResponse.json({ error: 'Referral not found' }, { status: 404 });

  const buyerLinks: string[] = referral['Buyer'] || [];
  if (!buyerLinks.includes(decoded.consumerId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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

  // Compute per-cut price (Airtable fields hold dollars)
  const priceFieldMap: Record<string, string> = {
    quarter: 'Quarter Price',
    half: 'Half Price',
    whole: 'Whole Price',
  };
  const dollars = Number(rancher[priceFieldMap[cutSize]]);
  if (!Number.isFinite(dollars) || dollars <= 0) {
    return NextResponse.json(
      { error: `Rancher hasn't set a ${CUT_LABELS[cutSize]} price yet — contact rancher` },
      { status: 409 },
    );
  }
  const amountCents = Math.round(dollars * 100);

  const buyerEmail = String(referral['Buyer Email'] || '').trim();
  if (!buyerEmail) return NextResponse.json({ error: 'Buyer email missing on referral' }, { status: 409 });

  const productLabel = `${CUT_LABELS[cutSize]} — ${rancher['Ranch Name'] || rancher['Operator Name']}`;

  // Tier capitalization for Payments table
  const tierCapitalized = (tier.charAt(0).toUpperCase() + tier.slice(1)) as 'Pasture' | 'Ranch' | 'Operator';

  // Compute platform fee (mirrors lib/stripeConnect.createDepositCheckout)
  const platformFeeCents = Math.round(amountCents * TIERS[tier].commissionRate);

  // Create Stripe Checkout Session
  let result: { url: string; paymentIntentId: string };
  try {
    result = await createDepositCheckout({
      rancherConnectAccountId: connectAccountId,
      tier,
      amountCents,
      buyerEmail,
      referralId,
      buyerId: decoded.consumerId,
      rancherId,
      productLabel,
      successUrl: `${SITE_URL}/checkout/${referralId}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${SITE_URL}/checkout/${referralId}/deposit?canceled=1`,
    });
  } catch (e: any) {
    console.error('[checkout/deposit] Stripe Checkout create failed:', e?.message);
    return NextResponse.json({ error: `Checkout failed: ${e?.message || 'unknown'}` }, { status: 500 });
  }

  // Record pending payment. If this fails the buyer must NOT be sent to Stripe —
  // a paid PaymentIntent with no Payments row is invisible to the webhook
  // (markDepositSucceeded looks up by Stripe Payment Intent Id) and produces
  // an orphan deposit. Fail the request and let the buyer retry; the Stripe
  // session will expire harmlessly.
  try {
    await recordDeposit({
      referralId,
      buyerId: decoded.consumerId,
      rancherId,
      tier: tierCapitalized,
      amountCents,
      platformFeeCents,
      stripePaymentIntentId: result.paymentIntentId,
    });
  } catch (e: any) {
    console.error('[checkout/deposit] recordDeposit failed — aborting redirect to prevent orphan payment:', e);
    return NextResponse.json({ error: 'Could not record deposit. Please try again.' }, { status: 500 });
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

  const cookieStore = await cookies();
  const memberCookie = cookieStore.get('bhc-member-auth');
  if (!memberCookie?.value) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  let decoded: any;
  try { decoded = jwt.verify(memberCookie.value, JWT_SECRET); }
  catch { return NextResponse.json({ error: 'Session expired' }, { status: 401 }); }
  if (decoded.type !== 'member-session') {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }

  let referral: any;
  try { referral = await getRecordById(TABLES.REFERRALS, referralId); }
  catch { return NextResponse.json({ error: 'Referral not found' }, { status: 404 }); }
  if (!referral) return NextResponse.json({ error: 'Referral not found' }, { status: 404 });

  const buyerLinks: string[] = referral['Buyer'] || [];
  if (!buyerLinks.includes(decoded.consumerId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const rancherLinks: string[] = referral['Rancher'] || referral['Suggested Rancher'] || [];
  const rancherId = rancherLinks[0];
  if (!rancherId) return NextResponse.json({ error: 'No rancher on referral' }, { status: 409 });

  const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);

  const pricingModel = String(rancher['Pricing Model'] || 'legacy');

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
      { slug: 'quarter', label: 'Quarter Cow', price: Number(rancher['Quarter Price']) || null, lbs: String(rancher['Quarter lbs'] || '') },
      { slug: 'half', label: 'Half Cow', price: Number(rancher['Half Price']) || null, lbs: String(rancher['Half lbs'] || '') },
      { slug: 'whole', label: 'Whole Cow', price: Number(rancher['Whole Price']) || null, lbs: String(rancher['Whole lbs'] || '') },
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
