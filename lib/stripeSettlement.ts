// Shared settlement logic for buyer_deposit and final_invoice PaymentIntents.
//
// Both the platform webhook (app/api/webhooks/stripe/route.ts) and the Connect
// webhook (app/api/webhooks/stripe-connect/route.ts) may receive a
// payment_intent.succeeded event for the same PI — Stripe delivers to BOTH
// endpoints because the platform is the application_fee recipient AND the
// connected account owns the charge.
//
// Dual-delivery safety model:
//   buyer_deposit  — markDepositSucceeded(pi.id) is the idempotency anchor.
//                    It no-ops if Payments.Status === 'succeeded'. A repeat
//                    delivery therefore enters settleBuyerDeposit and exits at
//                    the claimOnce serializer or the row-flip check before any
//                    non-idempotent side effect (both webhooks rely on this;
//                    the Connect webhook's old outer pre-read was dropped as a
//                    duplicate of the same query — M8/E3).
//   final_invoice  — recordClose idempotency is partial (capacity-safe) but
//                    transitionBuyerStage fires on every call. The Connect
//                    webhook reads Referral.Status === 'Closed Won' BEFORE
//                    calling settleFinalInvoice so the second delivery no-ops.
//
// These functions contain the EXACT logic from the platform webhook, moved
// verbatim. Do NOT alter amounts, event names, or side-effect order.

import {
  updateRecord,
  getRecordById,
  TABLES,
} from '@/lib/airtable';

// PERMANENT vs TRANSIENT settlement failures.
//
// The webhook must RETRY (return 5xx) on a transient failure (Airtable 429 /
// timeout / Stripe blip) so a real paid deposit self-heals instead of orphaning.
// But it must NOT retry a PERMANENT failure (malformed metadata with no
// referralId/rancherId) — Stripe would pointlessly redeliver for 3 days. A
// deposit thrown for missing ids can never settle no matter how many retries,
// so we tag it and let the webhook return 200 (mark failed, manual review).
// Everything else is treated as transient → retry.
export class PermanentSettlementError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSettlementError';
  }
}

export function isPermanentSettlementError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as any).permanent === true;
}
import { sendPostPurchaseWelcome } from '@/lib/email';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { markDepositSucceeded } from '@/lib/contracts/payments';
import { claimOnce } from '@/lib/rancherCapacity';
import { recordClose } from '@/lib/contracts/rancher';
import { funnelRecord } from '@/lib/funnelMetrics';
import { fireCapi, buildUserData, closePurchaseEnabled } from '@/lib/metaCapi';
import { metaEventId } from '@/lib/analytics';
import { logAuditEntry } from '@/lib/auditLog';

// ---------------------------------------------------------------------------
// settleBuyerDeposit
//
// Extracted verbatim from the platform webhook buyer_deposit branch,
// app/api/webhooks/stripe/route.ts lines ~441-604.
// Idempotency anchor: markDepositSucceeded(pi.id) no-ops if already succeeded.
// ---------------------------------------------------------------------------
export async function settleBuyerDeposit(pi: any): Promise<void> {
  const referralId = String(pi.metadata?.referralId || '');
  const rancherId = String(pi.metadata?.rancherId || '');
  const tier = String(pi.metadata?.tier || '');
  // pi.amount is the TOTAL charged (deposit + BHC fee, post fee-on-top fix).
  // For Sale Amount / funnel LTV we want the rancher-portion only
  // (depositCents metadata stamped at session creation). Total charged
  // is used for the buyer-facing CAPI Purchase value below.
  const totalChargedCents = Number(pi.amount || 0);
  const depositCents = Number(pi.metadata?.depositCents || totalChargedCents);
  const platformFeeCents = Number(pi.metadata?.platformFeeCents || 0);
  // fullSaleCents = total sale value the rancher charges (Quarter/Half/Whole Price).
  // Used for "balance due at fulfillment" math on the rancher dashboard.
  const fullSaleCents = Number(pi.metadata?.fullSaleCents || depositCents);
  const fulfillmentBalanceCents = Number(pi.metadata?.fulfillmentBalanceCents || Math.max(0, fullSaleCents - depositCents));

  if (!referralId || !rancherId || !pi.id) {
    const metadataKeys = Object.keys(pi.metadata || {}).join(',');
    // Permanent: malformed metadata can never settle — don't make Stripe retry.
    throw new PermanentSettlementError(`buyer_deposit missing required ids — refId=${!!referralId} rancherId=${!!rancherId} piId=${!!pi.id} actualMetadataKeys=[${metadataKeys}]`);
  }

  // Flip Payments row pending → succeeded. This is the cross-webhook
  // idempotency anchor: both the platform AND Connect webhooks may deliver the
  // same PI, in either order. markDepositSucceeded returns false if the row was
  // ALREADY succeeded (a prior delivery settled it) — return now so the
  // non-idempotent side effects below (funnel/email/Telegram) don't double-fire.
  // Serialize concurrent dual-webhook deliveries for this PI. The flip-gate
  // below handles SEQUENTIAL delivery, but two SIMULTANEOUS deliveries can both
  // read 'pending' before either writes 'succeeded' and double-fire the
  // funnel/email/Telegram side effects. The atomic claim closes that window;
  // it degrades open if Redis is down (the flip-gate still protects).
  if (!(await claimOnce(`settle-deposit:${pi.id}`, 60))) return;

  // Pass the TRUE charged total (deposit + platform fee = pi.amount) so the
  // Payments row records the real charge ceiling. The refund route caps
  // net-refundable + detects full refunds against this, not the deposit-only
  // 'Amount Cents' (which would reject valid refunds of the fee portion).
  // Pass referralId so markDepositSucceeded can match the Payments row by
  // referral when its PI id is empty (Clover async-PI: the PI didn't exist at
  // checkout-create, so the row was stored without it) and backfill the PI id.
  const depositFlipped = await markDepositSucceeded(pi.id, { totalChargedCents, referralId });
  if (!depositFlipped) return;

  // S1 (2026-06-10): NRD policy — deposit pay flips Referral to
  // `Awaiting Payment`, NOT Closed Won. Rancher must tap Accept
  // Slot before the deposit becomes non-refundable. Closed Won
  // fires on the FINAL invoice settlement path above.
  // Stamps Deposit Amount + Deposit Paid At so downstream gates
  // (rancher accept, send-final-invoice) can proceed.
  try {
    await updateRecord(TABLES.REFERRALS, referralId, {
      'Status': 'Awaiting Payment',
      'Deposit Amount': depositCents / 100,
      'Deposit Paid At': new Date().toISOString(),
      'Last Buyer Activity At': new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('[stripe webhook] deposit referral stamp failed:', e?.message);
  }

  // ── Funnel event — deposit_paid (largest LTV event on platform) ──
  // P0 audit fix: brand-partner + founder flows BOTH fire funnel +
  // CAPI Purchase; buyer deposit (highest-value conversion) didn't.
  // Funnel `amount` = deposit (rancher portion) for clean LTV reporting.
  // BHC commission is tracked separately via the Payments row's
  // application_fee_amount, surfaced in revenue dashboards.
  const amountDollars = depositCents / 100;
  const totalChargedDollars = totalChargedCents / 100;
  try {
    await funnelRecord({
      stage: 'deposit_paid',
      referralId,
      rancherId,
      amount: amountDollars,
      metadata: {
        tier,
        paymentIntentId: pi.id,
      },
    });
  } catch (e: any) {
    console.warn('[stripe webhook] funnel deposit_paid record failed:', e?.message);
  }

  // E1 efficiency (m8): the post-purchase email block and the rancher-notify
  // block below both need the SAME Referral + Rancher rows — previously each
  // block fetched its own copy (4 serial Airtable reads for 2 records inside
  // the hottest webhook). Fetch once, in parallel, and reuse in both blocks.
  // Both blocks already tolerate a null row (they skip their send + warn).
  // Read AFTER the Awaiting-Payment stamp above so the rows reflect the same
  // post-stamp state both blocks always saw.
  const [referralRow, rancherRow]: any[] = await Promise.all([
    getRecordById(TABLES.REFERRALS, referralId).catch(() => null),
    getRecordById(TABLES.RANCHERS, rancherId).catch(() => null),
  ]);

  // Buyer post-purchase welcome — closes the "you bought" loop with
  // a warm BHC-branded email (cuts education preview, freezer prep,
  // pickup/delivery timeline). Mirrors the legacy quick-action(won)
  // path which fires this email on close; without this, tier_v2 buyers
  // would only get Stripe's generic receipt + the Day-14 cuts email
  // weeks later — missing the immediate confirmation moment.
  // Best-effort: failure does NOT roll back the close.
  // Also: reuse the fetched buyer below for Meta CAPI Purchase user_data.
  let buyerForCapi: { email?: string; firstName?: string; lastName?: string } = {};
  try {
    const buyerLinksForEmail: string[] = (referralRow?.['Buyer'] || []) as string[];
    const buyerIdForEmail = buyerLinksForEmail[0] || '';
    const buyer: any = buyerIdForEmail
      ? await getRecordById(TABLES.CONSUMERS, buyerIdForEmail).catch(() => null)
      : null;
    if (buyer?.['Email']) {
      const fullName = String(buyer['Full Name'] || '').trim();
      const nameParts = fullName.split(/\s+/);
      buyerForCapi = {
        email: String(buyer['Email']).toLowerCase(),
        firstName: nameParts[0] || undefined,
        lastName: nameParts.slice(1).join(' ') || undefined,
      };
      if (rancherRow) {
        await sendPostPurchaseWelcome({
          firstName: nameParts[0] || '',
          email: String(buyer['Email']),
          rancherName: String(rancherRow['Operator Name'] || rancherRow['Ranch Name'] || 'your rancher'),
          orderType: String(referralRow?.['Order Type'] || ''),
          // Deposit-path: lead with an explicit "deposit received: $X · balance ~$Y"
          // confirmation (the buyer's biggest-intent moment) instead of the
          // legacy "closing day" framing.
          depositAmount: depositCents / 100,
          balanceDue: fulfillmentBalanceCents / 100,
          // refId turns the confirmation into a handoff tool — links the buyer
          // to the preferences form (delivery/pickup + cut sheet) for the rancher.
          refId: referralId,
        });
      }
    }
  } catch (e: any) {
    console.warn('[stripe webhook] sendPostPurchaseWelcome failed:', e?.message);
  }

  // ── Meta Conversions API: server-side `InitiateCheckout` event ──────
  // Deposit is the INTENT signal (buyer committed to pay), not the
  // Closed-Won signal. Demoted from Purchase → InitiateCheckout so that
  // Purchase fires only at final_invoice (Closed Won), giving Meta a
  // clean revenue signal without double-counting. Pairs with the client
  // deposit_completed Pixel fire (also InitiateCheckout, same event_id)
  // via event_id=referralId for dedup. Fire-and-forget — never block.
  fireCapi([{
    event_name: 'InitiateCheckout',
    event_time: Math.floor(Date.now() / 1000),
    event_id: metaEventId(referralId),
    action_source: 'system_generated',
    user_data: buildUserData(buyerForCapi),
    custom_data: {
      // Buyer-paid total (deposit + BHC fee) — matches what buyer
      // sees in Stripe receipt + their bank statement.
      value: totalChargedDollars,
      currency: 'usd',
      content_name: `Beef deposit — ${tier || 'unknown'} tier`,
      content_category: 'buyer-deposit',
    },
  }]).catch((e) => console.error('[meta-capi] buyer_deposit InitiateCheckout fire failed:', e));

  // Telegram celebration to admin chat. Shows the full deal shape:
  // deposit to rancher / BHC commission / fulfillment balance still
  // owed by buyer directly to rancher.
  try {
    const feePart = platformFeeCents > 0 ? ` · BHC $${(platformFeeCents / 100).toFixed(2)}` : '';
    const balancePart = fulfillmentBalanceCents > 0
      ? ` · Balance at fulfillment $${(fulfillmentBalanceCents / 100).toFixed(2)}`
      : '';
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `💰 DEPOSIT PAID — Rancher $${(depositCents / 100).toFixed(2)}${feePart}${balancePart} · ${tier} tier · ref=${referralId.slice(-6)}\n\n` +
        `<i>NRD-7: Rancher needs to tap "Accept Slot" in dashboard to lock buyer in. Refundable until then.</i>`,
    );
  } catch (e: any) {
    console.warn('[stripe webhook] telegram deposit alert failed:', e?.message);
  }

  // ── Rancher instant-notify (email + SMS) ────────────────────────────────
  // Flawless-handoff (2026-06-27): the rancher was NEVER told a deposit landed
  // — only Ben's admin Telegram fired above, and the buyer success page falsely
  // promised the rancher had been notified "by email and text". Notify the
  // rancher now so that promise is true and they call the waiting buyer today.
  // Best-effort: each channel wraps its own try/catch inside notifyRancher; a
  // failure here must not roll back the settled deposit.
  // E1: reuses the referralRow/rancherRow fetched once above (was a second
  // pair of getRecordById reads for the exact same records).
  try {
    if (referralRow && rancherRow) {
      const { notifyRancherDepositPaid } = await import('@/lib/rancherNotify');
      const r = await notifyRancherDepositPaid(referralRow, rancherRow, { depositAmount: depositCents / 100 });
      if (!r.emailSent && !r.smsSent) {
        console.warn(`[stripe webhook] rancher deposit notify reached no channel (ref=${referralId}): ${r.skipped || 'send failed'}`);
      }
    } else {
      console.warn('[stripe webhook] rancher deposit notify skipped — referral or rancher row unreadable');
    }
  } catch (e: any) {
    console.warn('[stripe webhook] rancher deposit notify failed:', e?.message);
  }

  // H-3 audit fix: audit row on the deposit-paid webhook mutation.
  // Pre-fix the AI Audit Log only captured admin-triggered refunds —
  // buyer deposit success (highest-$$$ webhook write) was invisible.
  // Non-reversible: webhook-driven state can't be cleanly undone via
  // Airtable replay (would require Stripe-side refund).
  await logAuditEntry({
    actor: 'cron',
    tool: 'stripe-webhook-deposit-paid',
    targetType: 'Referral',
    targetId: referralId,
    args: { paymentIntentId: pi.id, tier, depositCents, platformFeeCents, totalChargedCents },
    result: { status: 'succeeded', depositDollars: depositCents / 100, totalChargedDollars, platformFeeDollars: platformFeeCents / 100 },
    reverseAction: { type: 'noop', reason: 'Stripe-driven deposit settlement — cannot un-charge via Airtable' },
  }).catch(e => console.error('[audit] deposit-paid log failed:', e));
}

// ---------------------------------------------------------------------------
// settleFinalInvoice
//
// Extracted verbatim from the platform webhook final_invoice branch,
// app/api/webhooks/stripe/route.ts lines ~332-433.
// Idempotency anchor: caller must check Referral.Status !== 'Closed Won'
// before calling (recordClose fires transitionBuyerStage on every call).
// ---------------------------------------------------------------------------
export async function settleFinalInvoice(pi: any): Promise<void> {
  const referralId = String(pi.metadata?.referralId || '');
  const rancherId = String(pi.metadata?.rancherId || '');
  const finalCents = Number(pi.amount || 0);
  if (!referralId || !rancherId || !pi.id) {
    const metadataKeys = Object.keys(pi.metadata || {}).join(',');
    // Permanent: malformed metadata can never settle — don't make Stripe retry.
    throw new PermanentSettlementError(`final_invoice missing required ids — refId=${!!referralId} rancherId=${!!rancherId} piId=${!!pi.id} actualMetadataKeys=[${metadataKeys}]`);
  }

  // Hydrate referral to compute Total Sale Amount for Closed Won.
  let referralRow: any = null;
  try {
    referralRow = await getRecordById(TABLES.REFERRALS, referralId);
  } catch (e: any) {
    console.error('[settleFinalInvoice] referral read failed:', e?.message);
  }
  // FAIL CLOSED: if we couldn't read the referral, do NOT proceed. A null row
  // makes the Closed-Won idempotency check below ('' !== 'Closed Won') pass and
  // re-runs recordClose — double-counting the funnel + re-firing side effects.
  // Throw so the webhook marks the event failed (operator-visible) rather than
  // silently double-settling on a transient read blip.
  if (!referralRow) {
    throw new Error(`settleFinalInvoice: referral ${referralId} unreadable — aborting to avoid double-settle`);
  }
  // Cross-webhook idempotency: if the referral is already Closed Won, a prior
  // delivery (platform or Connect) settled this — return so recordClose's
  // transitionBuyerStage + the Telegram/CAPI/audit below don't double-fire.
  if (String(referralRow['Status'] || '') === 'Closed Won') return;
  const totalSaleAmount = Number(referralRow?.['Total Sale Amount'] || 0);
  const depositAmount = Number(referralRow?.['Deposit Amount'] || 0);
  const finalAmount = finalCents / 100;
  // Sale amount on Referral = total (deposit + final). Falls back to
  // deposit + finalAmount if Total Sale Amount not stamped at invoice time.
  const closeSaleAmount = totalSaleAmount > 0 ? totalSaleAmount : (depositAmount + finalAmount);

  // Stamp Final Paid At + amount on the referral.
  try {
    await updateRecord(TABLES.REFERRALS, referralId, {
      'Final Paid At': new Date().toISOString(),
      'Final Paid Amount': finalAmount,
    });
  } catch (e: any) {
    console.warn('[stripe webhook] final_invoice referral stamp failed:', e?.message);
  }

  // Closed Won transition. recordClose handles status flip, capacity
  // decrement (idempotent if already Closed Won), and Buyer Stage flip.
  // saleAmount is the FULL sale (deposit + balance) so monthly stats +
  // affiliate enrollment payout calculations work correctly.
  await recordClose({
    referralId,
    rancherId,
    outcome: 'won',
    saleAmount: closeSaleAmount,
  });

  // ── Meta Conversions API: server-side `Purchase` event (Closed Won) ─
  // LEGACY fire — only when the attributed close Purchase is NOT enabled.
  // When META_CLOSE_PURCHASE_ENABLED='true', recordClose() (invoked just above)
  // owns the single Purchase for this close, with a real fbc + action_source
  // 'website'. Firing here too would double-count on the same event_id (only
  // saved by Meta's idempotency window), so we suppress it. This branch is the
  // unattributed (system_generated, no fbc) fallback for the flag-off state.
  // Fire-and-forget — never block the webhook response.
  if (!closePurchaseEnabled()) (async () => {
    try {
      const buyerLinks: string[] = (referralRow?.['Buyer'] || []) as string[];
      const buyerId = buyerLinks[0] || '';
      const closedWonBuyer: any = buyerId
        ? await getRecordById(TABLES.CONSUMERS, buyerId).catch(() => null)
        : null;
      if (closedWonBuyer?.['Email']) {
        const fullName = String(closedWonBuyer['Full Name'] || '').trim();
        const nameParts = fullName.split(/\s+/);
        const closedWonState = String(closedWonBuyer['State'] || '');
        fireCapi([{
          event_name: 'Purchase',
          event_time: Math.floor(Date.now() / 1000),
          event_id: metaEventId(referralId),
          action_source: 'system_generated',
          user_data: buildUserData({
            email: String(closedWonBuyer['Email']).toLowerCase(),
            firstName: nameParts[0] || undefined,
            lastName: nameParts.slice(1).join(' ') || undefined,
            state: closedWonState || undefined,
          }),
          custom_data: {
            value: closeSaleAmount,
            currency: 'usd',
            content_name: 'Beef — full sale',
            content_category: 'closed-won',
          },
        }]).catch((e) => console.error('[meta-capi] closed-won Purchase fire failed:', e));
      }
    } catch (e) {
      console.error('[meta-capi] closed-won Purchase buyer fetch failed:', e);
    }
  })();

  try {
    await sendTelegramMessage(
      TELEGRAM_ADMIN_CHAT_ID,
      `🎯 FINAL INVOICE PAID — $${finalAmount.toFixed(2)} · total sale $${closeSaleAmount.toFixed(2)} · ref=${referralId.slice(-6)} · BHC fee $0 (collected at deposit)`,
    );
  } catch {}

  await logAuditEntry({
    actor: 'cron',
    tool: 'stripe-webhook-final-invoice-paid',
    targetType: 'Referral',
    targetId: referralId,
    args: { paymentIntentId: pi.id, finalCents, totalSaleAmount: closeSaleAmount },
    result: { status: 'closed_won', finalDollars: finalAmount, totalDollars: closeSaleAmount },
    reverseAction: { type: 'noop', reason: 'Stripe-driven final invoice settlement' },
  }).catch(e => console.error('[audit] final-invoice-paid log failed:', e));
}
