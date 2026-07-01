// app/api/cron/final-invoice-dunning/route.ts
//
// FINAL-INVOICE DUNNING — buyer-side reminder for unpaid final balances.
//
// THE LEAK:
//   tier_v2 closes in two payments: (1) the upfront deposit (BHC's commission
//   is taken as a fee ON TOP at deposit time) and (2) the final balance the
//   buyer owes the rancher, invoiced via /api/rancher/referrals/[id]/
//   send-final-invoice. That route stamps the Referral with `Final Invoice URL`
//   (a live Stripe Connect Checkout link), `Final Invoice Sent At`, and flips
//   Status → 'Awaiting Payment'. The buyer gets ONE email (sendBuyerFinalInvoice).
//   If they don't pay, NOTHING chases them — the rancher never gets their money
//   and the deal sits in 'Awaiting Payment' forever.
//
//   Note: the existing `awaiting-payment-nudge` cron nudges the RANCHER (operator
//   Telegram card) on stale Awaiting Payment rows. This cron is the missing
//   buyer-side counterpart: it re-sends the buyer their pay link.
//
// THE DUNNER:
//   Daily. Selects Referrals where:
//     - Final Invoice Sent At is present
//     - Final Invoice URL is present (a live pay link to resend)
//     - Status = 'Awaiting Payment' (NOT Closed Won / Closed Lost / Refunded)
//     - Final Invoice Sent At > DUNNING_STUCK_DAYS ago
//     - last reminder (`Final Invoice Reminded At`) empty OR > DUNNING_INTERVAL_DAYS ago
//   For each, RE-SENDS the buyer their final invoice (same whitelisted
//   sendBuyerFinalInvoice template, same pay link) and stamps a throttle.
//   After ESCALATE_AFTER_TOUCHES reminders, also fires a Telegram card +
//   pings the rancher so a human can intervene (collect off-platform, mark
//   Closed Lost, etc).
//
// IDEMPOTENCY / SAFETY:
//   - Throttle is stamped BEFORE the send (mirrors awaiting-payment-nudge's
//     fix): if the stamp write fails we abort that record rather than risk a
//     double-send next run.
//   - We never CREATE a charge here — we only re-surface the existing pay link.
//     No double-charge surface. The Stripe Checkout Session enforces single
//     payment on its own.
//   - Closed Won / Closed Lost / Refunded are excluded so a paid/dead deal is
//     never dunned.
//
// HEAL-OR-SKIP GATE (M2 / audit C3, 2026-07-01):
//   Final-invoice PIs are DIRECT charges on the connected account. If webhook
//   settlement threw transiently, the referral stays 'Awaiting Payment' even
//   though the buyer PAID — the Status filter above can't see that, and this
//   cron would re-bill the paid buyer. So BEFORE dunning each candidate we
//   retrieve the live PI on the CONNECTED account (via the stamped
//   `Final Invoice Payment Intent ID`, or the session id recovered from
//   `Final Invoice URL` when Clover deferred the PI to pay-time):
//     • pi.status succeeded → call settleFinalInvoice (idempotent) to heal the
//       stuck referral, count `healed`, and NEVER send the reminder.
//     • payment state unknown / in flight → count `skipped_unknown`, no dun.
//     • only a retrievable, definitively-unpaid PI proceeds to dunning.
//   Retrieve + settle-idempotent only — nothing is created or charged here.

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { CRON_SECRET } from '@/lib/secrets';
import { withCronRun } from '@/lib/cronRun';
import { sendBuyerFinalInvoice, sendEmail } from '@/lib/email';
import { getStripe } from '@/lib/stripe';
import { settleFinalInvoice } from '@/lib/stripeSettlement';
import {
  finalInvoiceDunningAction,
  parseCheckoutSessionIdFromUrl,
  NO_PAYMENT_INTENT,
  type FinalInvoiceDunningAction,
} from '@/lib/finalInvoiceDunning';

export const maxDuration = 60;

const DAY_MS = 86_400_000;

// First reminder fires this many days after the invoice was originally sent.
export const DUNNING_STUCK_DAYS = Number(process.env.FINAL_INVOICE_DUNNING_STUCK_DAYS || 3);
// Minimum spacing between reminder touches.
export const DUNNING_INTERVAL_DAYS = Number(process.env.FINAL_INVOICE_DUNNING_INTERVAL_DAYS || 3);
// After this many buyer reminders, escalate to Telegram + rancher and STOP
// auto-emailing the buyer (avoid harassing — a human takes over).
export const ESCALATE_AFTER_TOUCHES = Number(process.env.FINAL_INVOICE_DUNNING_ESCALATE_AFTER || 3);
// Per-run cap so a backlog never blows past maxDuration.
const MAX_PER_RUN = Number(process.env.FINAL_INVOICE_DUNNING_MAX_PER_RUN || 25);

// Statuses that mean the final balance is settled or the deal is dead — never dun.
export const DUNNING_EXCLUDED_STATUSES: ReadonlySet<string> = new Set([
  'Closed Won',
  'Closed Lost',
  'Refunded',
]);

export interface DunningReferralLike {
  'Final Invoice Sent At'?: unknown;
  'Final Invoice URL'?: unknown;
  'Final Invoice Reminded At'?: unknown;
  'Final Invoice Reminder Count'?: unknown;
  Status?: unknown;
}

export interface DunningOptions {
  now?: number;
  stuckDays?: number;
  intervalDays?: number;
  escalateAfter?: number;
}

function toMs(v: unknown): number {
  if (!v) return 0;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Pure eligibility predicate — does this referral need a (re)dunning touch now?
 * Deliberately side-effect-free so it can be unit-tested against fixtures.
 */
export function isDunningEligible(ref: DunningReferralLike, opts: DunningOptions = {}): boolean {
  const now = opts.now ?? Date.now();
  const stuckDays = opts.stuckDays ?? DUNNING_STUCK_DAYS;
  const intervalDays = opts.intervalDays ?? DUNNING_INTERVAL_DAYS;

  // Must have an invoice sent + a live pay link to resend.
  const sentAt = toMs(ref['Final Invoice Sent At']);
  if (!sentAt) return false;
  if (!String(ref['Final Invoice URL'] || '').trim()) return false;

  // Only 'Awaiting Payment' is dunnable. Closed/Refunded are settled or dead.
  const status = String(ref.Status || '');
  if (status !== 'Awaiting Payment') return false;
  if (DUNNING_EXCLUDED_STATUSES.has(status)) return false;

  // Invoice must be aged past the first-touch window.
  if (sentAt > now - stuckDays * DAY_MS) return false;

  // Throttle: last reminder must be empty or older than the interval.
  const remindedAt = toMs(ref['Final Invoice Reminded At']);
  if (remindedAt && remindedAt > now - intervalDays * DAY_MS) return false;

  return true;
}

export function selectDunningEligible<T extends DunningReferralLike>(
  refs: T[],
  opts: DunningOptions = {},
): T[] {
  return refs.filter((r) => isDunningEligible(r, opts));
}

/** How many buyer reminders have already gone out for this referral. */
export function dunningTouchCount(ref: DunningReferralLike): number {
  const n = Number(ref['Final Invoice Reminder Count'] || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * After this run's touch, should we escalate to a human instead of (or in
 * addition to) emailing the buyer again next time? True once the buyer has
 * received >= escalateAfter reminders.
 */
export function shouldEscalateDunning(ref: DunningReferralLike, opts: DunningOptions = {}): boolean {
  const escalateAfter = opts.escalateAfter ?? ESCALATE_AFTER_TOUCHES;
  // touchCount is PRE-increment; +1 = the touch we're about to make.
  return dunningTouchCount(ref) + 1 >= escalateAfter;
}

interface DunningResult {
  status: 'success' | 'partial' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown: Record<string, number>;
}

/**
 * Resolve the LIVE Stripe payment state for a candidate referral's final
 * invoice, on the CONNECTED account (direct charge — the platform account
 * can't see it without stripeAccount).
 *
 * Resolution chain:
 *   1. `Final Invoice Payment Intent ID` (stamped by send-final-invoice when
 *      Stripe returned a PI at create time) → paymentIntents.retrieve.
 *   2. Clover async-PI fallback: that field is usually EMPTY (apiVersion
 *      '2026-02-25.clover' defers PI creation to pay-time), so recover the
 *      session id from `Final Invoice URL` and read session.payment_intent.
 *      A live session with payment_status 'unpaid' and no PI = the buyer never
 *      submitted payment → definitively dunnable (NO_PAYMENT_INTENT sentinel).
 *
 * Returns piStatus null when payment state could not be determined — the
 * caller maps that to 'skip' (never dun on unknown payment state). `pi` is the
 * full PaymentIntent object (metadata intact) so a 'heal' can feed it straight
 * to settleFinalInvoice.
 */
async function resolveFinalInvoicePi(
  ref: any,
  connectAccountId: string,
): Promise<{ pi: any | null; piStatus: string | null }> {
  const stripe = getStripe();

  const piId = String(ref['Final Invoice Payment Intent ID'] || '').trim();
  if (piId) {
    try {
      const pi: any = await stripe.paymentIntents.retrieve(piId, {
        stripeAccount: connectAccountId,
      });
      return { pi, piStatus: String(pi?.status || '') || null };
    } catch (e: any) {
      // Stale/bogus stored id → fall through to the session path below.
      // Anything else (429 / timeout / auth blip) = transient → UNKNOWN.
      if (e?.code !== 'resource_missing') return { pi: null, piStatus: null };
    }
  }

  const sessionId = parseCheckoutSessionIdFromUrl(ref['Final Invoice URL']);
  if (!sessionId) return { pi: null, piStatus: null };
  try {
    const session: any = await stripe.checkout.sessions.retrieve(
      sessionId,
      { expand: ['payment_intent'] },
      { stripeAccount: connectAccountId },
    );
    const pi: any =
      session?.payment_intent && typeof session.payment_intent === 'object'
        ? session.payment_intent
        : null;
    if (pi) return { pi, piStatus: String(pi?.status || '') || null };
    // No PI on the session. 'unpaid' = buyer never submitted payment (Clover
    // creates the PI at pay-time) → definitively dunnable. Any other
    // payment_status without a readable PI is a weird state → UNKNOWN.
    if (String(session?.payment_status || '') === 'unpaid') {
      return { pi: null, piStatus: NO_PAYMENT_INTENT };
    }
    return { pi: null, piStatus: null };
  } catch {
    return { pi: null, piStatus: null };
  }
}

async function realHandler(_request: Request): Promise<DunningResult> {
  if (isMaintenanceMode()) {
    return {
      status: 'maintenance-blocked',
      recordsTouched: 0,
      notes: 'MAINTENANCE_MODE=true',
      skipReasonBreakdown: {},
    };
  }

  const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
  const now = Date.now();
  const breakdown: Record<string, number> = {};
  const bump = (k: string) => {
    breakdown[k] = (breakdown[k] || 0) + 1;
  };

  // Pull all Awaiting Payment referrals — bounded volume (a healthy pipeline
  // drains these to Closed Won quickly; only stuck ones linger here).
  let candidates: any[] = [];
  try {
    candidates = (await getAllRecords(
      TABLES.REFERRALS,
      `{Status} = "Awaiting Payment"`,
    )) as any[];
  } catch (e: any) {
    return {
      status: 'partial',
      recordsTouched: 0,
      notes: `query failed: ${e?.message?.slice(0, 200) || 'unknown'}`,
      skipReasonBreakdown: { query_failed: 1 },
    };
  }

  const eligible = selectDunningEligible(candidates, { now });
  const targets = eligible.slice(0, MAX_PER_RUN);
  const errors: string[] = [];
  let touched = 0;
  let healed = 0;
  let skippedUnknown = 0;

  for (const ref of targets) {
    const referralId = ref.id as string;
    const buyerEmail = String(ref['Buyer Email'] || '').trim();
    if (!buyerEmail) {
      bump('buyer_email_missing');
      continue;
    }
    const checkoutUrl = String(ref['Final Invoice URL'] || '').trim();
    if (!checkoutUrl) {
      bump('pay_link_missing');
      continue;
    }

    const buyerName = String(ref['Buyer Name'] || '').trim() || 'Customer';
    const orderType = String(ref['Order Type'] || 'Beef').trim();
    const balanceAmount = Number(ref['Final Invoice Amount'] || 0);
    const totalSaleAmount = Number(ref['Total Sale Amount'] || 0);
    // deposit = total − balance when both known; otherwise leave at 0 (email
    // summary degrades gracefully).
    const depositAmount =
      totalSaleAmount > 0 && balanceAmount > 0
        ? Math.round((totalSaleAmount - balanceAmount) * 100) / 100
        : 0;

    // Resolve rancher (for ranch name in the email + escalation ping).
    const rancherIds: string[] = (ref['Rancher'] || ref['Suggested Rancher'] || []) as string[];
    const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
    let rancher: any = null;
    if (rancherId) {
      rancher = await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null);
    }
    const ranchName = String(
      rancher?.['Ranch Name'] || rancher?.['Operator Name'] || 'your rancher',
    ).trim();

    // ── HEAL-OR-SKIP GATE (M2/C3) — runs BEFORE any dunning touch ──────────
    // Retrieve the live PI on the CONNECTED account. Paid → heal + never dun.
    // Unknown/in-flight → skip (never dun on unknown payment state). Only a
    // retrievable, definitively-unpaid PI falls through to the reminder below.
    // Per-referral try/catch: one Stripe/settle failure never kills the batch.
    let dunAction: FinalInvoiceDunningAction = 'skip';
    let livePi: any = null;
    try {
      const connectAccountId = String(rancher?.['Stripe Connect Account Id'] || '').trim();
      if (connectAccountId) {
        const resolved = await resolveFinalInvoicePi(ref, connectAccountId);
        livePi = resolved.pi;
        dunAction = finalInvoiceDunningAction({ piStatus: resolved.piStatus });
      }
      // No Connect account id readable → payment state unverifiable → skip.
    } catch (e: any) {
      dunAction = 'skip';
      errors.push(`${referralId}: pi resolve (${e?.message?.slice(0, 60)})`);
    }

    if (dunAction === 'heal') {
      // Buyer already PAID — the webhook settlement was lost. Heal the stuck
      // referral (settleFinalInvoice is idempotent: no-ops on 'Closed Won')
      // and NEVER send the reminder — even if the heal write fails, the money
      // state is known-paid, so dunning is always wrong here.
      try {
        await settleFinalInvoice(livePi);
        healed++;
        bump('healed');
        try {
          if (TELEGRAM_ADMIN_CHAT_ID) {
            await sendTelegramMessage(
              TELEGRAM_ADMIN_CHAT_ID,
              `🩹 <b>Final invoice HEALED by dunning cron</b> · ref=${referralId.slice(-6)}\n\n` +
                `${buyerName} → ${ranchName} had PAID, but webhook settlement never ` +
                `landed (referral was stuck 'Awaiting Payment'). Settled now — ` +
                `check Connect webhook health if this repeats.`,
            );
          }
        } catch {}
      } catch (e: any) {
        bump('heal_failed');
        errors.push(`${referralId}: heal (${e?.message?.slice(0, 60)})`);
      }
      continue;
    }

    if (dunAction === 'skip') {
      skippedUnknown++;
      bump('skipped_unknown');
      continue;
    }
    // dunAction === 'dun' → PI retrievable + definitively unpaid. Proceed.

    const priorCount = dunningTouchCount(ref);
    const escalate = shouldEscalateDunning(ref, { now });

    // THROTTLE-FIRST: stamp the reminder time + bump the count BEFORE sending so
    // a failed stamp can't lead to a double-send on the next run.
    try {
      await updateRecord(TABLES.REFERRALS, referralId, {
        'Final Invoice Reminded At': new Date().toISOString(),
        'Final Invoice Reminder Count': priorCount + 1,
      });
    } catch (e: any) {
      bump('throttle_write_failed');
      errors.push(`${referralId}: throttle stamp (${e?.message?.slice(0, 60)})`);
      continue;
    }

    // Re-send the buyer their final invoice (whitelisted template, existing pay
    // link — NO new charge created). STOP emailing the buyer once we've hit the
    // escalation threshold (ESCALATE_AFTER_TOUCHES): from that point on a human
    // takes over via Telegram/rancher, so we never dun the buyer forever. The
    // throttle stamp above still fires every run, keeping the interval honest.
    if (!escalate) {
      try {
        await sendBuyerFinalInvoice({
          buyerEmail,
          buyerName,
          ranchName,
          orderType,
          balanceAmount,
          totalSaleAmount,
          depositAmount,
          processingDate: ref['Processing Date'] ? String(ref['Processing Date']) : undefined,
          notes: `Friendly reminder — your final balance with ${ranchName} is still open. Tap the link below to complete your order.`,
          checkoutUrl,
        });
        touched++;
        bump('buyer_reminded');
      } catch (e: any) {
        bump('buyer_email_failed');
        errors.push(`${referralId}: buyer email (${e?.message?.slice(0, 60)})`);
        // Don't continue — still attempt escalation below if warranted.
      }
    } else {
      bump('buyer_send_suppressed');
    }

    // ESCALATION — after N touches, surface to a human (Telegram) + ping the
    // rancher to chase or close out. We ping the rancher at most once (on the
    // crossing touch) to avoid spamming them every interval thereafter.
    if (escalate) {
      bump('escalated');
      const sentDays = Math.floor((now - toMs(ref['Final Invoice Sent At'])) / DAY_MS);
      try {
        if (TELEGRAM_ADMIN_CHAT_ID) {
          await sendTelegramMessage(
            TELEGRAM_ADMIN_CHAT_ID,
            `💸 <b>Final invoice unpaid ${sentDays}d</b> (touch ${priorCount + 1})\n\n` +
              `${buyerName} → ${ranchName}\n` +
              `Balance owed: $${balanceAmount.toFixed(2)}\n` +
              `Buyer has had ${priorCount + 1} reminders and still hasn't paid.\n\n` +
              `Options:\n` +
              `• Rancher collects off-platform + confirms via /rancher\n` +
              `• Mark Closed Lost if the buyer ghosted\n` +
              `• Pay link: ${checkoutUrl}`,
          );
        }
      } catch {}

      // Ping the rancher exactly once — on the touch that first crosses the
      // escalation threshold — so they know money is still outstanding. Uses
      // the generic sendEmail wrapper (subject to the 3/week cap, which is
      // correct here: a once-per-deal nudge should never override suppression).
      const justCrossed = priorCount + 1 === ESCALATE_AFTER_TOUCHES;
      if (justCrossed) {
        const rancherEmail = String(rancher?.['Email'] || '').trim();
        if (rancherEmail) {
          const rancherFirst =
            String(rancher?.['Operator Name'] || rancher?.['Ranch Name'] || 'there')
              .split(' ')[0] || 'there';
          try {
            await sendEmail({
              to: rancherEmail,
              subject: `Final balance still unpaid — ${buyerName}`,
              html:
                `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;line-height:1.6;color:#0E0E0E;background:#F4F1EC;padding:20px;">` +
                `<div style="max-width:600px;margin:0 auto;background:#fff;padding:36px;border:1px solid #A7A29A;">` +
                `<p>Hi ${rancherFirst},</p>` +
                `<p><strong>${buyerName}</strong>'s final balance of <strong>$${balanceAmount.toFixed(2)}</strong> is still unpaid ${sentDays} days after you sent the invoice. We've reminded them ${priorCount + 1} times.</p>` +
                `<p>If you've already collected it another way, log into your dashboard and mark it paid. If the buyer has gone quiet, you can close the deal out there too.</p>` +
                `<p style="text-align:center;margin:24px 0;"><a href="${SITE_URL}/rancher" style="display:inline-block;padding:14px 28px;background:#0E0E0E;color:#F4F1EC;text-decoration:none;font-weight:700;text-transform:uppercase;letter-spacing:1px;font-size:13px;">Open Dashboard &rarr;</a></p>` +
                `<p style="margin-top:28px;">— Ben</p>` +
                `</div></body></html>`,
            });
            bump('rancher_pinged');
          } catch (e: any) {
            // Non-fatal — the Telegram card already alerted the operator.
            console.warn(
              `[final-invoice-dunning] rancher ping failed for ${referralId}: ${e?.message?.slice(0, 80)}`,
            );
          }
        }
      }
    }
  }

  return {
    status: errors.length ? 'partial' : 'success',
    // A heal is a real record mutation (stuck referral → Closed Won), so it
    // counts as touched alongside buyer reminders.
    recordsTouched: touched + healed,
    notes:
      `eligible=${eligible.length} processed=${targets.length} touched=${touched} ` +
      `healed=${healed} skipped_unknown=${skippedUnknown} ` +
      `errs=${errors.length}${errors.length ? ' err1=' + errors[0].slice(0, 80) : ''}`,
    skipReasonBreakdown: breakdown,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  if (CRON_SECRET) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      const { searchParams } = new URL(request.url);
      if (searchParams.get('secret') !== CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
  }
  return withCronRun('final-invoice-dunning', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
