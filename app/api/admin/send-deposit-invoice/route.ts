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
import { getAllRecords, getRecordById, createReferral, updateRecord, TABLES, escapeAirtableValue } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';
import { mintDepositGrantToken } from '@/lib/campaignReserve';
import { sendBuyerDepositInvoice } from '@/lib/emailMinimal';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { fireCapi, buildUserData, getMetaCookiesFromRequest } from '@/lib/metaCapi';
import { depositCommissionRate, type TierSlug } from '@/lib/tiers';

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
  // Gate audit 2026-07-07: 'onboarding' was tolerated here — the ONLY deposit
  // gate that did (every other path requires 'active'). An onboarding account
  // can't reliably take a direct charge; the invoice link would dead-end the
  // buyer Ben just closed on the phone. Active only, like everywhere else.
  if (connectStatus !== 'active') {
    return NextResponse.json(
      { error: `rancher Stripe Connect status is "${connectStatus}" — must be active before sending a deposit invoice` },
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
  // S2 (2026-06-10): write Deposit Amount + Total Sale Amount on the
  // Referral when we know them. Without these, downstream gates
  // (rancher accept, send-final-invoice) silently 409.
  const fullSaleAmount = fullSaleDollars;
  // 'Deposit Requested At' is LOAD-BEARING (2026-07-14): the deposit page's
  // re-pay guard (lib/depositPaidState) reads {Status:'Awaiting Payment' +
  // request stamp + no Deposit Paid At} as PAYABLE. Without the stamp, an
  // admin-invoiced buyer reads as already-paid and the durable link 409s.
  // It also lets confirmPaymentGuard block a manual "confirm payment" while
  // this invoice is outstanding — same semantics as the rancher flow.
  const requestedAtISO = new Date().toISOString();
  let referralId = '';
  if (existingReferrals.length > 0) {
    referralId = existingReferrals[0].id;
    // Refresh referral to Awaiting Payment in case it was an earlier intro.
    try {
      await updateRecord(TABLES.REFERRALS, referralId, {
        'Status': 'Awaiting Payment',
        'Order Type': cutTier,
        'Deposit Amount': depositDollars,
        'Total Sale Amount': fullSaleAmount > 0 ? fullSaleAmount : depositDollars,
        'Deposit Requested At': requestedAtISO,
      });
    } catch (e: any) {
      console.warn('[send-deposit-invoice] referral update failed:', e?.message);
    }
  } else {
    const created = await createReferral({
      'Buyer': [buyer.id],
      'Rancher': [rancherId],
      'Buyer Email': buyerEmail,
      'Buyer State': buyer['State'] || '',
      'Status': 'Awaiting Payment',
      'Order Type': cutTier,
      'Approval Status': 'admin-approved',
      'Match Type': 'Local',
      'Deposit Amount': depositDollars,
      'Total Sale Amount': fullSaleAmount > 0 ? fullSaleAmount : depositDollars,
      'Deposit Requested At': requestedAtISO,
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

  // RATE SOURCE (finding 1, 2026-07-02): locked Commission Rate wins over the
  // tier constant — one rate for the Stripe application_fee AND the buyer
  // email's "Today" figure, so quoted === charged === locked.
  const feeRate = depositCommissionRate(rancher, tierSlug);

  // DURABLE LINK (2026-07-14 — replaces the request-time Stripe session).
  // The old raw Stripe-hosted Checkout URL expired after ~24h, dead-ending any
  // buyer who opened the email later. Now: a signed ~30d pay link
  // (/r/p/<grant>) lands the buyer on the on-domain deposit page with a
  // referral-scoped grant cookie; the page mints a FRESH Stripe session (and
  // the Payments row, via recordDeposit) at pay-click with identical
  // locked-rate commission math. No expiring artifact, no orphan pending rows.
  let checkoutUrl: string;
  try {
    checkoutUrl = `${SITE_URL}/r/p/${mintDepositGrantToken(
      { consumerId: buyer.id, referralId },
      { expiresIn: '30d' },
    )}`;
  } catch (e: any) {
    console.error('[send-deposit-invoice] pay-link mint failed:', e?.message);
    return NextResponse.json({ error: 'Could not create the payment link' }, { status: 500 });
  }

  // Fire deposit-invoice email to the buyer w/ the checkout URL.
  const buyerName = String(buyer['Full Name'] || buyerEmail.split('@')[0]).trim();
  let inviteEmailSent = false;
  try {
    // chargedCents mirrors createDepositCheckout's totalChargedCents exactly
    // (deposit + round(fullSale × tier rate)) so the quoted "Today" figure is
    // byte-identical to what Stripe charges. FEE-INVISIBLE: one number, no split.
    await sendBuyerDepositInvoice({
      buyerEmail,
      buyerName,
      rancherName: String(rancher['Ranch Name'] || rancher['Operator Name'] || 'Your rancher'),
      cutTier,
      depositCents,
      fullSaleCents,
      chargedCents: depositCents + Math.round(fullSaleCents * feeRate),
      checkoutUrl,
    });
    inviteEmailSent = true;
  } catch (e: any) {
    console.error('[send-deposit-invoice] email send failed:', e?.message);
  }

  // PERSIST THE INVITE OUTCOME (money-truth 1b, 2026-07-21). This rail flips
  // Status → Awaiting Payment (both the update and create paths above) but
  // never stamped 'Deposit Invite Sent At' — so every admin-invoiced deal
  // looked to the deposit watchdog like a buyer who was never told, and the
  // watchdog would cry wolf forever. Success-only, mirroring the
  // request-deposit rail (PR #410): a failed send leaves the stamp blank,
  // which is exactly the half-state the watchdog exists to catch.
  if (inviteEmailSent) {
    try {
      await updateRecord(TABLES.REFERRALS, referralId, {
        'Deposit Invite Sent At': new Date().toISOString(),
      });
    } catch (e: any) {
      console.warn('[send-deposit-invoice] invite-sent stamp failed:', e?.message);
    }
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
    checkoutUrl,
    depositCents,
    fullSaleCents,
  });
}
