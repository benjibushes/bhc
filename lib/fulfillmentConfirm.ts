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
import { referralRail, isBrokerReferralRow } from '@/lib/commission';

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

// ---------------------------------------------------------------------------
// THE OPERATOR PATH — how a BROKER deal reaches a terminal state at all
// ---------------------------------------------------------------------------
//
// P0 (2026-08-18 fulfillment audit). `Fulfillment Confirmed At` is written in
// exactly one place — confirmFulfillmentForReferral above — and until now it
// was reachable only from two RANCHER-SESSION routes
// (/api/rancher/fulfillment/confirm and /api/rancher/referrals/[id]/fulfillment).
//
// A represented ranch has no session. No login, no dashboard, no password: the
// broker rail exists precisely because that rancher onboarded to nothing. So a
// paid broker deposit parked at Status 'Awaiting Payment' FOREVER — no
// completion path existed in the product at all, and two live AZ referrals
// were sitting on exactly that.
//
// The fix is an operator-authenticated entry point (POST
// /api/admin/referrals/[id]/confirm-fulfillment) that runs the SAME confirm
// rail with the ownership check replaced by admin auth, plus the rail-aware
// close below.

export type AdminFulfillmentClose =
  | { close: false; rail: 'broker' | 'connect'; reason: string }
  | {
      close: true;
      rail: 'broker';
      outcome: 'won';
      /** Undefined when no trustworthy price exists — recordClose then leaves
       *  'Sale Amount' untouched rather than stamping a made-up 0. */
      saleAmount?: number;
      /** Structurally false. The fee was collected in full at deposit. */
      writeCommissionDue: false;
    };

/**
 * Should confirming fulfillment ALSO close this deal, and on what terms?
 *
 * BROKER → YES, 'Closed Won'. The buyer's deposit already settled 100% to BHC
 * and IS the entire fee; the ranch collects the balance direct at pickup, off
 * platform. Fulfillment confirmed is therefore the LAST event in the deal —
 * there is no final invoice to wait on, so nothing else will ever move the row
 * off 'Awaiting Payment'. Commission Due is NEVER written: a represented
 * rancher signed no agreement, is never invoiced, and a Commission Due on a
 * broker row is a phantom every downstream reader has to defend against
 * (see lib/commission brokerFeeDollars / partitionUnpaidByRail).
 *
 * CONNECT → NO. That rail's terminal close arrives with the balance: the
 * rancher sends the final invoice, the buyer pays it, and settleFinalInvoice →
 * recordClose closes the deal with the real sale amount and the commission
 * machinery attached. Closing here would pre-empt all of it. Behaviour on the
 * Connect rail is therefore exactly what the rancher-session routes already
 * do — stamp the confirmation, change nothing else.
 *
 * Already-terminal rows are a no-op in both directions so a double-tap, a
 * retry, or a re-confirm can never re-fire the close side effects.
 *
 * Pure — no I/O, so both branches are unit-pinned.
 */
export function adminFulfillmentCloseDecision(
  referral: any,
  opts: { saleAmountOverride?: number } = {},
): AdminFulfillmentClose {
  const rail: 'broker' | 'connect' = isBrokerReferralRow(referral) ? 'broker' : 'connect';
  if (rail !== 'broker') {
    return {
      close: false,
      rail,
      reason:
        'Connect rail — the deal closes when the buyer pays the final invoice, not at fulfillment confirm.',
    };
  }

  const status = String(referral?.['Status'] ?? '').trim();
  if (status === 'Closed Won' || status === 'Closed Lost' || status === 'Refunded') {
    return { close: false, rail, reason: `Referral is already terminal (${status}).` };
  }

  // Price precedence:
  //   1. the operator's explicit override — a WEIGHT-PRICED ranch only learns
  //      the exact price at hanging weight, which is THIS moment;
  //   2. an existing 'Sale Amount' (a hand-set price already agreed);
  //   3. 'Total Sale Amount', stamped at settlement. For a weight-priced cut
  //      that is the range FLOOR — conservative, never overstates a sale.
  // None of them usable → leave the field alone. A stamped 0 would read as a
  // free cow in every revenue surface.
  const candidates = [opts.saleAmountOverride, referral?.['Sale Amount'], referral?.['Total Sale Amount']];
  let saleAmount: number | undefined;
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) {
      saleAmount = n;
      break;
    }
  }

  return { close: true, rail, outcome: 'won', saleAmount, writeCommissionDue: false };
}

export type AdminConfirmFulfillmentResult =
  | {
      ok: true;
      alreadyConfirmed: boolean;
      fulfillmentConfirmedAt: string;
      rail: 'broker' | 'connect';
      closed: boolean;
      closeSkippedReason?: string;
      saleAmount?: number;
    }
  | { ok: false; status: number; error: string; rail?: string };

/**
 * Operator confirm — the completion path a represented ranch cannot reach on
 * its own. Auth belongs to the calling route (requireAdmin); this helper owns
 * the rail decision so the route stays a thin shell.
 *
 * The rancher-SESSION gate is what is skipped, and only that. The PAYMENT gate
 * inside confirmFulfillmentForReferral is deliberately kept: a settled broker
 * deposit satisfies it (its Payments row is flipped to 'succeeded' by
 * settleBrokerDeposit before anything else), so the gate costs a real broker
 * deal nothing while still refusing to mark beef delivered on a deal nobody
 * ever paid for.
 */
export async function confirmFulfillmentAsAdmin(args: {
  referralId: string;
  /** The already-loaded Referrals row (flattened fields). */
  referral: Record<string, any>;
  note?: string;
  /** Exact price when the ranch prices on hanging weight. */
  saleAmountOverride?: number;
}): Promise<AdminConfirmFulfillmentResult> {
  const { referralId, referral } = args;

  const rancherLinks: string[] = (referral['Rancher'] || []) as string[];
  const rancherId = Array.isArray(rancherLinks) ? rancherLinks[0] : '';
  if (!rancherId) {
    return { ok: false, status: 422, error: 'Referral has no rancher linked — cannot confirm fulfillment.' };
  }

  const confirmed = await confirmFulfillmentForReferral({
    referralId,
    rancherId,
    referral,
    rancherNote: args.note,
  });
  if (!confirmed.ok) return confirmed;

  const decision = adminFulfillmentCloseDecision(referral, {
    saleAmountOverride: args.saleAmountOverride,
  });
  if (!decision.close) {
    return {
      ok: true,
      alreadyConfirmed: confirmed.alreadyConfirmed,
      fulfillmentConfirmedAt: confirmed.fulfillmentConfirmedAt,
      rail: decision.rail,
      closed: false,
      closeSkippedReason: decision.reason,
    };
  }

  // recordClose is the single source of truth for a close: status + Closed At,
  // the capacity DECR (gated on leaving the canonical held set — 'Awaiting
  // Payment' IS held, so this is what finally frees the ranch's slot), the
  // Buyer Stage flip, affiliate enrolment, and the funnel event. It writes NO
  // 'Commission Due', which is exactly right here: nothing is owed.
  //
  // Dynamic import — lib/contracts/rancher pulls the affiliate + Meta CAPI
  // stack, and the two rancher-session routes that import THIS module must not
  // pay for it on a path they never take.
  let closed = false;
  try {
    const { recordClose } = await import('@/lib/contracts/rancher');
    const res = await recordClose({
      referralId,
      rancherId,
      outcome: decision.outcome,
      ...(typeof decision.saleAmount === 'number' ? { saleAmount: decision.saleAmount } : {}),
      reason: 'admin fulfillment confirm (broker rail)',
    });
    closed = res.ok;
  } catch (e: any) {
    // The confirmation stamp already landed and is the money-truth write. A
    // close failure is recoverable by re-running this endpoint, so report it
    // rather than throwing away the confirmation the operator just made.
    console.error('[fulfillmentConfirm/admin] broker close failed:', e?.message);
    return {
      ok: true,
      alreadyConfirmed: confirmed.alreadyConfirmed,
      fulfillmentConfirmedAt: confirmed.fulfillmentConfirmedAt,
      rail: 'broker',
      closed: false,
      closeSkippedReason: `Close failed: ${e?.message || 'unknown'}. Fulfillment IS stamped — re-run to close.`,
    };
  }

  return {
    ok: true,
    alreadyConfirmed: confirmed.alreadyConfirmed,
    fulfillmentConfirmedAt: confirmed.fulfillmentConfirmedAt,
    rail: 'broker',
    closed,
    ...(typeof decision.saleAmount === 'number' ? { saleAmount: decision.saleAmount } : {}),
    ...(closed ? {} : { closeSkippedReason: 'recordClose reported no-op (referral unreadable).' }),
  };
}
