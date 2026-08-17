// BROKER RAIL settlement — the money landed in BHC's own Stripe balance.
//
// Fires from the PLATFORM webhook (app/api/webhooks/stripe/route.ts) on a
// payment_intent.succeeded / checkout.session.completed whose metadata carries
// `rail: 'broker'`. It never fires from the Connect webhook: a broker charge has
// no connected account, so Stripe has nowhere else to deliver it.
//
// WHAT SETTLEMENT MEANS ON THIS RAIL
//   • BHC keeps 100% of the deposit. It is the entire commission. There is no
//     payout to release, no application_fee to reconcile, no invoice to raise.
//   • The rancher is off-platform. This email is the ONLY notification he gets
//     and the ONLY place the fulfillment details exist for him.
//   • The buyer owes the RANCH price − deposit, paid direct.
//
// IDEMPOTENCY. Stripe delivers webhooks up to 3 days and can deliver the same
// payment twice (checkout.session.completed AND payment_intent.succeeded both
// carry this metadata). The anchor is markDepositSucceeded(pi.id), which
// returns false when the Payments row is ALREADY 'succeeded' — every
// non-idempotent side effect (two emails, Telegram) sits strictly after it. A
// Redis claimOnce in front closes the simultaneous-delivery window.

import { getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { markDepositSucceeded } from '@/lib/contracts/payments';
import { claimOnce } from '@/lib/rancherCapacity';
import { PermanentSettlementError } from '@/lib/stripeSettlement';
import {
  isBrokerRancher,
  readBrokerMoney,
  BROKER_MATCH_TYPE,
  CUT_LABELS,
  type Cut,
} from '@/lib/brokerRail';
import { buildBrokerOrderFacts, buildBrokerOperatorCard } from '@/lib/brokerNotify';
import { sendBrokerRancherOrder, sendBrokerBuyerReceipt } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { fireCapi, depositPurchaseEnabled } from '@/lib/metaCapi';
import { buildBrokerDepositCapiEvents } from '@/lib/brokerCapi';

// The pure money reader lives in lib/brokerRail (hermetic — unit-testable
// without prod env, since importing THIS module pulls lib/email → lib/secrets).
// Re-exported so callers keep a single import site.
export { readBrokerMoney };

/**
 * Settle a broker-rail deposit.
 *
 * Throws PermanentSettlementError for malformed metadata (Stripe should stop
 * redelivering — no retry can fix a missing referralId). Any other throw is
 * treated as transient by the caller, which returns 5xx so Stripe redelivers.
 */
export async function settleBrokerDeposit(pi: any): Promise<void> {
  const referralId = String(pi?.metadata?.referralId || '');
  const rancherId = String(pi?.metadata?.rancherId || '');
  const buyerId = String(pi?.metadata?.buyerId || '');
  const cut = String(pi?.metadata?.cut || '').toLowerCase() as Cut;

  if (!referralId || !rancherId || !pi?.id) {
    const keys = Object.keys(pi?.metadata || {}).join(',');
    throw new PermanentSettlementError(
      `broker_deposit missing required ids — refId=${!!referralId} rancherId=${!!rancherId} piId=${!!pi?.id} actualMetadataKeys=[${keys}]`,
    );
  }

  // balanceCents is intentionally not destructured here — the notification
  // layer recomputes it from (priceCents, depositCents) inside
  // buildBrokerOrderFacts, which is the single place that clamps it at zero.
  // WEIGHT-PRICED mode: priceCents is the range FLOOR and priceMaxCents the
  // ceiling (readBrokerMoney collapses the ceiling to the exact price when the
  // metadata carries none). The deposit — the commission — is identical in
  // both modes.
  const { depositCents, priceCents, priceMaxCents } = readBrokerMoney(pi);

  // Serialize simultaneous deliveries for this PI. Degrades OPEN if Redis is
  // down — the row-flip gate below is the real guarantee.
  if (!(await claimOnce(`settle-broker:${pi.id}`, 60))) return;

  // IDEMPOTENCY ANCHOR. false === a prior delivery already settled this row,
  // so return before any email or Telegram can fire a second time.
  const flipped = await markDepositSucceeded(pi.id, {
    totalChargedCents: depositCents,
    referralId,
  });
  if (!flipped) return;

  // ── MONEY TRUTH ON THE REFERRAL (repo rule #2) ──────────────────────────
  // Everything a human or a report needs to see that this money is BHC's and
  // that the rancher is owed nothing:
  //   Deposit Paid At / Deposit Amount — the deposit itself
  //   Total Sale Amount               — the full share price. For a WEIGHT-
  //                                     PRICED cut this is the range FLOOR
  //                                     (metadata.priceCents carries the floor
  //                                     by construction): conservative, never
  //                                     overstates a sale whose exact price the
  //                                     hanging weight hasn't set yet. The
  //                                     range itself lives in the Stripe
  //                                     metadata + the referral Notes.
  //   BHC Fee Cents + Fee Captured At — on THIS rail the fee IS the deposit,
  //                                     so the whole deposit is stamped as the
  //                                     captured fee. That is the marker that
  //                                     the money is ours, not owed onward.
  //   Match Type = 'Broker — Deposit' — the human-readable rail label.
  // Status goes to 'Awaiting Payment' with the same meaning as the Connect
  // rail: money in, fulfillment outstanding. Here the outstanding balance is
  // owed to the RANCH, never to BHC.
  const nowIso = new Date().toISOString();
  try {
    await updateRecord(TABLES.REFERRALS, referralId, {
      'Status': 'Awaiting Payment',
      'Deposit Paid At': nowIso,
      'Deposit Amount': depositCents / 100,
      'Total Sale Amount': priceCents / 100,
      'BHC Fee Cents': depositCents,
      'Fee Captured At': nowIso,
      'Match Type': BROKER_MATCH_TYPE,
      'Last Buyer Activity At': nowIso,
    });
  } catch (e: any) {
    // FROZEN-MONEY window — the ledger row already flipped (the anchor), so a
    // redelivery will short-circuit and nothing retries this write. Alert loud.
    console.error('[broker settle] referral stamp failed:', e?.message);
    try {
      const { sendOperatorSignal } = await import('@/lib/operatorSignal');
      await sendOperatorSignal({
        urgency: 'loud',
        kind: 'system-error',
        summary: `BROKER deposit settled but referral stamp FAILED — fix by hand: referral ${referralId}`,
        detail:
          `PaymentIntent ${pi.id} settled on the BROKER rail (money is in BHC's own Stripe balance and is ` +
          `BHC's commission in full), but the Referral write FAILED: ${e?.message?.slice(0, 200) || 'unknown'}.\n` +
          `Nothing retries this — redelivery no-ops on the ledger anchor.\n` +
          `FIX BY HAND on referral ${referralId}: Status='Awaiting Payment', ` +
          `Deposit Paid At=now, Deposit Amount=$${(depositCents / 100).toFixed(2)}, ` +
          `Total Sale Amount=$${(priceCents / 100).toFixed(2)}, BHC Fee Cents=${depositCents}, ` +
          `Match Type='${BROKER_MATCH_TYPE}'.`,
        refs: [{ type: 'referral', id: referralId }],
        dedupeKey: `broker-stamp-failed-${referralId}`,
        dedupeWindowMs: 60 * 60 * 1000,
      });
    } catch (sigErr: any) {
      console.error('[broker settle] stamp-failure signal failed:', sigErr?.message);
    }
  }

  // ── Fetch the rows the notifications need (parallel, once) ──────────────
  const [rancher, referral, consumer]: any[] = await Promise.all([
    getRecordById(TABLES.RANCHERS, rancherId).catch(() => null),
    getRecordById(TABLES.REFERRALS, referralId).catch(() => null),
    buyerId ? getRecordById(TABLES.CONSUMERS, buyerId).catch(() => null) : Promise.resolve(null),
  ]);

  // ── META CONVERSIONS API — the broker rail's conversion signal ────────────
  // Mirrors lib/stripeSettlement (~416/~445): an ALWAYS-fired InitiateCheckout
  // (intent) plus a Purchase gated on depositPurchaseEnabled() — the same
  // env-authoritative, dark-by-default flag, read here so both rails turn on
  // together. Event construction + the value decision live in lib/brokerCapi
  // (pure, tested); read its VALUE SEMANTICS note before touching the amount.
  //
  // Placed BEFORE the unreadable-rancher bail below: the money has settled and
  // the buyer identity is already in hand, so the conversion must be reported
  // even on the rare path where we can't compose the emails. Fully fail-open —
  // fire-and-forget, wrapped, and never able to surface into a settled payment.
  try {
    fireCapi(
      buildBrokerDepositCapiEvents({
        referralId,
        // What the buyer's card was actually charged (readBrokerMoney clamps
        // this to pi.amount). The balance is paid to the ranch off-platform and
        // is NOT part of this transaction — never report the share price here.
        depositCents,
        consumer,
        referral,
        cutLabel: CUT_LABELS[cut] || String(referral?.['Order Type'] || ''),
        purchaseEnabled: depositPurchaseEnabled(),
      }),
    ).catch((e) => console.error('[broker settle] meta capi fire failed:', e?.message || e));
  } catch (e: any) {
    // Belt for a synchronous throw before the promise forms — settlement has
    // already succeeded; a pixel problem must never surface here.
    console.error('[broker settle] meta capi setup failed:', e?.message || e);
  }

  if (!rancher) {
    // The money is safe and stamped; we just can't compose the emails. Alert so
    // a human sends them, and DON'T throw — throwing would make Stripe redeliver
    // a payment that already settled past the anchor (the emails still wouldn't send).
    console.error(`[broker settle] rancher ${rancherId} unreadable — notifications skipped`);
    try {
      const { sendOperatorSignal } = await import('@/lib/operatorSignal');
      await sendOperatorSignal({
        urgency: 'loud',
        kind: 'system-error',
        summary: `BROKER sale settled but the rancher record was unreadable — notify by hand (referral ${referralId})`,
        detail: `PI ${pi.id}. Deposit $${(depositCents / 100).toFixed(2)} is BHC's. The represented rancher has NOT been told about this order.`,
        refs: [{ type: 'referral', id: referralId }],
        dedupeKey: `broker-notify-blocked-${referralId}`,
      });
    } catch {}
    return;
  }

  // Belt on the rail marker: the charge metadata already said 'broker', but if
  // the rancher record disagrees, say so loudly rather than silently emailing
  // "we kept your deposit" to someone on the Connect rail.
  if (!isBrokerRancher(rancher)) {
    console.error(
      `[broker settle] rancher ${rancherId} settled a broker PI but is NOT flagged Broker Rail — check the record`,
    );
  }

  const facts = buildBrokerOrderFacts({
    rancher,
    referral: referral || {},
    consumer,
    cutLabel: CUT_LABELS[cut] || String(referral?.['Order Type'] || 'Beef share'),
    priceCents,
    depositCents,
    // WEIGHT-PRICED ceiling from the Stripe metadata (== priceCents in exact
    // mode, which the facts builder collapses back to exact framing). Never
    // re-read from the rancher's price fields — they may have been edited
    // between checkout and settlement.
    priceMaxCents,
    orderRef: `BHC-${referralId.slice(-6)}`,
  });

  // ── RANCHER EMAIL — the deliverable. Everything he needs, no login. ──────
  if (facts.rancherEmail) {
    try {
      const res = await sendBrokerRancherOrder(facts);
      // Money-truth persisted, not just logged: stamp WHETHER he was told.
      await updateRecord(TABLES.REFERRALS, referralId, {
        'Intro Sent At': nowIso,
        Notes: `${String(referral?.['Notes'] || '')}\n[broker] rancher notified ${nowIso} — sent=${res?.success === true}`.trim(),
      }).catch(() => {});
      if (!res?.success) {
        console.error('[broker settle] rancher order email did not send:', res?.reason);
      }
    } catch (e: any) {
      console.error('[broker settle] rancher order email threw:', e?.message);
    }
  } else {
    console.error(`[broker settle] rancher ${rancherId} has no email — cannot deliver the order`);
  }

  // ── BUYER RECEIPT ───────────────────────────────────────────────────────
  if (facts.buyerEmail) {
    try {
      await sendBrokerBuyerReceipt(facts);
    } catch (e: any) {
      console.error('[broker settle] buyer receipt threw:', e?.message);
    }
  }

  // ── OPERATOR CARD ───────────────────────────────────────────────────────
  try {
    await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, buildBrokerOperatorCard(facts));
  } catch (e: any) {
    console.error('[broker settle] telegram card failed:', e?.message);
  }
}
