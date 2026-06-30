// lib/emailMinimal.ts
//
// Sales-floor pivot 2026-06-09: BHC's entire buyer-facing email pipeline.
// 6 transactional templates. No drip. No nurture. Cal handles re-engagement.
//
//   1. sendBuyerSignupConfirmation     — /access signup → take the quiz
//   2. sendQuizCompleteCalInvite       — quiz done → book Ben's Cal
//   3. sendBuyerDepositInvoice         — Ben closed on call → deposit link
//   4. sendSlotLockedConfirmation      — rancher accepted → confirmation
//   5. sendBuyerFinalInvoice           — (lives in lib/email.ts — reused)
//   6. Stripe Connect Active alert     — (lives in webhook — reused)
//
// All four NEW templates route through guardedSend via lib/email.ts:sendEmail
// so suppression list + frequency cap + Email Sends audit log all fire.

import { sendEmail } from './email';
import { getOperatorBookingUrl } from './calBooking';
import { BEN_SALES_CAL_URL } from './salesContact';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';
// Operator booking link is resolved at send time via getOperatorBookingUrl()
// (lib/calBooking.ts) — single source of truth that fetches the operator's
// LIVE Cal event via CAL_API_KEY and falls back to /contact if none exists.
// The old hardcoded /sales slug 404'd after the Cal events were deleted
// (incident 2026-06-14).

// 1. /access signup confirmation — replaces sendConsumerConfirmation as the
//    one-shot welcome. Drops them right into the quiz.
export async function sendBuyerSignupConfirmation(opts: {
  to: string;
  firstName: string;
  quizUrl: string;
}) {
  return sendEmail({
    to: opts.to,
    subject: `Got your application — take the 90-second quiz to get matched`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
      <p>Hey ${escape(opts.firstName)},</p>
      <p>Application received. To get matched with a rancher in your area, finish this 90-second quiz:</p>
      <p style="margin:28px 0">
        <a href="${opts.quizUrl}" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;text-transform:uppercase;letter-spacing:2px;font-size:13px;font-weight:600">
          Start the quiz →
        </a>
      </p>
      <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow<br><em>Connecting every household to a ranch they trust.</em></p>
    </div>`,
    templateName: 'buyer_signup_confirmation',
  });
}

// 2. Quiz complete → book Cal w/ Ben. Replaces auto-matching/suggest auto-intro.
//    Ben does the matching on the sales call.
export async function sendQuizCompleteCalInvite(opts: {
  to: string;
  firstName: string;
  score: number;
  calUrl?: string;
}) {
  const cal = opts.calUrl || (await getOperatorBookingUrl('sales'));
  return sendEmail({
    to: opts.to,
    subject: `You qualified. Book a 15-min call to lock your beef.`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
      <p>Hey ${escape(opts.firstName)},</p>
      <p>Quiz score: <strong>${opts.score}/100</strong>. You qualified.</p>
      <p>Next: 15-min call with me. I'll match you with a rancher in your area and lock your share.</p>
      <p style="margin:28px 0">
        <a href="${cal}" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;text-transform:uppercase;letter-spacing:2px;font-size:13px;font-weight:600">
          Book the call →
        </a>
      </p>
      <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow<br><em>Connecting every household to a ranch they trust.</em></p>
    </div>`,
    templateName: 'quiz_complete_cal_invite',
  });
}

// 2b. Quiz complete → DEPOSIT-PRIMARY invite (tier_v2 / Stripe-Connect rancher).
//     Deposit optionality fix (2026-06-30): a qualified buyer matched to a
//     deposit-capable rancher should NEVER be call-only. The dominant CTA is a
//     one-tap deposit (the magic-link lands them authed straight on the Stripe
//     deposit page — zero new fields); the call is demoted to a quiet lowercase
//     "or book a 15-min call with ben first" text link below it, framed as the
//     lower-commitment fallback. Lowercase, honest brand voice throughout; the
//     only emphasis is the single filled button (von Restorff isolation).
export async function sendQuizCompleteDepositInvite(opts: {
  to: string;
  firstName: string;
  score: number;
  // Member-verify magic link → /checkout/<refId>/deposit. Buyer arrives authed
  // and goes straight to Stripe (Apple/Google Pay one-tap on mobile).
  depositMagicLinkUrl: string;
  rancherName?: string;
  depositAmount?: number | null;
  nextProcessingDate?: string;
  // Quiet secondary. Ben's sales Cal — single source of truth (lib/salesContact).
  benCalUrl?: string;
}) {
  const cal = opts.benCalUrl || BEN_SALES_CAL_URL;
  const rancher = (opts.rancherName || '').trim();
  // Honest scarcity / context line above the button — only real, server-known
  // facts (rancher name + next processing date). Never a fabricated countdown.
  const processing = opts.nextProcessingDate
    ? (() => {
        try {
          return new Date(opts.nextProcessingDate as string).toLocaleDateString(undefined, {
            month: 'long',
            day: 'numeric',
          });
        } catch {
          return '';
        }
      })()
    : '';
  const scarcityBits: string[] = [];
  if (rancher) scarcityBits.push(`${escape(rancher)} processes on a rolling cycle`);
  if (processing) scarcityBits.push(`next slot: ${escape(processing)}`);
  const scarcityLine = scarcityBits.length
    ? `<p style="margin:4px 0 14px 0;font-size:13px;color:#6B4F3F">${scarcityBits.join(' · ')}</p>`
    : '';
  const depositAmt =
    typeof opts.depositAmount === 'number' && opts.depositAmount > 0
      ? `$${opts.depositAmount.toLocaleString()} `
      : '';
  const shareLabel = rancher ? `your share from ${escape(rancher)}` : 'your share';
  return sendEmail({
    to: opts.to,
    subject: rancher
      ? `you qualified — reserve your share from ${escape(rancher)}`
      : `you qualified — reserve your share`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
      <p>hey ${escape(opts.firstName)},</p>
      <p>quiz score: <strong>${opts.score}/100</strong>. you're matched${rancher ? ` with <strong>${escape(rancher)}</strong>` : ''} — your share is ready to reserve.</p>
      ${scarcityLine}
      <p style="margin:24px 0 8px 0">
        <a href="${opts.depositMagicLinkUrl}" style="display:block;width:100%;max-width:100%;box-sizing:border-box;padding:16px 24px;background:#0E0E0E;color:#FAF8F4;text-decoration:none;font-size:16px;font-weight:600;text-align:center">
          reserve ${shareLabel} — ${depositAmt}secure deposit →
        </a>
      </p>
      <p style="margin:0 0 24px 0;font-size:12px;color:#6B4F3F;text-align:center">fully refundable until processing · payment secured by stripe</p>
      <p style="margin:24px 0 0 0;font-size:14px;color:#6B4F3F;text-align:center">
        not ready? <a href="${cal}" style="color:#6B4F3F;text-decoration:underline">or book a 15-min call with ben first</a>
      </p>
      <p style="font-size:12px;color:#A7A29A;margin-top:28px">— Ben<br>BuyHalfCow<br><em>Connecting every household to a ranch they trust.</em></p>
    </div>`,
    templateName: 'quiz_complete_deposit_invite',
  });
}

// 3. Sales call closes → deposit invoice w/ Stripe Checkout URL.
//    Triggered from /admin/today v2 "Send Deposit Invoice" button.
export async function sendBuyerDepositInvoice(opts: {
  buyerEmail: string;
  buyerName: string;
  rancherName: string;
  cutTier: string;
  depositCents: number;
  fullSaleCents: number;
  checkoutUrl: string;
}) {
  const dep = (opts.depositCents / 100).toFixed(0);
  const full = (opts.fullSaleCents / 100).toFixed(0);
  const balance = ((opts.fullSaleCents - opts.depositCents) / 100).toFixed(0);
  return sendEmail({
    to: opts.buyerEmail,
    subject: `Reserve your ${opts.cutTier} from ${opts.rancherName} — $${dep} deposit`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
      <p>Hey ${escape(opts.buyerName)},</p>
      <p>Great call. Here's the deposit link to lock your <strong>${escape(opts.cutTier)}</strong> from <strong>${escape(opts.rancherName)}</strong>:</p>
      <div style="background:#FFFFFF;border:1px solid #A7A29A;padding:18px;margin:20px 0;font-size:15px">
        <strong>Today:</strong> $${dep} deposit<br>
        <strong>At pickup:</strong> $${balance} balance to ${escape(opts.rancherName)}<br>
        <strong>Total:</strong> $${full}
      </div>
      <p style="margin:28px 0">
        <a href="${opts.checkoutUrl}" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;text-transform:uppercase;letter-spacing:2px;font-size:13px;font-weight:600">
          Pay deposit + lock slot →
        </a>
      </p>
      <p style="font-size:13px;color:#5A5752;line-height:1.6">
        Refundable until ${escape(opts.rancherName)} accepts your slot. After they accept, deposit is non-refundable per our NRD policy.
        If the rancher declines, you get a full refund within 2 business days.
      </p>
      <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow<br><em>Connecting every household to a ranch they trust.</em></p>
    </div>`,
    templateName: 'buyer_deposit_invoice',
  });
}

// 4. Stripe webhook fires after rancher hits "Accept Slot" — buyer gets
//    "you're locked in" notification w/ processing date.
export async function sendSlotLockedConfirmation(opts: {
  to: string;
  firstName: string;
  rancherName: string;
  processingDate: string;
}) {
  return sendEmail({
    to: opts.to,
    subject: `Slot locked — ${opts.rancherName} processing ${opts.processingDate}`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
      <p>Hey ${escape(opts.firstName)},</p>
      <p><strong>${escape(opts.rancherName)}</strong> accepted your reservation. Your beef will be processed on <strong>${escape(opts.processingDate)}</strong>.</p>
      <p>A few days before pickup, ${escape(opts.rancherName)} will send your final invoice for the balance — paid through BuyHalfCow, straight to them.</p>
      <p>See you at pickup.</p>
      <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow<br><em>Connecting every household to a ranch they trust.</em></p>
    </div>`,
    templateName: 'slot_locked_confirmation',
  });
}

function escape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
