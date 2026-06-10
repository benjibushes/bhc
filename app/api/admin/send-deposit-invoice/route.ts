// app/api/admin/send-deposit-invoice/route.ts
//
// Sales-floor closed-loop v3: Ben clicks "Send Deposit Invoice" on a
// closed sales call → server creates a Stripe direct-charge Checkout
// session on the rancher's Connect acct + emails buyer the deposit
// link. Buyer pays → webhook flips Referral to Awaiting Payment → rancher
// hits Accept Slot on dashboard. Closed loop.
//
// Body: { buyerEmail, rancherId, cutTier ('Quarter'|'Half'|'Whole') }
// Server pulls buyer's Consumer row + rancher's pricing + creates checkout
// + persists Referral if missing + fires email.

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, createRecord, updateRecord, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';
import { createDepositCheckout } from '@/lib/stripeConnect';
import { sendBuyerDepositInvoice } from '@/lib/emailMinimal';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { fireCapi, buildUserData, getMetaCookiesFromRequest } from '@/lib/metaCapi';
import type { TierSlug } from '@/lib/tiers';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

export async function POST(req: Request) {
  const a = await requireAdmin(req);
  if (a) return a;

  let body: any = {};
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }); }

  const buyerEmail = String(body.buyerEmail || '').trim().toLowerCase();
  const rancherId = String(body.rancherId || '').trim();
  const cutTier = String(body.cutTier || '').trim();

  if (!buyerEmail || !rancherId || !['Quarter', 'Half', 'Whole'].includes(cutTier)) {
    return NextResponse.json(
      { error: 'buyerEmail, rancherId, and cutTier (Quarter|Half|Whole) required' },
      { status: 400 },
    );
  }

  // Look up buyer Consumer row + rancher row.
  const safeEmail = escapeAirtableValue(buyerEmail);
  const consumers = await getAllRecords(TABLES.CONSUMERS, `LOWER({Email})="${safeEmail}"`);
  const buyer = consumers[0] as any;
  if (!buyer) return NextResponse.json({ error: 'buyer not found' }, { status: 404 });

  const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
  if (!rancher) return NextResponse.json({ error: 'rancher not found' }, { status: 404 });

  // Validate rancher is tier_v2 + Connect active. Refuse for legacy ranchers
  // — Ben should not send deposit invoice for those; they handle off-platform.
  const pricingModel = String(rancher['Pricing Model'] || '').toLowerCase();
  const connectStatus = String(rancher['Stripe Connect Status'] || '').toLowerCase();
  const connectAcct = String(rancher['Stripe Connect Account Id'] || '').trim();
  if (pricingModel !== 'tier_v2' || !connectAcct) {
    return NextResponse.json(
      { error: 'rancher is not tier_v2 or has no Stripe Connect account' },
      { status: 422 },
    );
  }
  if (connectStatus !== 'active' && connectStatus !== 'onboarding') {
    return NextResponse.json(
      { error: `rancher Stripe Connect status is "${connectStatus}" — cannot send deposit` },
      { status: 422 },
    );
  }

  // Compute deposit + full sale amounts from rancher's tier-specific fields.
  const priceField =
    cutTier === 'Quarter' ? 'Quarter Price'
    : cutTier === 'Half' ? 'Half Price'
    : 'Whole Price';
  const depositField =
    cutTier === 'Quarter' ? 'Quarter Deposit'
    : cutTier === 'Half' ? 'Half Deposit'
    : 'Whole Deposit';

  const fullSaleDollars = Number(rancher[priceField] || 0);
  const depositDollars = Number(rancher[depositField] || 0) || fullSaleDollars;
  if (fullSaleDollars <= 0 || depositDollars <= 0) {
    return NextResponse.json(
      { error: `rancher missing ${priceField} or ${depositField}` },
      { status: 422 },
    );
  }
  const fullSaleCents = Math.round(fullSaleDollars * 100);
  const depositCents = Math.round(depositDollars * 100);

  // Find or create Referral row tied to buyer+rancher.
  const existingReferrals = await getAllRecords(
    TABLES.REFERRALS,
    `AND(LOWER({Buyer Email})="${safeEmail}",FIND("${rancherId}",ARRAYJOIN({Rancher},","))>0)`,
  );
  let referralId = '';
  if (existingReferrals.length > 0) {
    referralId = existingReferrals[0].id;
    // Refresh referral to Awaiting Payment in case it was an earlier intro.
    try {
      await updateRecord(TABLES.REFERRALS, referralId, {
        'Status': 'Awaiting Payment',
        'Order Type': cutTier,
      });
    } catch (e: any) {
      console.warn('[send-deposit-invoice] referral update failed:', e?.message);
    }
  } else {
    const created = await createRecord(TABLES.REFERRALS, {
      'Buyer': [buyer.id],
      'Rancher': [rancherId],
      'Buyer Email': buyerEmail,
      'Buyer State': buyer['State'] || '',
      'Status': 'Awaiting Payment',
      'Order Type': cutTier,
      'Approval Status': 'admin-approved',
      'Match Type': 'Local',
    });
    referralId = (created as any).id;
  }

  // Determine the tier slug for commission math. Rancher's Tier field is
  // user-facing ('Pasture'/'Ranch'/'Operator'/'Legacy Connect'); map it
  // to the slug TIERS map expects.
  const tierName = String(rancher['Tier'] || '').toLowerCase();
  const tierSlug: TierSlug =
    tierName === 'pasture' ? 'pasture'
    : tierName === 'ranch' ? 'ranch'
    : tierName === 'operator' ? 'operator'
    : 'legacy_connect';

  const productLabel = `${cutTier} Cow — ${String(rancher['Ranch Name'] || rancher['Operator Name'] || 'Ranch')}`;

  // Create Stripe direct-charge Checkout. application_fee_amount is computed
  // inside createDepositCheckout from the rancher's tier commission rate.
  const session = await createDepositCheckout({
    rancherConnectAccountId: connectAcct,
    tier: tierSlug,
    amountCents: depositCents,
    fullSaleCents,
    buyerEmail,
    referralId,
    buyerId: buyer.id,
    rancherId,
    productLabel,
    successUrl: `${SITE_URL}/checkout/${referralId}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${SITE_URL}/checkout/${referralId}/deposit?canceled=1`,
  });

  // Persist Payments row tracking the PI for webhook close-loop.
  try {
    await createRecord(TABLES.PAYMENTS, {
      'Buyer Email': buyerEmail,
      'Rancher': [rancherId],
      'Referral': [referralId],
      'Stripe PaymentIntent Id': session.paymentIntentId,
      'Stripe Connect Account Id': session.connectAccountId,
      'Stripe Checkout Session Id': session.sessionId,
      'Amount Cents': depositCents,
      'Status': 'pending',
      'Tier': tierSlug === 'legacy_connect' ? 'Legacy Connect' : tierSlug.charAt(0).toUpperCase() + tierSlug.slice(1),
      'Type': 'buyer_deposit',
    });
  } catch (e: any) {
    console.warn('[send-deposit-invoice] payments row create failed (non-fatal):', e?.message);
  }

  // Fire deposit-invoice email to the buyer w/ the checkout URL.
  const buyerName = String(buyer['Full Name'] || buyerEmail.split('@')[0]).trim();
  try {
    await sendBuyerDepositInvoice({
      buyerEmail,
      buyerName,
      rancherName: String(rancher['Ranch Name'] || rancher['Operator Name'] || 'Your rancher'),
      cutTier,
      depositCents,
      fullSaleCents,
      checkoutUrl: session.url,
    });
  } catch (e: any) {
    console.error('[send-deposit-invoice] email send failed:', e?.message);
  }

  try {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `💸 Deposit invoice sent — ${buyerEmail} | ${cutTier} | $${(depositCents / 100).toFixed(0)} | ${String(rancher['Ranch Name'] || rancher['Operator Name'])}`,
    );
  } catch { /* best-effort */ }

  // F2 — fire Meta CAPI InitiateCheckout. Server-side only since this is
  // admin-initiated (no client pixel context). Helps Meta attribute the
  // ad → eventual Purchase when buyer pays the deposit link.
  try {
    const cookies = getMetaCookiesFromRequest(req);
    const userData = buildUserData({
      email: buyerEmail,
      phone: String(buyer['Phone'] || ''),
      state: String(buyer['State'] || ''),
      firstName: buyerName.split(' ')[0],
      lastName: buyerName.split(' ').slice(1).join(' '),
      fbp: cookies.fbp,
      fbc: cookies.fbc,
    });
    fireCapi([{
      event_name: 'InitiateCheckout',
      event_id: `deposit-invoice-${referralId}`,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'system_generated',
      event_source_url: SITE_URL,
      user_data: userData,
      custom_data: {
        currency: 'USD',
        value: depositCents / 100,
        content_name: productLabel,
        content_type: cutTier,
      },
    }]);
  } catch (e: any) {
    console.warn('[send-deposit-invoice] CAPI fire failed:', e?.message);
  }

  // F9 — SMS event (gated by ENABLE_SMS feature flag, default OFF)
  try {
    const { fireSMSEvent } = await import('@/lib/smsEvents');
    await fireSMSEvent({
      type: 'deposit_invoice',
      consumer: buyer,
      vars: {
        firstName: buyerName.split(' ')[0],
        ranchName: productLabel.split(' from ').pop() || 'your ranch',
      },
    });
  } catch (e: any) {
    console.warn('[send-deposit-invoice] SMS fire failed:', e?.message);
  }

  return NextResponse.json({
    ok: true,
    referralId,
    checkoutUrl: session.url,
    depositCents,
    fullSaleCents,
  });
}
