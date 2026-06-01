// POST /api/rancher/referrals/[id]/send-final-invoice
//
// Rancher-initiated final invoice for the balance owed AFTER the deposit
// landed + processing date is locked. Creates a Stripe Connect direct charge
// Checkout Session with application_fee = 0 (BHC took its full commission
// upfront at deposit time). Emails the buyer the hosted Stripe URL.
//
// Preconditions:
//   • Rancher session valid (requireRancher)
//   • Referral exists + belongs to this rancher
//   • Referral has Deposit Paid = true
//   • Rancher has Stripe Connect Account Id ('active' status)
//   • finalAmountCents > 0 and <= MAX_FINAL_INVOICE_CENTS ($25k ceiling
//     mirroring lib/stripe-commission.ts typo guard)
//   • Final invoice not already sent (idempotency — re-send needs explicit
//     `?resend=true` query param)
//
// On success:
//   • Creates Stripe Checkout Session (direct charge, app_fee=0)
//   • Updates Referral: Final Invoice URL, Final Invoice Sent At,
//     Final Invoice Amount, Total Sale Amount, Processing Date, Status='Awaiting Payment'
//   • Sends branded email to buyer w/ invoice URL
//   • Telegram alert to operator
//   • Returns { url, paymentIntentId }
//
// Webhook /api/webhooks/stripe-connect handles the payment_intent.succeeded
// event w/ metadata.kind=final-invoice → flips referral Closed Won + stamps
// Final Paid At.

import { NextResponse } from 'next/server';
import { TABLES, getRecordById, updateRecord } from '@/lib/airtable';
import { createFinalInvoiceCheckout } from '@/lib/stripeConnect';
import { requireRancher } from '@/lib/rancherAuth';
import { sendBuyerFinalInvoice } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
const MAX_FINAL_INVOICE_CENTS = 2_500_000; // $25k typo guard
const MIN_FINAL_INVOICE_CENTS = 100;       // $1 floor — Stripe requires > $0

interface SendFinalInvoiceBody {
  /**
   * The total final sale price the rancher is invoicing the buyer for the
   * remaining balance. In DOLLARS (UI sends `2000` for $2000 sale).
   * Server computes balance = totalSaleAmount - depositAmount.
   */
  totalSaleAmount?: number;
  /**
   * Processing date the buyer can expect to pick up / receive their beef.
   * ISO string preferred but server accepts loose date input.
   */
  processingDate?: string;
  /**
   * Optional message from rancher to buyer (e.g. cut sheet recap,
   * pickup logistics, contact info).
   */
  notes?: string;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: referralId } = await params;
  if (!referralId) {
    return NextResponse.json({ error: 'Referral id required' }, { status: 400 });
  }

  // Auth: rancher session required
  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  // Parse body
  let body: SendFinalInvoiceBody = {};
  try {
    body = (await req.json()) as SendFinalInvoiceBody;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (typeof body.totalSaleAmount !== 'number' || !isFinite(body.totalSaleAmount) || body.totalSaleAmount <= 0) {
    return NextResponse.json(
      { error: 'totalSaleAmount required (positive number, in dollars)' },
      { status: 400 },
    );
  }

  // Load referral + verify ownership
  let referral: any;
  try {
    referral = await getRecordById(TABLES.REFERRALS, referralId);
  } catch {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  }
  if (!referral) {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  }

  const linkedRanchers: string[] = referral['Rancher'] || referral['Suggested Rancher'] || [];
  if (!linkedRanchers.includes(session.rancherId)) {
    return NextResponse.json({ error: 'This referral does not belong to you' }, { status: 403 });
  }

  // Preconditions on referral state
  const depositPaid = !!referral['Deposit Paid'] || !!referral['Deposit Paid At'];
  if (!depositPaid) {
    return NextResponse.json(
      { error: 'Deposit must be paid before sending final invoice. Wait for buyer to complete deposit checkout.' },
      { status: 400 },
    );
  }
  const depositAmount = Number(referral['Deposit Amount'] || 0);
  if (depositAmount <= 0) {
    return NextResponse.json(
      { error: 'Referral has no recorded Deposit Amount. Cannot compute balance.' },
      { status: 400 },
    );
  }

  // Idempotency: if invoice already sent + no explicit ?resend=true, return existing
  const url = new URL(req.url);
  const resend = url.searchParams.get('resend') === 'true';
  const existingInvoiceUrl = String(referral['Final Invoice URL'] || '');
  if (existingInvoiceUrl && !resend) {
    return NextResponse.json({
      ok: true,
      alreadySent: true,
      url: existingInvoiceUrl,
      message: 'Final invoice already sent. Pass ?resend=true to send a new one.',
    });
  }

  // Compute balance
  const totalSaleAmount = body.totalSaleAmount;
  const balanceDollars = Math.round((totalSaleAmount - depositAmount) * 100) / 100;
  const balanceCents = Math.round(balanceDollars * 100);

  if (balanceCents < MIN_FINAL_INVOICE_CENTS) {
    return NextResponse.json(
      {
        error: `Final balance must be at least $${(MIN_FINAL_INVOICE_CENTS / 100).toFixed(2)}. Total sale ($${totalSaleAmount}) minus deposit ($${depositAmount}) = $${balanceDollars}.`,
      },
      { status: 400 },
    );
  }
  if (balanceCents > MAX_FINAL_INVOICE_CENTS) {
    return NextResponse.json(
      {
        error: `Final balance exceeds $${(MAX_FINAL_INVOICE_CENTS / 100).toLocaleString()} ceiling. Likely typo. If genuine, contact support.`,
      },
      { status: 400 },
    );
  }

  // Load rancher to get Stripe Connect Account Id
  let rancher: any;
  try {
    rancher = await getRecordById(TABLES.RANCHERS, session.rancherId);
  } catch {
    return NextResponse.json({ error: 'Rancher record load failed' }, { status: 500 });
  }
  if (!rancher) {
    return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
  }

  const connectAccountId = String(rancher['Stripe Connect Account Id'] || '');
  if (!connectAccountId) {
    return NextResponse.json(
      {
        error:
          'Your Stripe Connect account is not connected. Complete onboarding at /rancher/billing before sending invoices.',
      },
      { status: 400 },
    );
  }

  // Buyer email — primary source is referral, fallback to consumer record
  const buyerEmail = String(referral['Buyer Email'] || '').trim();
  if (!buyerEmail) {
    return NextResponse.json(
      { error: 'Buyer email missing on referral. Cannot send invoice.' },
      { status: 400 },
    );
  }
  const buyerName = String(referral['Buyer Name'] || '').trim() || 'Customer';
  const buyerLinkedIds: string[] = Array.isArray(referral['Buyer']) ? referral['Buyer'] : [];
  const buyerId = buyerLinkedIds[0] || '';

  // Build product label + processing date
  const orderType = String(referral['Order Type'] || 'Beef').trim();
  const ranchName = String(rancher['Ranch Name'] || rancher['Operator Name'] || 'the ranch').trim();
  const productLabel = `${orderType} Final Balance — ${ranchName}`;

  // Create Stripe Connect Checkout Session (app_fee = 0)
  let checkoutUrl: string;
  let paymentIntentId: string;
  try {
    const result = await createFinalInvoiceCheckout({
      rancherConnectAccountId: connectAccountId,
      amountCents: balanceCents,
      buyerEmail,
      referralId,
      buyerId,
      rancherId: session.rancherId,
      productLabel,
      processingDate: body.processingDate,
      notes: body.notes,
      successUrl: `${SITE_URL}/member?invoice=paid`,
      cancelUrl: `${SITE_URL}/member?invoice=canceled`,
    });
    checkoutUrl = result.url;
    paymentIntentId = result.paymentIntentId;
  } catch (e: any) {
    console.error('[final-invoice] Stripe checkout creation failed:', e?.message);
    return NextResponse.json(
      { error: `Stripe checkout failed: ${e?.message || 'unknown'}` },
      { status: 500 },
    );
  }

  // Stamp referral fields. Total Sale Amount is the rancher's authoritative
  // declaration of the full deal value — useful for downstream stats +
  // Closed Won transition when webhook fires.
  const nowISO = new Date().toISOString();
  try {
    await updateRecord(TABLES.REFERRALS, referralId, {
      'Final Invoice URL': checkoutUrl,
      'Final Invoice Sent At': nowISO,
      'Final Invoice Amount': balanceDollars,
      'Final Invoice Payment Intent ID': paymentIntentId,
      'Total Sale Amount': totalSaleAmount,
      ...(body.processingDate ? { 'Processing Date': body.processingDate } : {}),
      Status: 'Awaiting Payment',
    });
  } catch (e: any) {
    console.error('[final-invoice] Airtable update failed:', e?.message);
    // Non-fatal — Stripe checkout still exists; just no Airtable trace.
    // Webhook will pick up on payment_intent.succeeded via paymentIntentId match.
  }

  // Email the buyer
  try {
    await sendBuyerFinalInvoice({
      buyerEmail,
      buyerName,
      ranchName,
      orderType,
      balanceAmount: balanceDollars,
      totalSaleAmount,
      depositAmount,
      processingDate: body.processingDate,
      notes: body.notes,
      checkoutUrl,
    });
  } catch (e: any) {
    console.error('[final-invoice] buyer email failed:', e?.message);
    // Non-fatal — invoice exists, rancher can resend manually
  }

  // Telegram alert
  try {
    if (TELEGRAM_ADMIN_CHAT_ID) {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `📑 <b>FINAL INVOICE SENT</b>\n\n` +
          `<b>${ranchName}</b> → ${buyerName}\n` +
          `Total sale: $${totalSaleAmount.toFixed(2)}\n` +
          `Deposit paid: $${depositAmount.toFixed(2)}\n` +
          `Balance owed: $${balanceDollars.toFixed(2)} (100% to rancher, BHC fee $0)\n` +
          (body.processingDate ? `Processing: ${body.processingDate}\n` : '') +
          `\nReferral ${referralId}`,
      );
    }
  } catch (e: any) {
    console.warn('[final-invoice] Telegram alert failed:', e?.message);
  }

  return NextResponse.json({
    ok: true,
    url: checkoutUrl,
    paymentIntentId,
    balanceAmount: balanceDollars,
    totalSaleAmount,
    depositAmount,
  });
}
