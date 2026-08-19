// P3-G — Orphan Stripe Checkout reaper.
//
// THE LEAK (per P2-A audit):
//   1. Buyer hits /api/checkout/deposit → recordDeposit writes Payments row
//      Status='pending' + Stripe PaymentIntent Id, redirects to Stripe-hosted
//      checkout.
//   2. Buyer abandons the Stripe page (closes tab, never enters card, gets
//      cold feet at the "$" reveal).
//   3. Stripe PaymentIntent expires after 24h default (status flips to
//      'canceled' or stays 'requires_payment_method'). No webhook fires for
//      this — silent expiration.
//   4. Our Payments row stays Status='pending' forever. Buyer Stage stays
//      UNCONVERTED, rancher capacity stays decremented (if matching ran),
//      and the intro/check-in cadence keeps emailing them as if the deal is
//      live. Funnel reports show false "deposit_initiated → ?" stalls.
//
// THE REAPER:
//   Daily 18:30 UTC (~12:30 MT — quiet window before the 17:00–18:00 close
//   cluster). Sweeps Payments rows where:
//     - Status = 'pending'
//     - Created At > 48h ago
//   For each, asks Stripe what *actually* happened:
//     - `canceled` / `requires_payment_method` → flip 'abandoned', stamp time,
//       leave Referral.Status ALONE (buyer can re-engage; orphan ≠ Lost), and
//       OPTIONALLY rewarm them via opt-in env flag.
//     - `succeeded` → webhook missed the event. Flip
//       'requires_webhook_replay' + LOUD Telegram alert. Don't silently fire
//       the success branch — that would skip audit + funnel + Telegram
//       celebration which are tightly coupled inside the webhook handler.
//       Operator manually replays the event from Stripe dashboard.
//     - `processing` / `requires_action` / `requires_confirmation` /
//       `requires_capture` → buyer is mid-flight (3DS / async ACH). Skip,
//       check again next run.
//
// SKIP REASON BREAKDOWN buckets (surface signal in Cron Runs day-over-day):
//   - stripe_pi_missing  — row has NO Stripe Payment Intent Id AND no resolvable
//                          Checkout Session id (pre-fix Clover rows / data bug).
//                          Rows with an empty PI but a stored Session id are now
//                          HEALED via checkout.sessions.retrieve → payment_intent
//                          (finding 3, 2026-07-01); nonzero here fires a Telegram
//                          alert with the manual backfill fix.
//   - rancher_missing    — Payments row has no rancher link (data bug)
//   - no_connect_acct    — rancher has no Stripe Connect Account Id (orphan platform-mode rows)
//   - stripe_404         — PI not found on Stripe (test mode / wrong account)
//   - stripe_error       — Stripe API call failed (network / rate limit)
//   - still_processing   — PI mid-flight, recheck next run
//   - abandoned_flipped  — successfully flipped to abandoned
//   - webhook_missed     — succeeded PI w/ pending row → flagged + Telegram alerted
//   - rewarm_sent        — opt-in rewarm email fired (+ dedup-stamped)
//   - rewarm_sms_sent    — opt-in rewarm SMS fired (ENABLE_SMS + TCPA opt-in)
//   - rewarm_already_sent— Rewarm Sent At stamp present, skipped (one-shot guard)
//   - rewarm_disabled    — opt-in flag off, skipped rewarm
//   - already_flipped    — row no longer pending (concurrent webhook race)

import { NextResponse } from 'next/server';
import { getAllRecords, getRecordById, updateRecord, TABLES } from '@/lib/airtable';
import { getStripe } from '@/lib/stripe';
import { isMaintenanceMode } from '@/lib/maintenance';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import { logAuditEntry } from '@/lib/auditLog';
import { sendTelegramUpdate } from '@/lib/telegram';
import { sendOrphanCheckoutRewarm } from '@/lib/email';
import { sendSMSToConsumer } from '@/lib/twilio';
import { smsEnabled } from '@/lib/smsFlag';
import {
  markDepositAbandoned,
  markDepositRequiresReplay,
  markDepositRowAbandoned,
  PAYMENTS_TABLE,
  REFERRAL_ID_TEXT_FIELD,
  CHECKOUT_SESSION_ID_FIELD,
} from '@/lib/contracts/payments';
import { settleBuyerDeposit } from '@/lib/stripeSettlement';

export const maxDuration = 60;

const DAY_MS = 86_400_000;
// Sweep window: anything older than 48h. Stripe PaymentIntents default to 24h
// before expiring; we double it so the reaper is unambiguously dealing with
// dead sessions, not mid-flight checkouts. Tunable via env if a long async
// payment method (ACH) needs a longer window in the future.
const STUCK_HOURS = Number(process.env.ORPHAN_REAPER_STUCK_HOURS || 48);
// Per-run cap so a backlog of historical pending rows doesn't blow past
// maxDuration on first deploy. At 25 rows × ~2 Stripe API calls each, this
// stays well inside the 60s budget.
const MAX_PER_RUN = Number(process.env.ORPHAN_REAPER_MAX_PER_RUN || 25);
// Opt-in via env — default OFF so the cron ships and just classifies without
// emailing the entire orphan cohort on the first run. Flip true after the
// operator has eyeballed the first run's Skip Reason Breakdown.
const REWARM_ENABLED =
  String(process.env.ORPHAN_REAPER_REWARM_ENABLED || 'false').toLowerCase() === 'true';
// Optional SMS rewarm — double-gated: ENABLE_SMS env (platform-wide SMS kill
// switch, default OFF) AND the per-consumer TCPA opt-in enforced inside
// sendSMSToConsumer. Even with REWARM_ENABLED on, SMS stays silent unless
// ENABLE_SMS is on. The email is the primary touch; SMS is belt-and-suspenders.
// F3 (2026-07-01): gate unified via lib/smsFlag ('1' | 'true' both work —
// this file used to require exactly 'true' while lib/smsEvents required '1').
const SMS_ENABLED = smsEnabled();
// Dedup stamp field on the Payments row — guarantees the rewarm fires at most
// once per orphaned checkout even if a row is somehow re-swept (defensive: the
// row is flipped to 'abandoned' in the same pass so it normally drops out of
// the pending query, but the stamp makes the one-shot guarantee explicit).
const REWARM_STAMP_FIELD = 'Rewarm Sent At';
// W1 stamp cross-check bounds (see the pass below the main loop). Lookback is
// generous vs the daily cadence — a stamp broken today is healed tomorrow;
// the window only exists so we don't re-read every settled payment forever.
const STAMP_CROSSCHECK_LOOKBACK_DAYS = Number(
  process.env.ORPHAN_REAPER_STAMP_LOOKBACK_DAYS || 30,
);
const STAMP_CROSSCHECK_MAX = Number(process.env.ORPHAN_REAPER_STAMP_MAX_PER_RUN || 50);

interface ReaperResult {
  status: 'success' | 'partial' | 'maintenance-blocked';
  recordsTouched: number;
  notes: string;
  skipReasonBreakdown: Record<string, number>;
}

async function realHandler(_request: Request): Promise<ReaperResult> {
  if (isMaintenanceMode()) {
    return {
      status: 'maintenance-blocked',
      recordsTouched: 0,
      notes: 'MAINTENANCE_MODE=true',
      skipReasonBreakdown: {},
    };
  }

  const now = Date.now();
  const stuckCutoff = now - STUCK_HOURS * 60 * 60 * 1000;

  const breakdown: Record<string, number> = {};
  const bump = (k: string) => {
    breakdown[k] = (breakdown[k] || 0) + 1;
  };

  // Pull all pending Payments rows. Volume is bounded (only orphans live in
  // this state long-term; succeeded rows immediately flip via webhook). At
  // realistic scale this is <200 rows even before reaper runs.
  let pending: any[] = [];
  try {
    pending = (await getAllRecords(
      PAYMENTS_TABLE,
      `{Status} = "pending"`,
    )) as any[];
  } catch (e: any) {
    return {
      status: 'partial',
      recordsTouched: 0,
      notes: `Payments query failed: ${e?.message?.slice(0, 200) || 'unknown'}`,
      skipReasonBreakdown: { query_failed: 1 },
    };
  }

  // Filter to rows older than the stuck cutoff. Created At is stamped at
  // recordDeposit; fall back to Airtable's _createdTime if Created At is
  // somehow blank (defensive — shouldn't happen but won't break the cron).
  const candidates = pending.filter((p: any) => {
    const createdRaw = p['Created At'] || p._createdTime;
    if (!createdRaw) return false;
    const createdMs = new Date(createdRaw).getTime();
    if (!Number.isFinite(createdMs)) return false;
    return createdMs < stuckCutoff;
  });

  // Process oldest first — they're most likely fully dead.
  candidates.sort((a: any, b: any) => {
    const aT = new Date(a['Created At'] || a._createdTime || 0).getTime();
    const bT = new Date(b['Created At'] || b._createdTime || 0).getTime();
    return aT - bT;
  });

  const targets = candidates.slice(0, MAX_PER_RUN);
  const errors: string[] = [];
  let touched = 0;

  const stripe = getStripe();

  for (const row of targets) {
    const paymentRowId = row.id as string;
    let piId = String(row['Stripe Payment Intent Id'] || '');
    // MONEY-TRUTH TAIL finding 3 (2026-07-01): Clover creates the PaymentIntent
    // at PAY time, so every checkout-created row has an EMPTY PI id until the
    // settlement webhook backfills it — a stuck row with no PI used to be
    // UNHEALABLE here (bucketed stripe_pi_missing forever). recordDeposit now
    // stores the Checkout Session id at create; when the PI is empty we resolve
    // it via checkout.sessions.retrieve below (needs the Connect account, so
    // the lookup happens after rancher resolution).
    const checkoutSessionId = String(row[CHECKOUT_SESSION_ID_FIELD] || '');
    if (!piId && !checkoutSessionId) {
      // No PI and no session id — truly unresolvable (pre-fix Clover rows).
      // Counted + alerted on after the loop.
      bump('stripe_pi_missing');
      continue;
    }

    // Resolve the rancher's Connect Account Id — required for the
    // stripeAccount header on the retrieve call (direct-charge PIs live on
    // the connected account, not the platform). If the row is missing a
    // rancher link or the rancher has no Connect Account Id, the row was
    // written in a malformed state — bucket it and continue.
    const rancherIds: string[] = (row['Rancher'] || []) as string[];
    const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
    if (!rancherId) {
      bump('rancher_missing');
      continue;
    }
    let rancher: any = null;
    try {
      rancher = await getRecordById(TABLES.RANCHERS, rancherId);
    } catch (e: any) {
      bump('rancher_missing');
      errors.push(`${paymentRowId}: rancher fetch (${e?.message?.slice(0, 80)})`);
      continue;
    }
    const connectAccountId = String(rancher?.['Stripe Connect Account Id'] || '');
    if (!connectAccountId) {
      bump('no_connect_acct');
      continue;
    }

    // Clover fallback: PI empty but we hold the Checkout Session id — ask
    // Stripe for the session (on the connected account; deposit sessions are
    // created there) and take its payment_intent.
    if (!piId) {
      let session: any;
      try {
        session = await stripe.checkout.sessions.retrieve(checkoutSessionId, {
          stripeAccount: connectAccountId,
        });
      } catch (e: any) {
        // Session unretrievable (404 / API error) → unresolvable this run.
        bump('stripe_pi_missing');
        errors.push(`${paymentRowId}: session retrieve ${e?.message?.slice(0, 60)}`);
        continue;
      }
      const sessionPi =
        typeof session?.payment_intent === 'string'
          ? session.payment_intent
          : session?.payment_intent?.id || '';
      if (sessionPi) {
        piId = sessionPi;
        // Backfill the PI onto the row so webhooks / refund lookups / future
        // reaper runs match by PI directly. Best-effort — the resolved piId
        // drives THIS run either way.
        try {
          await updateRecord(PAYMENTS_TABLE, paymentRowId, {
            'Stripe Payment Intent Id': piId,
          });
        } catch (e: any) {
          console.warn(
            `[orphan-checkout-reaper] PI backfill failed for ${paymentRowId}: ${e?.message?.slice(0, 80)}`,
          );
        }
        // fall through to the normal PI-status flow below
      } else if (String(session?.status || '') === 'expired') {
        // Session expired before the buyer paid → under Clover no PI will
        // EVER exist for this row. Certain abandonment — flip by row id
        // (markDepositAbandoned's PI lookup can't reach a PI-less row).
        try {
          const flip = await markDepositRowAbandoned(paymentRowId, {
            reason: 'clover_session_expired_no_pi',
          });
          if (flip.flipped) {
            touched++;
            bump('abandoned_flipped');
            try {
              await logAuditEntry({
                actor: 'cron',
                tool: 'orphan-checkout-reaper-abandon',
                targetType: 'Other',
                targetId: paymentRowId,
                args: { checkoutSessionId, sessionStatus: 'expired', connectAccountId },
                result: { flippedTo: 'abandoned' },
                reverseAction: {
                  type: 'noop',
                  reason: 'Stripe checkout session expired — cannot un-expire',
                },
              });
            } catch {}
          } else {
            bump('already_flipped');
          }
        } catch (e: any) {
          bump('stripe_error');
          errors.push(`${paymentRowId}: session-abandon flip failed ${e?.message?.slice(0, 60)}`);
        }
        continue;
      } else {
        // Session still open (Clover PI not created yet) — buyer could still
        // pay. Recheck next run.
        bump('still_processing');
        continue;
      }
    }

    // Retrieve PI status from Stripe (on the connected account — direct-charge
    // PIs are not visible at the platform level).
    let pi: any;
    try {
      pi = await stripe.paymentIntents.retrieve(piId, {
        stripeAccount: connectAccountId,
      });
    } catch (e: any) {
      const code = String(e?.statusCode || e?.code || '');
      if (code === '404' || code === 'resource_missing') {
        bump('stripe_404');
      } else {
        bump('stripe_error');
        errors.push(`${paymentRowId}: stripe ${code} ${e?.message?.slice(0, 60)}`);
      }
      continue;
    }

    const stripeStatus = String(pi?.status || '');

    // succeeded — the webhook missed this event (or its Airtable write failed
    // and, pre-U1, returned 200 so Stripe never retried). AUTO-HEAL: call the
    // SAME idempotent settlement the webhook runs (settleBuyerDeposit) directly,
    // so the orphaned deposit fully settles — Payments row → succeeded, referral
    // stamped Deposit Paid At, buyer + rancher notified — instead of sitting in
    // a manual-replay queue. This is safe now that settleBuyerDeposit is an
    // extracted, idempotent lib function (markDepositSucceeded no-ops if already
    // succeeded; claimOnce serializes a concurrent webhook delivery). If the
    // heal itself throws, FALL BACK to the manual-replay flag + LOUD alert so we
    // never silently lose a real money event.
    if (stripeStatus === 'succeeded') {
      try {
        await settleBuyerDeposit(pi);
        touched++;
        bump('webhook_missed_healed');
        try {
          await sendTelegramUpdate(
            `\u{2705} ORPHAN REAPER healed a missed deposit — settled pi=${piId}\n` +
            `Payments row: ${paymentRowId}\n` +
            `Rancher: ${String(rancher?.['Operator Name'] || rancher?.['Ranch Name'] || rancherId)}\n` +
            `Buyer + rancher notified. No manual replay needed.`,
          );
        } catch {}
        try {
          await logAuditEntry({
            actor: 'cron',
            tool: 'orphan-checkout-reaper-healed',
            targetType: 'Other',
            targetId: paymentRowId,
            args: { paymentIntentId: piId, stripeStatus, connectAccountId },
            result: { settled: true },
            reverseAction: {
              type: 'noop',
              reason: 'Stripe-driven deposit settlement — cannot un-charge via Airtable',
            },
          });
        } catch {}
      } catch (healErr: any) {
        // Auto-heal failed — fall back to the manual-replay flag + loud alert.
        try {
          const flip = await markDepositRequiresReplay(piId);
          if (flip.flipped) {
            touched++;
            bump('webhook_missed');
            try {
              await sendTelegramUpdate(
                `\u{1F6A8} ORPHAN REAPER found succeeded PI but AUTO-HEAL FAILED — pi=${piId}\n` +
                `Payments row: ${paymentRowId}\n` +
                `Rancher: ${String(rancher?.['Operator Name'] || rancher?.['Ranch Name'] || rancherId)}\n` +
                `Error: ${healErr?.message?.slice(0, 120) || 'unknown'}\n` +
                `Replay the payment_intent.succeeded event from Stripe dashboard, then clear Status manually.`,
              );
            } catch {}
            try {
              await logAuditEntry({
                actor: 'cron',
                tool: 'orphan-checkout-reaper-webhook-missed',
                targetType: 'Other',
                targetId: paymentRowId,
                args: { paymentIntentId: piId, stripeStatus, connectAccountId, healError: healErr?.message?.slice(0, 200) },
                result: { flippedTo: 'requires_webhook_replay' },
                reverseAction: {
                  type: 'noop',
                  reason: 'Stripe webhook replay required — manual op',
                },
              });
            } catch {}
          } else {
            // Status was no longer pending — concurrent webhook race won. Good.
            bump('already_flipped');
          }
        } catch (e: any) {
          bump('stripe_error');
          errors.push(`${paymentRowId}: heal+replay-flag failed ${e?.message?.slice(0, 60)}`);
        }
      }
      continue;
    }

    // canceled / requires_payment_method — the abandoned markers.
    // requires_payment_method is the post-checkout-expiry state in Stripe's
    // V2 hosted Checkout flow (no card was ever attached); canceled fires
    // when the buyer hits "back" or the session is explicitly canceled.
    if (stripeStatus === 'canceled' || stripeStatus === 'requires_payment_method') {
      try {
        const flip = await markDepositAbandoned(piId, { stripeStatus });
        if (!flip.flipped) {
          // Either no row found (unlikely — we just queried by row id) or
          // status was no longer pending (race with webhook or operator).
          bump('already_flipped');
          continue;
        }
        touched++;
        bump('abandoned_flipped');

        // Audit log — non-reversible (Stripe-side state is dead).
        try {
          await logAuditEntry({
            actor: 'cron',
            tool: 'orphan-checkout-reaper-abandon',
            targetType: 'Other',
            targetId: paymentRowId,
            args: { paymentIntentId: piId, stripeStatus, connectAccountId },
            result: { flippedTo: 'abandoned' },
            reverseAction: {
              type: 'noop',
              reason: 'Stripe checkout session expired — cannot un-expire',
            },
          });
        } catch {}

        // Opt-in, one-shot, dedup-stamped buyer recovery — gated by env so the
        // operator can ship the cron and eyeball the first run's classification
        // before mass-emailing. The Rewarm Sent At stamp guarantees at most one
        // recovery touch per orphaned checkout.
        if (REWARM_ENABLED) {
          if (row[REWARM_STAMP_FIELD]) {
            // Already rewarmed on a prior pass — never double-touch.
            bump('rewarm_already_sent');
          } else {
            try {
              const referralIds: string[] = (row['Referral'] || []) as string[];
              const referralId = Array.isArray(referralIds) ? referralIds[0] : null;
              const buyerIds: string[] = (row['Buyer'] || []) as string[];
              const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;
              if (referralId && buyerId) {
                const buyer: any = await getRecordById(TABLES.CONSUMERS, buyerId).catch(() => null);
                const buyerEmail = String(buyer?.['Email'] || '').trim();
                const rancherName = String(
                  rancher?.['Operator Name'] || rancher?.['Ranch Name'] || 'your rancher',
                );
                if (buyerEmail) {
                  const fullName = String(buyer?.['Full Name'] || '').trim();
                  const firstName = fullName.split(/\s+/)[0] || '';
                  await sendOrphanCheckoutRewarm({
                    firstName,
                    email: buyerEmail,
                    rancherName,
                    referralId,
                  });
                  bump('rewarm_sent');

                  // Stamp the dedup field IMMEDIATELY after a successful email so a
                  // crash before the (optional) SMS can't cause a re-email next run.
                  //
                  // CORRECTION (2026-08-18): the old comment here claimed "typecast
                  // creates it". It does not. typecast creates missing select
                  // OPTIONS, never missing FIELDS. Payments has no 'Rewarm Sent At'
                  // field, so Airtable 422s "Unknown field name" and lib/airtable.ts
                  // strips it — this stamp has never persisted. Parked in
                  // lib/schema/schemaGuardAllowlist.ts pending the field being added.
                  // Non-fatal either way: the row is already flipped to 'abandoned'
                  // so it won't be re-queried.
                  try {
                    await updateRecord(PAYMENTS_TABLE, paymentRowId, {
                      [REWARM_STAMP_FIELD]: new Date().toISOString(),
                    });
                  } catch (stampErr: any) {
                    console.warn(
                      `[orphan-checkout-reaper] rewarm stamp failed for ${paymentRowId}: ${stampErr?.message?.slice(0, 80)}`,
                    );
                  }

                  // Optional SMS — double-gated (ENABLE_SMS + per-consumer TCPA
                  // opt-in inside sendSMSToConsumer). Non-fatal on failure.
                  if (SMS_ENABLED) {
                    try {
                      const depositUrl = `${process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com'}/checkout/${referralId}/deposit`;
                      const sent = await sendSMSToConsumer({
                        consumer: buyer,
                        body:
                          `Hey${firstName ? ' ' + firstName : ''}, it's BuyHalfCow — you started checkout with ${rancherName} but didn't finish. ` +
                          `Pick up where you left off: ${depositUrl}  Reply STOP to opt out.`,
                        reason: 'orphan-checkout-rewarm',
                      });
                      if (sent) bump('rewarm_sms_sent');
                    } catch (smsErr: any) {
                      console.warn(
                        `[orphan-checkout-reaper] rewarm SMS failed for ${paymentRowId}: ${smsErr?.message?.slice(0, 80)}`,
                      );
                    }
                  }
                }
              }
            } catch (e: any) {
              // Rewarm failure is non-fatal — the row is already flipped.
              console.warn(
                `[orphan-checkout-reaper] rewarm failed for ${paymentRowId}: ${e?.message?.slice(0, 80)}`,
              );
            }
          }
        } else {
          bump('rewarm_disabled');
        }
      } catch (e: any) {
        bump('stripe_error');
        errors.push(`${paymentRowId}: abandon-flip failed ${e?.message?.slice(0, 60)}`);
      }
      continue;
    }

    // processing / requires_action / requires_confirmation / requires_capture
    // are mid-flight. Skip — the reaper sees them again tomorrow.
    bump('still_processing');
  }

  // Finding 3 alert: any row the reaper could not resolve to a PaymentIntent
  // (no PI id AND no usable Checkout Session id) is money-state we cannot see —
  // it will sit 'pending' forever without a hand. Loud once per run, with the
  // manual fix.
  if ((breakdown['stripe_pi_missing'] || 0) > 0) {
    try {
      await sendTelegramUpdate(
        `\u{26A0} ORPHAN REAPER: ${breakdown['stripe_pi_missing']} pending Payments row(s) are UNRESOLVABLE — ` +
        `no Stripe Payment Intent Id and no retrievable Checkout Session (pre-fix Clover rows or malformed writes). ` +
        `The reaper cannot heal or classify these. Manual fix: find the row in Airtable (Status=pending, empty ` +
        `'Stripe Payment Intent Id'), locate the charge/session in the rancher's Stripe account, and backfill ` +
        `'${CHECKOUT_SESSION_ID_FIELD}' or the PI id — the next run then heals it.`,
      );
    } catch {}
  }

  // ── W1 cross-check: settled money, missing referral stamp ────────────────
  // settleBuyerDeposit flips the Payments row to 'succeeded' FIRST (the
  // cross-webhook idempotency anchor) and only THEN stamps 'Deposit Paid At'
  // on the Referral — best-effort, console.warn on failure. If that stamp
  // write fails: the webhook 200s, redelivery short-circuits on the anchor,
  // this reaper's pending-scan never sees the row (it's succeeded), and
  // deposit-accept-sla keys off the missing stamp. Money settled, deal
  // frozen, silence. settleBuyerDeposit now fires a loud operator signal in
  // that catch (lib/stripeSettlement.ts); this pass is the AUTO-HEAL: any
  // succeeded Payments row whose linked Referral (via the {Referral Id Text}
  // denorm) has an EMPTY 'Deposit Paid At' gets the payment's captured
  // timestamp re-stamped. Idempotent by construction — it only ever fills an
  // empty field with the ledger truth; rows already stamped are untouched.
  // Deliberately does NOT touch Referral.Status: the deal may have been
  // hand-advanced since settlement, and the SLA/final-invoice gates key off
  // the stamp, which is the frozen part.
  let stampHealed = 0;
  try {
    const lookbackIso = new Date(
      now - STAMP_CROSSCHECK_LOOKBACK_DAYS * DAY_MS,
    ).toISOString();
    // Bounded: succeeded rows captured inside the lookback window that carry
    // the referral denorm. Rows predating {Referral Id Text} can't be joined
    // cheaply — they also predate the settle path this guards, so skip them.
    const settled = (await getAllRecords(
      PAYMENTS_TABLE,
      `AND({Status} = "succeeded", {${REFERRAL_ID_TEXT_FIELD}} != "", IS_AFTER({Captured At}, "${lookbackIso}"))`,
    )) as any[];
    for (const row of settled.slice(0, STAMP_CROSSCHECK_MAX)) {
      const referralId = String(row[REFERRAL_ID_TEXT_FIELD] || '');
      if (!referralId) continue;
      try {
        const referral: any = await getRecordById(TABLES.REFERRALS, referralId);
        if (!referral) {
          bump('stamp_referral_missing');
          continue;
        }
        if (referral['Deposit Paid At']) continue; // healthy — the common case
        // Re-run the stamp with the LEDGER's succeeded timestamp (Captured At
        // is written by markDepositSucceeded on every settle path, including
        // its schema-fallback retry). Deposit Amount mirrors the original
        // stamp (rancher-portion dollars from 'Amount Cents').
        const capturedAt = String(row['Captured At'] || row['Created At'] || '') ||
          new Date().toISOString();
        const depositCents = Number(row['Amount Cents'] || 0);
        await updateRecord(TABLES.REFERRALS, referralId, {
          'Deposit Paid At': capturedAt,
          ...(depositCents > 0 ? { 'Deposit Amount': depositCents / 100 } : {}),
        });
        touched++;
        stampHealed++;
        bump('referral_stamp_healed');
        try {
          await sendTelegramUpdate(
            `\u{1FA79} ORPHAN REAPER re-stamped a frozen deal — Payments row was succeeded but the ` +
            `Referral had NO 'Deposit Paid At' (settlement stamp write failed).\n` +
            `Referral: ${referralId}\nStamped Deposit Paid At: ${capturedAt}\n` +
            `Check Referral Status by hand — settlement's 'Awaiting Payment' flip may also have been lost.`,
          );
        } catch {}
        try {
          await logAuditEntry({
            actor: 'cron',
            tool: 'orphan-checkout-reaper-stamp-heal',
            targetType: 'Referral',
            targetId: referralId,
            args: { paymentRowId: row.id, capturedAt, depositCents },
            result: { stamped: 'Deposit Paid At' },
            reverseAction: {
              type: 'noop',
              reason: 'Re-derived from the settled Payments ledger — clearing it would re-freeze the deal',
            },
          });
        } catch {}
      } catch (e: any) {
        bump('stamp_heal_failed');
        errors.push(`stamp-heal ${referralId}: ${e?.message?.slice(0, 60) || 'unknown'}`);
      }
    }
  } catch (e: any) {
    bump('stamp_crosscheck_failed');
    errors.push(`stamp-crosscheck query: ${e?.message?.slice(0, 60) || 'unknown'}`);
  }

  return {
    status: errors.length ? 'partial' : 'success',
    recordsTouched: touched,
    notes:
      `candidates=${candidates.length} processed=${targets.length} touched=${touched} ` +
      `stampHealed=${stampHealed} ` +
      `errs=${errors.length}${errors.length ? ' err1=' + errors[0].slice(0, 80) : ''}`,
    skipReasonBreakdown: breakdown,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('orphan-checkout-reaper', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
