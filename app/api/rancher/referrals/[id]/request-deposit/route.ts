// POST /api/rancher/referrals/[id]/request-deposit
//
// Rancher-initiated deposit request — the self-serve twin of the admin
// /api/admin/send-deposit-invoice flow. The rancher picks a cut + (optionally)
// a deposit amount on their own dashboard; we create a Stripe Connect direct
// charge Checkout Session on their account, email the buyer the deposit link,
// and stamp the referral so the EXISTING connect webhook
// (metadata.type='buyer_deposit') settles it on payment_intent.succeeded.
// We do NOT fork settlement.
//
// Cloned from send-final-invoice/route.ts (same auth + ownership + idempotency
// shape) but swaps the helper to createDepositCheckout. The money gates live in
// lib/depositRequest.ts (decideDepositRequest) so they are unit-tested without
// a live Airtable/Stripe.
//
// Body: { cutTier: 'Quarter'|'Half'|'Whole', depositAmount?: number }
//
// Preconditions (all enforced by decideDepositRequest):
//   • Rancher session valid (requireRancher) — rancherId comes from the
//     SESSION, never the body.
//   • Referral exists + is linked to this rancher (else 403).
//   • Rancher Pricing Model = 'tier_v2' AND Connect status = 'active' AND a
//     Connect account id is present (legacy/non-active rejected, 422).
//   • The chosen cut has a saved price (else 422 — prevents the 409 buyer
//     dead-link).
//   • Deposit ≥ $25 floor, ≤ full sale price for the cut, ≤ $25k ceiling.
//
// Idempotency:
//   • createDepositCheckout's Stripe idempotency key is cut+amount scoped, so a
//     true double-submit of the SAME cut+amount dedupes at Stripe.
//   • If a deposit checkout was already created for this referral
//     (Deposit Checkout URL present) and ?resend=true is NOT passed, we return
//     the existing URL (mirrors send-final-invoice's existingInvoiceUrl).
//
// On success:
//   • Stamps Referral: Status='Awaiting Payment', Order Type, Deposit Amount,
//     Total Sale Amount, Deposit Checkout URL, Deposit Requested At.
//   • Creates a Payments row keyed on Stripe Payment Intent Id (so the webhook's
//     markDepositSucceeded can match it — same as the admin route).
//   • Emails the buyer the deposit link (reuses sendBuyerDepositInvoice).
//   • Telegram operator ping.

import { NextResponse } from 'next/server';
import { TABLES, getRecordById, createRecord, updateRecord } from '@/lib/airtable';
import { createDepositCheckout } from '@/lib/stripeConnect';
import { requireRancher } from '@/lib/rancherAuth';
import { sendBuyerDepositInvoice } from '@/lib/emailMinimal';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { sendOperatorSignal } from '@/lib/operatorSignal';
import { tierFor, depositCommissionRate, type TierSlug } from '@/lib/tiers';
import {
  decideDepositRequest,
  isCutTier,
  depositEmailOutcome,
  type DepositEmailOutcome,
} from '@/lib/depositRequest';
import { REFERRAL_ID_TEXT_FIELD } from '@/lib/contracts/payments';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

interface RequestDepositBody {
  cutTier?: string;
  /** Rancher's chosen deposit in DOLLARS. Optional — falls back to {cut} Deposit. */
  depositAmount?: number;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: referralId } = await params;
  if (!referralId) {
    return NextResponse.json({ error: 'Referral id required' }, { status: 400 });
  }

  // Auth: rancher session required. rancherId is read from the session below —
  // NEVER from the body.
  const r = await requireRancher(req);
  if (r instanceof NextResponse) return r;
  const { session } = r;

  // Parse body
  let body: RequestDepositBody = {};
  try {
    body = (await req.json()) as RequestDepositBody;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const cut = String(body.cutTier || '').trim();
  if (!isCutTier(cut)) {
    return NextResponse.json(
      { error: 'cutTier required (Quarter | Half | Whole)' },
      { status: 400 },
    );
  }

  // Load referral + verify it exists (ownership is checked inside the decision).
  let referral: any;
  try {
    referral = await getRecordById(TABLES.REFERRALS, referralId);
  } catch {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  }
  if (!referral) {
    return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
  }

  // Load rancher (needed for the eligibility + pricing gates).
  let rancher: any;
  try {
    rancher = await getRecordById(TABLES.RANCHERS, session.rancherId);
  } catch {
    return NextResponse.json({ error: 'Rancher record load failed' }, { status: 500 });
  }
  if (!rancher) {
    return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
  }

  // THE MONEY GATE — pure, unit-tested. Ownership → eligibility → pricing →
  // amount. The route never touches Stripe unless this returns ok:true.
  const linkedRanchers: string[] = referral['Rancher'] || referral['Suggested Rancher'] || [];
  const depositAmountDollars =
    typeof body.depositAmount === 'number' ? body.depositAmount : null;
  const decision = decideDepositRequest({
    sessionRancherId: session.rancherId,
    referralLinkedRancherIds: Array.isArray(linkedRanchers) ? linkedRanchers : [],
    rancher,
    cut,
    depositAmountDollars,
  });
  if (!decision.ok) {
    return NextResponse.json({ error: decision.error }, { status: decision.status });
  }
  const { fullSaleDollars, fullSaleCents, depositDollars, depositCents } = decision.decision;

  // Idempotency: if a deposit checkout already exists + no explicit ?resend=true,
  // return the existing URL. Mirrors send-final-invoice's existingInvoiceUrl.
  const url = new URL(req.url);
  const resend = url.searchParams.get('resend') === 'true';
  const existingDepositUrl = String(referral['Deposit Checkout URL'] || '');
  // Never re-issue once the deposit has actually been paid — surface that state.
  if (referral['Deposit Paid At']) {
    return NextResponse.json(
      { ok: true, alreadyPaid: true, message: 'Deposit already paid for this referral.' },
    );
  }
  if (existingDepositUrl && !resend) {
    return NextResponse.json({
      ok: true,
      alreadySent: true,
      url: existingDepositUrl,
      message: 'Deposit request already sent. Pass ?resend=true to send a new one.',
    });
  }

  // Buyer email — required to send the link.
  const buyerEmail = String(referral['Buyer Email'] || '').trim();
  if (!buyerEmail) {
    return NextResponse.json(
      { error: 'Buyer email missing on referral. Cannot send deposit link.' },
      { status: 400 },
    );
  }
  const buyerName = String(referral['Buyer Name'] || '').trim() || buyerEmail.split('@')[0];
  const buyerLinkedIds: string[] = Array.isArray(referral['Buyer']) ? referral['Buyer'] : [];
  const buyerId = buyerLinkedIds[0] || '';

  // Tier slug for commission math (same mapping the admin route uses). Default
  // to legacy_connect if the Tier field is unset — but eligibility already
  // required tier_v2 + active Connect, so a real tier is expected.
  const tierSlug: TierSlug = tierFor(rancher) || 'legacy_connect';
  // RATE SOURCE (finding 1, 2026-07-02): locked Commission Rate wins over the
  // tier constant — the ONE rate for the Stripe application_fee AND the
  // buyer-email "Today" figure below, so quoted === charged === locked.
  const feeRate = depositCommissionRate(rancher, tierSlug);

  const connectAcct = String(rancher['Stripe Connect Account Id'] || '').trim();
  const ranchName = String(rancher['Ranch Name'] || rancher['Operator Name'] || 'the ranch').trim();
  const productLabel = `${cut} Cow — ${ranchName}`;

  // Create the Stripe Connect deposit Checkout Session (direct charge; the
  // application_fee is computed INSIDE createDepositCheckout from the tier rate
  // on the FULL sale price — commission is collected upfront on top).
  let checkoutUrl: string;
  let paymentIntentId: string;
  let sessionId: string;
  try {
    const checkout = await createDepositCheckout({
      rancherConnectAccountId: connectAcct,
      tier: tierSlug,
      commissionRate: feeRate,
      amountCents: depositCents,
      fullSaleCents,
      buyerEmail,
      referralId,
      buyerId,
      rancherId: session.rancherId,
      productLabel,
      successUrl: `${SITE_URL}/checkout/${referralId}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${SITE_URL}/checkout/${referralId}/deposit?canceled=1`,
    });
    checkoutUrl = checkout.url;
    paymentIntentId = checkout.paymentIntentId;
    sessionId = checkout.sessionId;
  } catch (e: any) {
    console.error('[request-deposit] Stripe checkout creation failed:', e?.message);
    return NextResponse.json(
      { error: `Stripe checkout failed: ${e?.message || 'unknown'}` },
      { status: 500 },
    );
  }

  // Stamp the referral. Status flips to Awaiting Payment so the dashboard +
  // capacity counts treat the slot as held. Total Sale Amount + Deposit Amount
  // are written so the downstream gates (accept, send-final-invoice) don't 409.
  const nowISO = new Date().toISOString();
  try {
    await updateRecord(TABLES.REFERRALS, referralId, {
      Status: 'Awaiting Payment',
      'Order Type': cut,
      'Deposit Amount': depositDollars,
      'Total Sale Amount': fullSaleDollars,
      'Deposit Checkout URL': checkoutUrl,
      'Deposit Requested At': nowISO,
    });
  } catch (e: any) {
    console.error('[request-deposit] Airtable referral update failed:', e?.message);
    // Non-fatal — Stripe checkout exists; webhook matches on the Payments row /
    // PI id below regardless.
  }

  // Payments row keyed on the Stripe Payment Intent Id so the connect webhook's
  // markDepositSucceeded can find it (same shape as the admin route — schema
  // field is the SPACED `Stripe Payment Intent Id`).
  try {
    await createRecord(TABLES.PAYMENTS, {
      'Buyer Email': buyerEmail,
      'Rancher': [session.rancherId],
      'Referral': [referralId],
      // Denormalized referral id (finding 3, 2026-07-01) — under Clover
      // paymentIntentId above is EMPTY at create time, so settlement finds
      // this row BY REFERRAL via {Referral Id Text} (see
      // lib/contracts/payments.findPaymentsByReferral). Without it, a
      // request-deposit row could never settle.
      [REFERRAL_ID_TEXT_FIELD]: referralId,
      'Stripe Payment Intent Id': paymentIntentId,
      'Stripe Connect Account Id': connectAcct,
      'Stripe Checkout Session Id': sessionId,
      'Amount Cents': depositCents,
      'Status': 'pending',
      'Tier': tierSlug === 'legacy_connect' ? 'Legacy Connect' : tierSlug.charAt(0).toUpperCase() + tierSlug.slice(1),
      'Type': 'buyer_deposit',
    });
  } catch (e: any) {
    console.warn('[request-deposit] Payments row create failed (non-fatal):', e?.message);
  }

  // Email the buyer the deposit link (reuses the deposit-invoice email).
  // chargedCents mirrors createDepositCheckout's totalChargedCents exactly
  // (deposit + round(fullSale × feeRate), same locked-rate-aware rate) so the
  // quoted "Today" figure is byte-identical to what Stripe charges.
  // FEE-INVISIBLE: one number, no split.
  //
  // EMAIL TRUTH (finding 3, 2026-07-02): guardedSend returns
  // { success:false, suppressed:true } WITHOUT throwing for bounced/
  // unsubscribed buyers — pre-fix the result was ignored and the route
  // answered ok:true, so the rancher believed the buyer was emailed while the
  // first downstream net (the 14-day SLA chase) pings the RANCHER. Now the
  // outcome rides the response (emailSent/emailSuppressed → the dashboard
  // modal shows "share the link directly") + a deduped operator signal fires.
  // Still non-fatal by design: the checkout link EXISTS and is returned.
  let emailOutcome: DepositEmailOutcome;
  try {
    const sendResult = await sendBuyerDepositInvoice({
      buyerEmail,
      buyerName,
      rancherName: ranchName,
      cutTier: cut,
      depositCents,
      fullSaleCents,
      chargedCents: depositCents + Math.round(fullSaleCents * feeRate),
      checkoutUrl,
    });
    emailOutcome = depositEmailOutcome(sendResult);
  } catch (e: any) {
    console.error('[request-deposit] buyer email failed:', e?.message);
    // Non-fatal — link exists, rancher can share it directly / resend.
    emailOutcome = depositEmailOutcome({
      success: false,
      reason: `send-threw: ${e?.message || 'unknown'}`,
    });
  }
  if (!emailOutcome.emailSent) {
    // Normal-urgency, deduped per referral — the rancher UI already surfaces
    // the failure; this is the operator's copy so a suppressed buyer gets a
    // human follow-up instead of 14 days of silence.
    try {
      await sendOperatorSignal({
        urgency: 'normal',
        kind: 'system-error',
        summary: 'deposit-request email to buyer did NOT send',
        detail:
          `Buyer ${buyerEmail} (${buyerName}) was NOT emailed the deposit link for referral ${referralId} — ` +
          `${emailOutcome.suppressed ? 'address is suppressed (bounced/unsubscribed)' : `send failed (${emailOutcome.reason || 'unknown'})`}. ` +
          `${ranchName} has the link on their dashboard with a "share it directly" prompt; consider reaching the buyer another way.`,
        refs: [{ type: 'referral', id: referralId }],
        dedupeKey: `deposit-email-fail:${referralId}`,
      });
    } catch (sigErr: any) {
      console.warn('[request-deposit] operator signal failed:', sigErr?.message);
    }
  }

  // Telegram operator ping.
  try {
    if (TELEGRAM_ADMIN_CHAT_ID) {
      await sendTelegramMessage(
        TELEGRAM_ADMIN_CHAT_ID,
        `💸 <b>DEPOSIT REQUESTED</b> (rancher self-serve)\n\n` +
          `<b>${ranchName}</b> → ${buyerName}\n` +
          `Cut: ${cut}\n` +
          `Deposit: $${depositDollars.toFixed(0)} · full sale $${fullSaleDollars.toFixed(0)}\n` +
          `\nReferral ${referralId}`,
      );
    }
  } catch (e: any) {
    console.warn('[request-deposit] Telegram alert failed:', e?.message);
  }

  return NextResponse.json({
    ok: true,
    url: checkoutUrl,
    paymentIntentId,
    cutTier: cut,
    depositAmount: depositDollars,
    fullSaleAmount: fullSaleDollars,
    // Email truth (finding 3): ok:true means "link created", NOT "buyer
    // emailed". The dashboard modal keys off emailSent to offer the
    // share-the-link-directly fallback.
    emailSent: emailOutcome.emailSent,
    emailSuppressed: emailOutcome.suppressed,
  });
}
