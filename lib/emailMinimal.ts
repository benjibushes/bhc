// lib/emailMinimal.ts
//
// Sales-floor pivot 2026-06-09: BHC's minimal buyer-facing email pipeline.
// Transactional templates only. No drip. No nurture.
//
//   1. sendQuizCompleteCalInvite       — quiz done → book Ben's Cal
//   2. sendQuizCompleteDepositInvite   — quiz done → deposit-primary invite
//   3. sendBuyerDepositInvoice         — Ben closed on call → deposit link
//   4. sendBuyerFinalInvoice           — (lives in lib/email.ts — reused)
//   5. Stripe Connect Active alert     — (lives in webhook — reused)
//
// (sendBuyerSignupConfirmation + sendSlotLockedConfirmation deleted
// 2026-08-01, Wave 2 — zero callers; the signup ack is owned by
// sendWelcomeAndReadyToBuy / sendQuizInvite and the slot-locked moment by
// sendBuyerSlotLocked in lib/email.ts.)
//
// All templates route through guardedSend via lib/email.ts:sendEmail
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
    subject: `you qualified — book a 15-min call to lock your beef`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
      <p>hey ${escape(opts.firstName)},</p>
      <p>quiz score: <strong>${opts.score}/100</strong>. you qualified.</p>
      <p>next is a 15-min call with me. i'll match you with a rancher in your area and lock your share.</p>
      <p style="margin:28px 0">
        <a href="${cal}" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#FAF8F4;text-decoration:none;font-size:15px;font-weight:600">
          book the call →
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
      <p style="margin:14px 0 0 0;font-size:13px;color:#6B4F3F;text-align:center">no rush either way — ${rancher ? escape(rancher) : 'your rancher'} already has your details and will reach out within 24–48 hours.</p>
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
  // FEE-INVISIBLE (founder directive 2026-07-01): the amount the buyer's card
  // is actually charged at the checkout link (deposit + baked-in commission,
  // = createDepositCheckout's totalChargedCents). When provided, the email
  // quotes THIS single number — never a deposit/fee split, and never a
  // rancher-portion figure the Stripe page would then contradict.
  chargedCents?: number;
  checkoutUrl: string;
  // 2026-07-05 deposit-rail LEAK 1: the rancher's phone, so the buyer can
  // text/call a real person about a real reservation. Optional — callers
  // without it keep working; the "text <first>" line simply drops.
  rancherPhone?: string;
  // Rancher brand fields (2026-07-23). Optional — when present, a one-line
  // tagline renders under the reservation so the deposit ask carries the
  // ranch's identity (matters for the exclusive supplier). Blank ⇒ omitted.
  rancherTagline?: string;
  rancherAbout?: string;
}) {
  const dep = ((opts.chargedCents ?? opts.depositCents) / 100).toFixed(0);
  const balance = ((opts.fullSaleCents - opts.depositCents) / 100).toFixed(0);
  // Compact brand block: tagline as an italic line + (optional) short about.
  // Renders only when a field is present so no empty header ever ships.
  const brandTagline = opts.rancherTagline
    ? `<p style="margin:2px 0 0 0;font-style:italic;font-size:14px;color:#6B4F3F">&ldquo;${escape(opts.rancherTagline)}&rdquo;</p>`
    : '';
  const brandAbout = opts.rancherAbout
    ? `<p style="margin:12px 0 0 0;font-size:13px;color:#5A5752;line-height:1.6">${escape(opts.rancherAbout)}</p>`
    : '';
  const brandBlock = opts.rancherTagline || opts.rancherAbout
    ? `<div style="border-left:3px solid #A7A29A;padding:2px 0 2px 14px;margin:18px 0">
        <p style="margin:0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#6B4F3F">About ${escape(opts.rancherName)}</p>
        ${brandTagline}${brandAbout}
      </div>`
    : '';
  // LEAK 1 (2026-07-05, rancher-sent deposits 0-for-7): the old copy opened
  // "Great call." — presuming a phone call that (for cold dashboard sends)
  // never happened — with Ben as the actor. Buyers got thanked for a
  // conversation they never had → read as phishy → ignored. The rewrite makes
  // the RANCHER the protagonist ("set aside a <Cut> for you"), reads true
  // whether or not a call happened, gives the buyer a human to text, and
  // states the real urgency (slots are first-come until the deposit lands).
  const rancherFirst = escape(String(opts.rancherName || '').trim().split(/\s+/)[0] || 'your rancher');
  const phoneLine = opts.rancherPhone
    ? `questions? text ${rancherFirst} at <a href="sms:${escape(opts.rancherPhone)}" style="color:#0E0E0E;font-weight:600;">${escape(opts.rancherPhone)}</a> — or just reply to this email.`
    : `questions? just reply to this email — it gets to ${rancherFirst}.`;
  return sendEmail({
    to: opts.buyerEmail,
    subject: `${opts.rancherName} set aside your ${opts.cutTier} — $${dep} deposit`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
      <p>hey ${escape(opts.buyerName)},</p>
      <p><strong>${escape(opts.rancherName)}</strong> set aside a <strong>${escape(opts.cutTier)}</strong> for you and sent over your deposit link.</p>
      ${brandBlock}
      <div style="background:#FFFFFF;border:1px solid #A7A29A;padding:18px;margin:20px 0;font-size:15px">
        <strong>today:</strong> $${dep} deposit<br>
        <strong>at pickup:</strong> $${balance} balance to ${escape(opts.rancherName)}
      </div>
      <p style="margin:28px 0">
        <a href="${opts.checkoutUrl}" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#FAF8F4;text-decoration:none;font-size:15px;font-weight:600">
          pay deposit + lock your slot →
        </a>
      </p>
      <p style="font-size:14px;color:#2A2A2A;line-height:1.6">
        heads up — your slot isn't held until the deposit lands. ${rancherFirst}'s processing dates fill first-come.
      </p>
      <p style="font-size:14px;color:#2A2A2A;line-height:1.6">${phoneLine}</p>
      <p style="font-size:13px;color:#5A5752;line-height:1.6">
        fully refundable until ${escape(opts.rancherName)} accepts your slot. after they accept, the deposit is non-refundable. if the rancher declines, you get a full refund within 2 business days.
      </p>
      <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow<br><em>Connecting every household to a ranch they trust.</em></p>
    </div>`,
    templateName: 'buyer_deposit_invoice',
  });
}

// 3b. LEAK 2 (2026-07-05): buyer-facing nudge on an UNPAID deposit request.
//     Previously an unpaid request got zero buyer follow-up for 14 days (and
//     that net pinged the rancher). Two touches, capped by the cron's
//     selector: nudge 1 (~24h) urgency, nudge 2 (~72h+) soft last-touch.
//     The link is the magic-link → deposit-page hop (NOT the stored Stripe
//     session URL — those expire in ~24h, exactly when this fires).
export async function sendDepositRequestNudge(opts: {
  buyerEmail: string;
  buyerName: string;
  rancherName: string;
  cutTier: string;
  checkoutUrl: string; // magic-link hop to /checkout/<refId>/deposit
  rancherPhone?: string;
  /** 1 = first nudge (urgency), 2 = final soft touch. */
  touch: 1 | 2;
}) {
  const rancherFirst = escape(String(opts.rancherName || '').trim().split(/\s+/)[0] || 'your rancher');
  const phoneLine = opts.rancherPhone
    ? ` questions? text ${rancherFirst} at <a href="sms:${escape(opts.rancherPhone)}" style="color:#0E0E0E;font-weight:600;">${escape(opts.rancherPhone)}</a> or reply to this email.`
    : ` questions? just reply to this email.`;
  const first = opts.touch === 1;
  const subject = first
    ? `your ${opts.cutTier} from ${opts.rancherName} is still waiting`
    : `should ${opts.rancherName} hold your ${opts.cutTier}?`;
  const body = first
    ? `<p>hey ${escape(opts.buyerName)},</p>
      <p><strong>${escape(opts.rancherName)}</strong> still has your <strong>${escape(opts.cutTier)}</strong> set aside — but the slot isn't held until your deposit lands, and ${rancherFirst}'s processing dates fill first-come.</p>
      <p style="margin:26px 0">
        <a href="${opts.checkoutUrl}" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#FAF8F4;text-decoration:none;font-size:15px;font-weight:600">pay deposit + lock your slot →</a>
      </p>
      <p style="font-size:14px;color:#2A2A2A;line-height:1.6">fully refundable until ${rancherFirst} accepts your slot.${phoneLine}</p>`
    : `<p>hey ${escape(opts.buyerName)},</p>
      <p>last note from me on this one — <strong>${escape(opts.rancherName)}</strong> has been holding a <strong>${escape(opts.cutTier)}</strong> for you. if the timing's wrong, no hard feelings; if you still want it, here's your link:</p>
      <p style="margin:26px 0">
        <a href="${opts.checkoutUrl}" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#FAF8F4;text-decoration:none;font-size:15px;font-weight:600">lock it in →</a>
      </p>
      <p style="font-size:14px;color:#2A2A2A;line-height:1.6">want us to release the spot instead, or hold it a bit longer? reply and tell me.${phoneLine}</p>`;
  return sendEmail({
    to: opts.buyerEmail,
    subject,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
      ${body}
      <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow<br><em>Connecting every household to a ranch they trust.</em></p>
    </div>`,
    templateName: first ? 'deposit_request_nudge_1' : 'deposit_request_nudge_2',
  });
}

// 3c. FRESHNESS RE-CONFIRM (2026-07-06, conversion slice 2): a buyer whose
//     quiz stamp is >28 days old must one-click confirm they're still in the
//     market before routing to a rancher — no re-quiz, one tap. Keeps rancher
//     pipelines current-buyers-only.
export async function sendStillLookingReconfirm(opts: {
  buyerEmail: string;
  buyerName: string;
  state?: string;
  confirmUrl: string;
}) {
  const where = opts.state ? ` in ${escape(opts.state)}` : ' near you';
  return sendEmail({
    to: opts.buyerEmail,
    subject: `still looking for beef${opts.state ? ` in ${opts.state}` : ''}?`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC">
      <p>hey ${escape(opts.buyerName)},</p>
      <p>you signed up for a beef share a little while back. ranchers${where} have open slots now — but i only send them buyers who are actually in the market.</p>
      <p style="margin:28px 0">
        <a href="${opts.confirmUrl}" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#FAF8F4;text-decoration:none;font-size:15px;font-weight:600">
          yes — still looking, match me →
        </a>
      </p>
      <p style="font-size:13px;color:#5A5752;line-height:1.6">one click and you're back at the front of the line. if the timing's wrong now, just ignore this — no hard feelings, no more nags about it.</p>
      <p style="font-size:12px;color:#A7A29A">— Ben<br>BuyHalfCow<br><em>Connecting every household to a ranch they trust.</em></p>
    </div>`,
    templateName: 'still_looking_reconfirm',
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

// ── Rancher STOP-SHIP notice (Wave A 2026-07-14) ────────────────────────────
// reconcileProductOrderRefund flipped the order, restored stock, told ops
// ("If {rancher} hasn't shipped yet — TELL THEM TO STOP") and (since #375)
// told the buyer — but never told the RANCHER, the one person who can stop
// the box. The settle email even invites email-only fulfillment ("just reply
// here with the tracking"), so the dashboard's 409-on-refunded guard only
// helps if they check first. A rancher shipping a charged-back box eats the
// meat + shipping with funds already pulled from their Connect account.
// Template whitelisted transactional (money event, one-shot per PI via the
// reconcile's Refunded early-return — cannot cause volume).
export async function sendRancherStopShip(opts: {
  rancherEmail: string;
  rancherFirstName?: string;
  productName: string;
  buyerName: string;
  // 'cancel' (shop-chain audit 2026-08-01): an order cancelled + refunded in
  // full by the buyer/operator, distinct from a bare refund. The stop-ship
  // urgency is identical — the money already moved back either way.
  kind: 'refund' | 'dispute' | 'cancel';
}) {
  const first = (opts.rancherFirstName || '').trim() || 'there';
  const what =
    opts.kind === 'dispute'
      ? 'charged back by the buyer’s bank'
      : opts.kind === 'cancel'
        ? 'cancelled and refunded in full'
        : 'refunded';
  const headlineWord =
    opts.kind === 'dispute' ? 'charged back' : opts.kind === 'cancel' ? 'cancelled' : 'refunded';
  return sendEmail({
    to: opts.rancherEmail,
    subject: `🛑 DO NOT SHIP — ${opts.productName} order was ${headlineWord}`,
    templateName: 'sendRancherStopShip',
    html: `
      <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#26251E;">
        <p style="font-size:20px;">hey ${escape(first)} — <strong>do not ship this order.</strong></p>
        <p style="font-size:15px;line-height:1.6;">The <strong>${escape(opts.productName)}</strong> order for ${escape(opts.buyerName || 'the buyer')} was just ${what}. The money has already moved back — if you ship it now, you're out the meat and the shipping.</p>
        <p style="font-size:15px;line-height:1.6;">It's already marked <strong>${opts.kind === 'cancel' ? 'Cancelled' : 'Refunded'}</strong> in your dashboard, and if the box hasn't left yet there's nothing else you need to do. If it HAS already shipped, reply to this email right away and we'll sort it out together.</p>
        <p style="font-size:15px;line-height:1.6;"><a href="${SITE_URL}/rancher#products" style="color:#26251E;">See the order in your dashboard &rarr;</a></p>
        <p style="font-size:15px;">&mdash; Ben, BuyHalfCow</p>
      </div>`,
  });
}

// ── Buyer refund/dispute notice (checkout audit 2026-07-14) ─────────────────
// reconcileProductOrderRefund flipped the order + rang the operator but told
// the BUYER nothing — money moved back in silence, a trust and support-ticket
// generator. One plain, branded note: what was refunded, how much, when to
// expect it. Template whitelisted transactional (money event, never capped).
export async function sendBuyerRefundNotice(opts: {
  buyerEmail: string;
  buyerName: string;
  productName: string;
  rancherName: string;
  amountCents?: number;
  // 'cancel' (shop-chain audit 2026-08-01): the order was cancelled outright,
  // not just refunded. Saying "refund" for a cancel reads like something went
  // wrong with a live order; saying "cancelled" is the truth.
  kind: 'refund' | 'dispute' | 'cancel';
  /** Signed /order/<token> link — omitted when it can't be minted. */
  orderStatusUrl?: string;
}) {
  const first = (opts.buyerName || '').trim().split(/\s+/)[0] || 'there';
  const amt = opts.amountCents ? `$${(opts.amountCents / 100).toFixed(2)}` : 'your payment';
  const headline =
    opts.kind === 'dispute'
      ? 'your dispute has been processed'
      : opts.kind === 'cancel'
        ? 'your order is cancelled'
        : 'your refund is on its way';
  const body =
    opts.kind === 'dispute'
      ? `Your bank has processed the dispute for your <strong>${escape(opts.productName)}</strong> order from ${escape(opts.rancherName)}. The order has been cancelled on our side — nothing further is needed from you.`
      : opts.kind === 'cancel'
        ? `Your <strong>${escape(opts.productName)}</strong> order from ${escape(opts.rancherName)} has been cancelled and refunded in full (${amt}). Nothing is shipping. Refunds usually land back on your card within 5–10 business days, depending on your bank.`
        : `We've refunded <strong>${amt}</strong> for your <strong>${escape(opts.productName)}</strong> order from ${escape(opts.rancherName)}. Refunds usually land back on your card within 5–10 business days, depending on your bank.`;
  const statusLink = String(opts.orderStatusUrl || '').trim();
  return sendEmail({
    to: opts.buyerEmail,
    subject:
      opts.kind === 'dispute'
        ? 'Your BuyHalfCow order — dispute processed'
        : opts.kind === 'cancel'
          ? `Your BuyHalfCow order is cancelled — ${escape(opts.productName)}`
          : `Your BuyHalfCow refund — ${escape(opts.productName)}`,
    templateName: 'buyer_refund_notice',
    html: `
      <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#26251E;">
        <p style="font-size:20px;">hey ${escape(first)} — ${headline}.</p>
        <p style="font-size:15px;line-height:1.6;">${body}</p>
        ${statusLink ? `<p style="font-size:15px;line-height:1.6;"><a href="${statusLink}" style="color:#26251E;">See your order &rarr;</a></p>` : ''}
        <p style="font-size:15px;line-height:1.6;">If anything about this looks wrong, just reply to this email — a real person reads it.</p>
        <p style="font-size:15px;">&mdash; Ben, BuyHalfCow</p>
      </div>`,
  });
}

// ── Buyer "your order is running late" notice (shop-chain audit 2026-08-01) ──
//
// app/api/cron/product-fulfillment-sla already detected a stale paid order,
// nudged the rancher, and escalated to the operator — and never once told the
// BUYER, the only person whose money was sitting still. Silence at day 6 (or
// day 14 on the slow rail) is how a paid order becomes a chargeback.
//
// ONE honest note per order, forever. The cron stamps 'Buyer Delay Notified
// At' and READS IT BACK before sending, so a failed or not-yet-created stamp
// suppresses the mail instead of repeating it every run — which is precisely
// why this template is safe on the transactional whitelist (see
// lib/emailFrequencyGuard.ts).
//
// Copy rules: no excuses, no blaming the ranch, no promise we can't keep. Say
// what we know, say what we're doing, and offer the way out (a refund) up
// front rather than making them ask twice.
export async function sendBuyerOrderDelayNotice(opts: {
  buyerEmail: string;
  buyerName: string;
  productName: string;
  rancherName: string;
  ageDays: number;
  /** 'ship' | 'pickup' | 'deposit' — what was promised differs per kind. */
  kind: 'ship' | 'pickup' | 'deposit';
  /** Signed /order/<token> link — omitted when it can't be minted. */
  orderStatusUrl?: string;
}) {
  const first = (opts.buyerName || '').trim().split(/\s+/)[0] || 'there';
  const ranch = escape(opts.rancherName || 'the ranch');
  const what = escape(opts.productName || 'your order');
  const days = Math.max(1, Math.round(Number(opts.ageDays) || 1));
  const middle =
    opts.kind === 'pickup'
      ? `Your <strong>${what}</strong> from ${ranch} is paid and waiting, but the pickup still hasn't been arranged ${days} days on. That's longer than it should take.`
      : opts.kind === 'deposit'
        ? `You put a deposit down on <strong>${what}</strong> with ${ranch} ${days} days ago and they haven't come back to confirm the details yet. That's longer than it should take.`
        : `Your <strong>${what}</strong> from ${ranch} hasn't shipped yet — it's been ${days} days. That's longer than it should take, and you shouldn't have to chase it.`;
  const statusLink = String(opts.orderStatusUrl || '').trim();
  return sendEmail({
    to: opts.buyerEmail,
    subject: `about your ${opts.productName} order`,
    templateName: 'buyer_order_delay',
    html: `
      <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#26251E;">
        <p style="font-size:20px;">hey ${escape(first)} — we're on this.</p>
        <p style="font-size:15px;line-height:1.6;">${middle}</p>
        <p style="font-size:15px;line-height:1.6;">We've gone straight to ${ranch} about it and someone here is watching it. You don't need to do anything — we'll email you the moment it moves.</p>
        ${statusLink ? `<p style="font-size:15px;line-height:1.6;"><a href="${statusLink}" style="color:#26251E;">See your order &rarr;</a></p>` : ''}
        <p style="font-size:15px;line-height:1.6;">If you'd rather just have your money back, reply to this email and say so — we'll refund you, no argument and no forms.</p>
        <p style="font-size:15px;">&mdash; Ben, BuyHalfCow</p>
      </div>`,
  });
}

// ── Buyer "your rancher is slower than usual" deposit notice (Wave 2, GTM 2.3) ──
//
// The $50 shop rail got sendBuyerOrderDelayNotice above; the $2,000 SHARE
// deposit rail stayed silent. A buyer pays a deposit, is told the rancher
// reaches out "usually the same day", the rancher never taps Accept — and the
// deposit-accept-sla cron re-pinged the RANCHER and rang the operator while
// the buyer heard nothing, ever. This is the mirror.
//
// ONE honest note per referral, ever. The Referrals table has no free field
// for a stamp (no new Airtable fields allowed), so the one-shot throttle is
// the cron's Redis claimOnce (SET NX, long TTL) — the same pattern the
// settlement rails use. Copy rules match buyer_order_delay: no excuses, no
// blaming the ranch, the refund exit offered up front. The deposit at this
// stage is still fully refundable (pre-accept), so "your deposit is safe" and
// the refund offer are both literally true.
export async function sendBuyerDepositDelayNotice(opts: {
  buyerEmail: string;
  buyerName: string;
  rancherName: string;
  /** e.g. 'Quarter' | 'Half Beef' — display only; blank falls back to 'share'. */
  cutLabel?: string;
  hoursSinceDeposit: number;
}) {
  const first = (opts.buyerName || '').trim().split(/\s+/)[0] || 'there';
  const ranch = escape(opts.rancherName || 'your rancher');
  const cut = escape(String(opts.cutLabel || '').trim() || 'share');
  const days = Math.max(1, Math.round(opts.hoursSinceDeposit / 24));
  const dayWord = days === 1 ? 'a day' : `${days} days`;
  return sendEmail({
    to: opts.buyerEmail,
    subject: `about your ${String(opts.cutLabel || 'share').toLowerCase()} deposit`,
    templateName: 'buyer_deposit_delay',
    html: `
      <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#26251E;">
        <p style="font-size:20px;">hey ${escape(first)} — quick straight update.</p>
        <p style="font-size:15px;line-height:1.6;">Your deposit on a <strong>${cut}</strong> with ${ranch} landed ${dayWord} ago, and they haven't confirmed your slot yet. ${ranch} is being slower than usual — that's on us to chase, not you.</p>
        <p style="font-size:15px;line-height:1.6;">Your deposit is safe: it stays fully refundable until the rancher accepts your slot. We've already gone back to ${ranch} and a real person here is watching this one — you don't need to do anything.</p>
        <p style="font-size:15px;line-height:1.6;">Want us to step in — push harder, find you a different rancher, or just refund the deposit? Reply to this email and say so. No forms, no argument.</p>
        <p style="font-size:15px;">&mdash; Ben, BuyHalfCow</p>
      </div>`,
  });
}
