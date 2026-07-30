// lib/fulfillmentConfirm.ts
//
// Wave 2 (2026-07-29) — THE single "beef is delivered" side-effect rail,
// extracted verbatim from app/api/rancher/fulfillment/confirm/route.ts so both
// delivered-systems converge on it:
//   1. The binary confirm row (POST /api/rancher/fulfillment/confirm)
//   2. The richer tracker's `fulfilled` status
//      (POST /api/rancher/referrals/[id]/fulfillment)
// Before this, the tracker's `fulfilled` never stamped Fulfillment Confirmed
// At, never emailed the buyer, never hit the funnel or Telegram — so the chase
// cron kept nagging "unconfirmed" deals the rancher had already marked
// delivered in the tracker, and legacy-rail ranchers (whose confirm row was
// tier_v2-gated) could never fire the buyer delivery email at all.
//
// What it does (same order as the original route):
//   1. Idempotency — Fulfillment Confirmed At already set → no-op success.
//   2. Payment gate — RAIL-PER-REFERRAL (lib/commission referralRail):
//      deposit-rail rows need a succeeded Payments row; everything else
//      accepts a Payments row OR Payment Confirmed At.
//   3. Stamp Referrals.Fulfillment Confirmed At = now.
//   4. Funnel event `fulfillment_confirmed`.
//   5. Buyer "beef received" email (best-effort).
//   6. Telegram operator alert (best-effort).
//
// Auth/ownership stay in the calling routes — this helper assumes the caller
// already verified the rancher owns the referral.

import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { findPaymentsByReferral } from '@/lib/contracts/payments';
import { sendBuyerFulfillmentConfirmation } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { funnelRecord } from '@/lib/funnelMetrics';
import { referralRail } from '@/lib/commission';

export type ConfirmFulfillmentResult =
  | { ok: true; alreadyConfirmed: boolean; fulfillmentConfirmedAt: string }
  | { ok: false; status: number; error: string; rail?: string };

export async function confirmFulfillmentForReferral(args: {
  referralId: string;
  rancherId: string;
  /** The already-loaded Referrals row (flattened fields). */
  referral: Record<string, any>;
  /** Optional rancher handoff note, mirrored into the buyer email. */
  rancherNote?: string;
}): Promise<ConfirmFulfillmentResult> {
  const { referralId, rancherId, referral } = args;
  const rancherNote = (args.rancherNote || '').trim().slice(0, 500);

  // ── Idempotency ──
  if (referral['Fulfillment Confirmed At']) {
    return {
      ok: true,
      alreadyConfirmed: true,
      fulfillmentConfirmedAt: String(referral['Fulfillment Confirmed At']),
    };
  }

  // ── Payment gate ──
  // Don't allow fulfillment confirm without a settled deposit. Either the
  // tier_v2 path (Payments row Status='succeeded') OR the legacy path
  // (Referrals.Payment Confirmed At set by /confirm-payment) qualifies.
  let paymentVerified = false;
  let paymentTier = '';
  let paymentAmountCents = 0;
  try {
    // Payments-by-referral (G1/E6): exact match on the denormalized
    // {Referral Id Text} first, legacy ARRAYJOIN scan only as the back-compat
    // fallback for pre-field rows (see findPaymentsByReferral).
    const payments: any[] = await findPaymentsByReferral(referralId, {
      statusClause: `{Status} = "succeeded"`,
    });
    if (payments.length > 0) {
      paymentVerified = true;
      paymentTier = String(payments[0]['Tier'] || '');
      paymentAmountCents = Number(payments[0]['Amount Cents'] || 0);
    }
  } catch (e: any) {
    console.warn('[fulfillmentConfirm] Payments lookup failed:', e?.message);
  }
  // Payment verification gate — RAIL-PER-REFERRAL, not per-rancher (same
  // discriminator as every commission path: lib/commission.ts referralRail).
  //   - Deposit-rail rows (Deposit Paid At stamped) MUST have a Payments row
  //     at Status='succeeded' — rancher-self-attested Payment Confirmed At
  //     would let a rail close skip Stripe evidence (2026-05-25 Audit A).
  //   - Everything else (legacy rancher OR tier_v2 off-rail close) accepts a
  //     Payments row OR Payment Confirmed At.
  const rancherForGate: any = await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null);
  const rancherPricingModel = String(rancherForGate?.['Pricing Model'] || 'legacy');
  if (referralRail(referral) === 'tier_v2') {
    if (!paymentVerified) {
      return {
        ok: false,
        status: 409,
        error: 'No settled Stripe deposit on this referral. Buyer must pay via the deposit link first.',
        rail: 'tier_v2',
      };
    }
  } else if (!paymentVerified && !referral['Payment Confirmed At']) {
    return {
      ok: false,
      status: 409,
      error: 'No settled payment on this referral. Confirm payment first.',
    };
  }

  // ── Stamp ──
  const now = new Date().toISOString();
  try {
    await updateRecord(TABLES.REFERRALS, referralId, {
      'Fulfillment Confirmed At': now,
    });
  } catch (e: any) {
    console.error('[fulfillmentConfirm] Airtable update failed:', e);
    return {
      ok: false,
      status: 500,
      error: 'Could not record fulfillment. Please try again.',
    };
  }

  // H-2 audit fix: funnel event for the fulfillment moment.
  try {
    const buyerLinksForFunnel: string[] = (referral['Buyer'] || []) as string[];
    const buyerIdForFunnel = Array.isArray(buyerLinksForFunnel) ? buyerLinksForFunnel[0] : undefined;
    await funnelRecord({
      stage: 'fulfillment_confirmed',
      referralId,
      rancherId,
      buyerId: buyerIdForFunnel,
      amount: paymentAmountCents ? paymentAmountCents / 100 : undefined,
      metadata: {
        tier: paymentTier,
        pricingModel: rancherPricingModel,
        hasNote: !!rancherNote,
      },
    });
  } catch (e) { console.error('[funnel] fulfillment_confirmed failed:', e); }

  // ── Buyer email (best-effort — don't block the response on email infra) ──
  try {
    const buyerLinks: string[] = (referral['Buyer'] || []) as string[];
    const buyerId = Array.isArray(buyerLinks) ? buyerLinks[0] : null;
    const buyer: any = buyerId ? await getRecordById(TABLES.CONSUMERS, buyerId).catch(() => null) : null;
    const rancher: any = rancherForGate || (await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null));
    if (buyer?.['Email'] && rancher) {
      const firstName = String(buyer['Full Name'] || '').split(' ')[0] || '';
      await sendBuyerFulfillmentConfirmation({
        email: String(buyer['Email']),
        firstName,
        rancherName: String(rancher['Operator Name'] || rancher['Ranch Name'] || 'your rancher'),
        ranchName: String(rancher['Ranch Name'] || rancher['Operator Name'] || ''),
        orderType: String(referral['Order Type'] || ''),
        rancherNote,
      });
    }
  } catch (e: any) {
    console.warn('[fulfillmentConfirm] buyer email failed:', e?.message);
  }

  // ── Telegram alert (best-effort) ──
  try {
    const amountDollars = paymentAmountCents ? `$${(paymentAmountCents / 100).toFixed(2)} ` : '';
    const tierTag = paymentTier ? `${paymentTier} tier · ` : '';
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `📦 FULFILLMENT CONFIRMED — ${tierTag}${amountDollars}ref=${referralId.slice(-6)}${rancherNote ? `\n💬 ${rancherNote}` : ''}`,
    );
  } catch (e: any) {
    console.warn('[fulfillmentConfirm] telegram alert failed:', e?.message);
  }

  return { ok: true, alreadyConfirmed: false, fulfillmentConfirmedAt: now };
}
