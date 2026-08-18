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
import {
  claimOnce,
  incrementCapacity,
  decrementCapacity,
  syncCapacityToAirtable,
} from '@/lib/rancherCapacity';
import { shouldIncrementOnEnterHeld } from '@/lib/refundLifecycle';
import { PermanentSettlementError } from '@/lib/stripeSettlement';
import {
  isBrokerRancher,
  readBrokerMoney,
  BROKER_MATCH_TYPE,
  CUT_LABELS,
  type Cut,
} from '@/lib/brokerRail';
import {
  buildBrokerOrderFacts,
  buildBrokerOperatorCard,
  classifyBrokerRancherDelivery,
  buildBrokerNotifyFailureAlert,
  brokerSheetNote,
  type BrokerOrderFacts,
  type BrokerRancherDelivery,
  type BrokerNotifyAlert,
} from '@/lib/brokerNotify';
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

  // ── CAPACITY CLAIM — the missing half of the held-slot invariant ─────────
  // 'Awaiting Payment' IS in the canonical held set (lib/capacityCount), so
  // the flip below makes this row count against the ranch's capacity. Every
  // Connect path claims its slot at the moment it enters that set; this rail
  // never did, because a represented ranch used to be unroutable and nobody
  // read the counter. Now that a self-serve broker ranch IS routable, an
  // unclaimed held row is read by liveHeldCountForRancher as phantom load —
  // N settled sales starve the ranch off its own capacity valve.
  //
  // BEFORE the flip, deliberately: the first INCR for a rancher bootstraps
  // from liveHeldCountForRancher, which would count an already-flipped row on
  // top of the increment and double-claim one slot.
  //
  // Skipped when the row is ALREADY held — a matching-created broker referral
  // sits at 'Intro Sent' and claimed its slot at routing time; claiming again
  // here would book two slots for one buyer.
  let capacityClaimed = false;
  try {
    const priorRef: any = await getRecordById(TABLES.REFERRALS, referralId);
    if (shouldIncrementOnEnterHeld(priorRef?.['Status'], 'Awaiting Payment')) {
      const claimed = await incrementCapacity(rancherId);
      capacityClaimed = true;
      await syncCapacityToAirtable(rancherId, claimed);
    }
  } catch (e: any) {
    // Never block settled money on a capacity read. Skipping errs toward a
    // missed claim, which self-heals on the next ground-truth reseed; a
    // spurious claim would silently starve the ranch.
    console.error('[broker settle] capacity claim skipped:', e?.message);
  }

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
    // The row never entered the held set, so release the slot we just claimed
    // for it — otherwise this ranch loses a slot to a status change that never
    // landed (same rollback matching/suggest does on a failed Intro Sent flip).
    if (capacityClaimed) {
      try {
        const restored = await decrementCapacity(rancherId);
        await syncCapacityToAirtable(rancherId, restored);
      } catch (rollbackErr: any) {
        console.error('[broker settle] capacity rollback failed:', rollbackErr?.message);
      }
    }
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
  // Never throws (see deliverBrokerRancherSheet); the belt is for a caller
  // refactor that breaks that promise. The money is already captured — a
  // notification problem must never surface into the webhook.
  let delivery: BrokerRancherDelivery | undefined;
  try {
    delivery = await deliverBrokerRancherSheet({
      facts,
      referralId,
      rancherId,
      nowIso,
      priorNotes: String(referral?.['Notes'] || ''),
    });
  } catch (e: any) {
    console.error('[broker settle] rancher notify unit threw:', e?.message);
  }

  // ── BUYER RECEIPT ───────────────────────────────────────────────────────
  // MUST come before the operator alert below. See raiseBrokerSheetAlert: the
  // alert can block for tens of seconds on a Telegram 429, and a timeout here
  // would strand the receipt permanently behind the idempotency anchor.
  if (facts.buyerEmail) {
    try {
      await sendBrokerBuyerReceipt(facts);
    } catch (e: any) {
      console.error('[broker settle] buyer receipt threw:', e?.message);
    }
  }

  // ── OPERATOR ALERT — only when the ranch was NOT reached ─────────────────
  if (delivery && !delivery.delivered) {
    try {
      await raiseBrokerSheetAlert({
        facts,
        referralId,
        rancherId,
        nowIso,
        priorNotes: String(referral?.['Notes'] || ''),
        delivery,
      });
    } catch (e: any) {
      console.error('[broker settle] rancher alert unit threw:', e?.message);
    }
  }

  // ── OPERATOR CARD ───────────────────────────────────────────────────────
  // `delivery` is threaded in so the card states the TRUE outcome. Ben reads
  // this card as ground truth; before this it asserted "Rancher emailed the
  // fulfillment sheet" unconditionally, which was a lie on every failed send.
  try {
    await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, buildBrokerOperatorCard(facts, delivery));
  } catch (e: any) {
    console.error('[broker settle] telegram card failed:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// THE DELIVERABLE — send the fulfillment sheet and tell the truth about it
// ---------------------------------------------------------------------------

/**
 * I/O collaborators, injectable so the delivery contract is behaviourally
 * tested without Resend/Airtable/Telegram. Production passes nothing.
 */
export interface BrokerSheetDeps {
  send: (facts: BrokerOrderFacts) => Promise<{ success?: boolean; suppressed?: boolean; reason?: string } | null | undefined>;
  stamp: (referralId: string, fields: Record<string, unknown>) => Promise<unknown>;
  alert: (input: BrokerNotifyAlert) => Promise<unknown>;
}

/**
 * Email the represented rancher his fulfillment sheet, persist whether it
 * actually landed, and ring the operator when it did not.
 *
 * WHY THIS IS LOUD. The rancher is off-platform: no dashboard, no login, no
 * Stripe. This email is his ONLY signal that a paying buyer exists. A send
 * that silently fails means the buyer paid, BHC kept the fee, and nobody told
 * the ranch — the worst failure class on the platform. Before this, a
 * suppressed/bounced/missing address was a console.error nobody would ever
 * read, while the record stamped 'Intro Sent At' and the operator card claimed
 * he had been emailed.
 *
 * CONTRACT: never throws, never rolls anything back. The deposit is already
 * captured; every path here is best-effort and returns a verdict instead.
 */
export async function deliverBrokerRancherSheet(
  args: {
    facts: BrokerOrderFacts;
    referralId: string;
    rancherId?: string;
    nowIso: string;
    priorNotes?: string;
  },
  deps: Partial<Pick<BrokerSheetDeps, 'send' | 'stamp'>> = {},
): Promise<BrokerRancherDelivery> {
  const { facts, referralId, rancherId, nowIso } = args;
  const send = deps.send || sendBrokerRancherOrder;
  const stamp = deps.stamp || ((id: string, fields: Record<string, unknown>) => updateRecord(TABLES.REFERRALS, id, fields));

  let delivery: BrokerRancherDelivery;
  if (!facts.rancherEmail) {
    console.error(`[broker settle] rancher ${rancherId || '(unknown)'} has no email — cannot deliver the order`);
    delivery = classifyBrokerRancherDelivery({ hasEmail: false });
  } else {
    try {
      const res = await send(facts);
      delivery = classifyBrokerRancherDelivery({ hasEmail: true, result: res });
    } catch (e: any) {
      delivery = classifyBrokerRancherDelivery({ hasEmail: true, error: e });
    }
    if (!delivery.delivered) {
      console.error(`[broker settle] fulfillment sheet not delivered (${delivery.outcome}): ${delivery.reason}`);
    }
  }

  // ── MONEY/COMMS TRUTH (repo rule #2) ────────────────────────────────────
  // 'Intro Sent At' is stamped ONLY on a real delivery — a suppressed or failed
  // send previously stamped it anyway, so the record asserted the rancher had
  // been told when he had not. The Notes line records the outcome either way,
  // so a human reading the referral can see what happened without Vercel logs.
  // Stamped HERE, immediately after the send, rather than being deferred with
  // the alert: this is the money-truth write, and it must land even if the
  // invocation is later killed mid-notification.
  try {
    const fields: Record<string, unknown> = {
      Notes: `${String(args.priorNotes || '')}\n${brokerSheetNote(nowIso, delivery)}`.trim(),
    };
    if (delivery.delivered) fields['Intro Sent At'] = nowIso;
    await stamp(referralId, fields);
  } catch (e: any) {
    console.error('[broker settle] rancher-delivery stamp failed:', e?.message);
  }

  return delivery;
}

/**
 * Raise the operator alert for a sheet that never reached the ranch, then
 * persist whether the ALERT ITSELF got through.
 *
 * DELIBERATELY SEPARATE FROM THE SEND, AND CALLED AFTER THE BUYER RECEIPT.
 * sendOperatorSignal awaits the Telegram wire, which sleeps up to 30s on a 429
 * (lib/telegram.ts) before trying the SMS + email fallbacks. Sitting in front
 * of the buyer receipt, that could push the invocation past the webhook's
 * maxDuration; Stripe would redeliver, markDepositSucceeded would return false
 * at the idempotency anchor, and the receipt would never be retried — a buyer
 * who paid and got no email. Alerting is the least time-critical thing here,
 * so it goes last.
 *
 * WHY THE OUTCOME IS PERSISTED: sendOperatorSignal stamps its dedupe key BEFORE
 * any wire, so an alert that Telegram rejected AND whose fallbacks failed is
 * lost outright and holds the key for the dedupe window. Nothing retries the
 * sheet and nothing re-raises. Writing `operator-alert=failed` on the referral
 * is what makes that visible afterwards (rule 2).
 *
 * CONTRACT: never throws. Returns what happened for the caller's log.
 */
export async function raiseBrokerSheetAlert(
  args: {
    facts: BrokerOrderFacts;
    referralId: string;
    rancherId?: string;
    nowIso: string;
    priorNotes?: string;
    delivery: BrokerRancherDelivery;
  },
  deps: Partial<Pick<BrokerSheetDeps, 'stamp' | 'alert'>> = {},
): Promise<{ raised: boolean; sent: boolean; reason?: string }> {
  const { facts, referralId, rancherId, nowIso, delivery } = args;
  const stamp = deps.stamp || ((id: string, fields: Record<string, unknown>) => updateRecord(TABLES.REFERRALS, id, fields));
  const alert =
    deps.alert ||
    (async (input: BrokerNotifyAlert) => {
      const { sendOperatorSignal } = await import('@/lib/operatorSignal');
      return sendOperatorSignal(input);
    });

  let sent = false;
  let reason: string | undefined;
  try {
    // Built INSIDE the try: a future field lookup added to the builder must not
    // be able to skip the alert and the outcome stamp below it.
    const signal = buildBrokerNotifyFailureAlert(facts, { referralId, rancherId, delivery });
    if (!signal) return { raised: false, sent: false };
    const res: any = await alert(signal);
    // sendOperatorSignal returns { sent, reason }. An undefined return (an
    // injected stub, a future refactor) is NOT treated as a confirmed send.
    sent = res?.sent === true;
    reason = res?.reason;
  } catch (e: any) {
    reason = e?.message || 'alert threw';
    console.error('[broker settle] rancher-undelivered signal failed:', reason);
  }

  if (!sent) {
    console.error(`[broker settle] operator alert for referral ${referralId} was NOT delivered: ${reason || 'unknown'}`);
  }

  // Append the alert outcome to the SAME note the delivery stamp wrote. The
  // prefix is rebuilt deterministically (brokerSheetNote is pure), so this
  // self-heals a delivery stamp that failed rather than depending on it.
  try {
    await stamp(referralId, {
      Notes: `${String(args.priorNotes || '')}\n${brokerSheetNote(nowIso, delivery)} · operator-alert=${
        sent ? 'sent' : `failed${reason ? ` (${reason})` : ''}`
      }`.trim(),
    });
  } catch (e: any) {
    console.error('[broker settle] operator-alert outcome stamp failed:', e?.message);
  }

  return { raised: true, sent, reason };
}
