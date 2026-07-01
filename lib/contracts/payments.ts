// Stripe Connect Express — platform takes 100% deposit, holds it, pays rancher
// 90% on fulfillment confirm, retains 10% as commission + monthly platform fee.
//
// Two Airtable tables back this contract:
//   - Payments: every deposit attempt (pending/succeeded/refunded/failed)
//   - Payouts:  every release to a rancher's connected account
// Idempotency is keyed on Stripe Payment Intent ID + Stripe Transfer ID so
// webhook retries never double-process.

import { createRecord, updateRecord, getAllRecords, getRecordById, TABLES } from '@/lib/airtable';
import { decrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import { logAuditEntry } from '@/lib/auditLog';
import { sendTelegramUpdate } from '@/lib/telegram';
import { refundReferralClearFields } from '@/lib/refundLifecycle';

export type PaymentStatus = 'pending' | 'succeeded' | 'refunded' | 'failed' | 'abandoned' | 'requires_webhook_replay';
export type PayoutStatus = 'pending' | 'paid' | 'failed';

export const PAYMENTS_TABLE = 'Payments';
export const PAYOUTS_TABLE = 'Payouts';

export interface CreateDepositInput {
  referralId: string;
  buyerId: string;
  rancherId: string;
  tier: 'Pasture' | 'Ranch' | 'Operator' | 'Legacy Connect';  // tier_v2 + hybrid (legacy_connect)
  amountCents: number;
  platformFeeCents: number;  // NEW — BHC's cut of the deposit
  stripePaymentIntentId: string;
}

/**
 * Pure dedup decision for recordDeposit. Given the candidate Payments rows
 * returned by the by-PI-or-by-referral lookup and the live PaymentIntent id,
 * decide which (if any) existing row may be reused. Extracted as a pure function
 * so the money-loss guards can be unit-tested without mocking Airtable.
 *
 * Reuse ONLY a row that is BOTH:
 *   - Status === 'pending' (excludes 'requires_webhook_replay' — a row the
 *     orphan-reaper flagged after seeing a SUCCEEDED PI that never settled; real
 *     money awaiting manual replay, recycling it masks an unreconciled charge),
 *     AND every terminal status (succeeded/refunded/abandoned/failed).
 *   - Stripe Payment Intent Id === the live PI (exact match). A pending row for
 *     the SAME referral but a DIFFERENT PI is a genuinely new live PI
 *     (quarter→half re-quote → new idempotencyKey → new PI). Overwriting its PI
 *     would orphan the older PI on completion. Caller creates a new row instead.
 *
 * Returns the reusable row, or null when the caller should create a new row.
 */
export function selectReusablePaymentRow(
  candidates: Array<{ id: string; [k: string]: any }>,
  stripePaymentIntentId: string,
): { id: string; [k: string]: any } | null {
  return (
    candidates.find(
      (r) =>
        r['Status'] === 'pending' &&
        r['Stripe Payment Intent Id'] === stripePaymentIntentId,
    ) ?? null
  );
}

/**
 * Pure settlement-row selector for markDepositSucceeded (Clover async-PI).
 *
 * On apiVersion 2026-02-25.clover the PaymentIntent is created when the buyer
 * PAYS, not at checkout-create — so the Payments row was written with an EMPTY
 * 'Stripe Payment Intent Id'. The webhook later knows the real PI id + the
 * referral (pi.metadata.referralId). Settlement matching:
 *   1. Prefer the row matched by the real PI id (pre-Clover behavior / repeat
 *      delivery after a prior backfill) — settle it, no backfill needed.
 *   2. Else fall back to the still-pending row for the referral and signal a
 *      PI-id backfill so the ledger + future-delivery dedupe work.
 *   3. Else nothing to settle (return null → caller treats as non-duplicate).
 * `backfillPi` is true ONLY on the referral-fallback path.
 */
export function selectSettlementRow(
  piMatched: Array<{ id: string; [k: string]: any }>,
  referralPending: Array<{ id: string; [k: string]: any }>,
): { row: { id: string; [k: string]: any } | null; backfillPi: boolean } {
  if (piMatched.length > 0) return { row: piMatched[0], backfillPi: false };
  if (referralPending.length > 0) return { row: referralPending[0], backfillPi: true };
  return { row: null, backfillPi: false };
}

export async function recordDeposit(input: CreateDepositInput): Promise<{ id: string }> {
  const fields = {
    'Referral': [input.referralId],
    'Buyer': [input.buyerId],
    'Rancher': [input.rancherId],
    'Tier': input.tier,
    'Amount Cents': input.amountCents,
    'Platform Fee Cents': input.platformFeeCents,
    'Stripe Payment Intent Id': input.stripePaymentIntentId,
    'Status': 'pending',
    'Created At': new Date().toISOString(),
  };

  // De-dupe pending ledger rows. A concurrent double-POST to the deposit route
  // (back button, double-click, retried fetch) creates two Checkout Sessions
  // and called this unconditionally → two 'pending' Payments rows. Stripe
  // dedups the actual charge by PaymentIntent, so this is NOT a double-charge,
  // but the duplicate ledger rows confuse refund/abandon/replay lookups (each
  // queries by PI and takes existing[0]).
  //
  // Reuse an existing pending row ONLY on an EXACT PaymentIntent match (the
  // common retry — same Checkout Session re-submitted via back button, double-
  // click, or retried fetch). Re-stamp it with the latest charge details so the
  // row tracks the live Session. Best-effort: a lookup failure falls through to
  // create (the orphan-prevention path in the deposit route still gates on the
  // create succeeding).
  //
  // CRITICAL — never reuse a pending row that belongs to a DIFFERENT PI, even
  // when it's for the same referral. Two checkout sessions for one referral can
  // carry DIFFERENT PaymentIntents (e.g. quarter→half cow re-quote → different
  // idempotencyKey at stripeConnect.ts → new PI). Overwriting old→new PI would
  // orphan the older PI: completing that older session calls
  // markDepositSucceeded(oldPI), which finds NO row → silent orphan deposit
  // (money in the rancher Connect acct, no settle, no email). For a different
  // PI we leave the existing row alone and CREATE A NEW row so every live PI
  // has its own settle-able row.
  try {
    const piEscaped = input.stripePaymentIntentId.replace(/"/g, '\\"');
    const refEscaped = input.referralId.replace(/"/g, '\\"');
    // Match by PI (the same-session resubmit) OR by a still-pending row for this
    // referral. The referral clause only WIDENS the candidate set so we can see
    // an in-flight row — the reuse decision below still requires an exact PI
    // match. SEARCH over ARRAYJOIN({Referral}) is the established
    // Payments-by-referral pattern in this repo (see
    // app/api/rancher/fulfillment/confirm/route.ts) — the Referral link's
    // primary value is the record ID, unlike {Rancher} which emits names (the
    // capacity-drift gotcha) and would silently never match.
    const existing: any[] = await getAllRecords(
      PAYMENTS_TABLE,
      `OR({Stripe Payment Intent Id} = "${piEscaped}", AND(SEARCH("${refEscaped}", ARRAYJOIN({Referral})), {Status} = "pending"))`,
    );
    // Reuse ONLY a Status==='pending' row whose PI is exactly this PI (see
    // selectReusablePaymentRow): excludes 'requires_webhook_replay' (masks an
    // unreconciled charge) and any different-PI-same-referral row (would orphan
    // the older PI on completion → create a new row instead).
    const reusable = selectReusablePaymentRow(existing, input.stripePaymentIntentId);
    if (reusable) {
      await updateRecord(PAYMENTS_TABLE, reusable.id, {
        'Tier': input.tier,
        'Amount Cents': input.amountCents,
        'Platform Fee Cents': input.platformFeeCents,
        'Stripe Payment Intent Id': input.stripePaymentIntentId,
        'Status': 'pending',
      });
      return { id: reusable.id };
    }
  } catch (e: any) {
    console.warn('[recordDeposit] dedup lookup failed — creating new row:', e?.message);
  }

  const created: any = await createRecord(PAYMENTS_TABLE, fields);
  return { id: created.id };
}

// Returns true if this call flipped the row to succeeded (or there is no row to
// flip — not a duplicate); false if the row was ALREADY succeeded (a repeat
// delivery). Callers use the false return as a cross-webhook idempotency guard
// to skip non-idempotent side effects (funnel/email/Telegram) on the second
// delivery of the same PaymentIntent. Backward-compatible: callers that ignore
// the return value keep working.
export async function markDepositSucceeded(
  stripePaymentIntentId: string,
  opts: { totalChargedCents?: number; referralId?: string } = {},
): Promise<boolean> {
  const escaped = stripePaymentIntentId.replace(/"/g, '\\"');
  const piMatched: any[] = await getAllRecords(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`
  );
  // CLOVER async-PI fallback: under apiVersion 2026-02-25 the PaymentIntent
  // doesn't exist at checkout-create, so recordDeposit stored the row with an
  // EMPTY 'Stripe Payment Intent Id'. By the payment_intent.succeeded webhook
  // we know both the real PI id AND the referral (pi.metadata.referralId). When
  // no row matches the PI id, fall back to the still-pending row for that
  // referral and backfill the PI id so the ledger settles + repeat deliveries
  // dedupe by PI. Decision extracted to selectSettlementRow (pure, tested).
  let referralPending: any[] = [];
  if (piMatched.length === 0 && opts.referralId) {
    const refEscaped = String(opts.referralId).replace(/"/g, '\\"');
    referralPending = await getAllRecords(
      PAYMENTS_TABLE,
      `AND(SEARCH("${refEscaped}", ARRAYJOIN({Referral})), {Status} = "pending")`,
    );
  }
  const { row: payment, backfillPi } = selectSettlementRow(piMatched, referralPending);
  if (!payment) return true;
  // Idempotency: already-succeeded payments are a no-op on webhook retry.
  if (payment['Status'] === 'succeeded') return false;

  // Persist the TRUE charged total (deposit + platform fee, from pi.amount).
  // 'Amount Cents' only stores the deposit portion, so refund-cap math that
  // bases its ceiling on Amount Cents under-counts the real charge and rejects
  // valid refunds / mis-detects full refunds. Stamping the settlement amount
  // gives the refund route an authoritative cap. Best-effort: a schema without
  // the field must not block the (critical) Status flip.
  const fields: Record<string, any> = {
    'Status': 'succeeded',
    'Captured At': new Date().toISOString(),
  };
  // Backfill the real PI id onto the referral-matched row (Clover async-PI) so
  // refund/abandon lookups + repeat-delivery dedup find it by PI from now on.
  if (backfillPi) {
    fields['Stripe Payment Intent Id'] = stripePaymentIntentId;
  }
  if (typeof opts.totalChargedCents === 'number' && opts.totalChargedCents > 0) {
    fields['Total Charged Cents'] = Math.round(opts.totalChargedCents);
  }
  try {
    await updateRecord(PAYMENTS_TABLE, payment.id, fields);
  } catch (e: any) {
    console.warn('[markDepositSucceeded] schema fallback (retrying without Total Charged Cents):', e?.message);
    const retry: Record<string, any> = {
      'Status': 'succeeded',
      'Captured At': new Date().toISOString(),
    };
    if (backfillPi) retry['Stripe Payment Intent Id'] = stripePaymentIntentId;
    await updateRecord(PAYMENTS_TABLE, payment.id, retry);
  }
  return true;
}

/**
 * Orphan-reaper contract: flip a pending Payments row to 'abandoned' when the
 * Stripe PaymentIntent has expired (canceled / requires_payment_method) without
 * the buyer ever completing checkout. Idempotent — re-running on an already-
 * abandoned row is a no-op so the cron is safe to run on overlap.
 *
 * Deliberately DOES NOT touch the linked Referral.Status. Orphan ≠ Lost — the
 * buyer can still re-engage later (different rancher, new deposit). Setting
 * the row to abandoned just stops the funnel from treating this PaymentIntent
 * as "still alive" indefinitely.
 *
 * Returns { found: false } if no Payments row matches the PI (defensive — the
 * caller should have already filtered to pending rows, but webhook races could
 * produce a mismatched row).
 */
export async function markDepositAbandoned(
  stripePaymentIntentId: string,
  opts: { stripeStatus?: string } = {},
): Promise<{ found: boolean; flipped: boolean }> {
  const escaped = stripePaymentIntentId.replace(/"/g, '\\"');
  const existing: any[] = await getAllRecords(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`,
  );
  if (existing.length === 0) return { found: false, flipped: false };
  const payment = existing[0];
  // Idempotency: any non-pending row is a no-op. We only flip pending → abandoned
  // so a succeeded row never gets downgraded by a delayed cron pass.
  if (payment['Status'] !== 'pending') return { found: true, flipped: false };

  const fields: Record<string, any> = {
    'Status': 'abandoned',
    'Abandoned At': new Date().toISOString(),
  };
  if (opts.stripeStatus) fields['Abandoned Reason'] = `stripe_status=${opts.stripeStatus}`;

  try {
    await updateRecord(PAYMENTS_TABLE, payment.id, fields);
  } catch (e: any) {
    // Schema fallback — Abandoned At + Abandoned Reason may not exist yet in
    // older Airtable schemas. Retry with just Status so the cron still
    // makes forward progress. createRecord/updateRecord typecast will create
    // the 'abandoned' singleSelect option on first hit.
    console.warn('[markDepositAbandoned] schema fallback (retrying with Status only):', e?.message);
    await updateRecord(PAYMENTS_TABLE, payment.id, { 'Status': 'abandoned' });
  }
  return { found: true, flipped: true };
}

/**
 * Orphan-reaper escalation contract: when the cron retrieves a PaymentIntent
 * that is `succeeded` but the local Payments row is still pending, the webhook
 * missed an event. Flag the row 'requires_webhook_replay' so the operator can
 * manually replay/repair it — DO NOT silently fire the success branch (that
 * would skip audit + funnel + Telegram celebration which are tightly coupled
 * to the webhook handler). Loud Telegram alert is fired by the caller.
 *
 * Idempotent — re-running on an already-flagged row is a no-op.
 */
export async function markDepositRequiresReplay(
  stripePaymentIntentId: string,
): Promise<{ found: boolean; flipped: boolean }> {
  const escaped = stripePaymentIntentId.replace(/"/g, '\\"');
  const existing: any[] = await getAllRecords(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`,
  );
  if (existing.length === 0) return { found: false, flipped: false };
  const payment = existing[0];
  if (payment['Status'] !== 'pending') return { found: true, flipped: false };

  try {
    await updateRecord(PAYMENTS_TABLE, payment.id, {
      'Status': 'requires_webhook_replay',
      'Abandoned At': new Date().toISOString(),
      'Abandoned Reason': 'webhook_missed_succeeded',
    });
  } catch (e: any) {
    console.warn('[markDepositRequiresReplay] schema fallback (Status only):', e?.message);
    await updateRecord(PAYMENTS_TABLE, payment.id, { 'Status': 'requires_webhook_replay' });
  }
  return { found: true, flipped: true };
}

export interface MarkDepositRefundedOpts {
  reason?: string;
  refundedAmountCents?: number; // partial refund support — P0 audit fix (C-6)
  // Partial flag — if true, Payments row keeps Status='succeeded' so a follow-up
  // refund can still target it. Default false (full refund flips to 'refunded').
  partial?: boolean;
}

export async function markDepositRefunded(
  stripePaymentIntentId: string,
  opts: MarkDepositRefundedOpts = {},
): Promise<{ flipped: boolean }> {
  const escaped = stripePaymentIntentId.replace(/"/g, '\\"');
  const existing: any[] = await getAllRecords(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`
  );
  if (existing.length === 0) return { flipped: false };
  const payment = existing[0];

  // FULL-refund detection — the gate that decides whether to NUKE the whole
  // Closed Won deal (restoreReferralAfterRefund). A FULL refund requires BOTH:
  //   (a) the caller didn't flag it partial, AND
  //   (b) when amounts are known, the refund covers the captured deposit.
  // Belt-and-suspenders: a Stripe-Dashboard partial refund hits the webhook
  // directly with NO partial flag — without the amount check it would wrongly
  // restore (reverting Status/Sale/Commission + capacity) on a $1 refund.
  // Base the full-refund test on the TRUE charged total (deposit + platform
  // fee), captured as 'Total Charged Cents' at settlement. 'Amount Cents' is
  // the deposit only — using it would treat a refund of just the deposit as
  // "full" while the fee portion remains uncaptured-as-refunded, wrongly
  // nuking the Closed Won deal. Fallbacks for older rows: deposit + fee, then
  // deposit alone.
  const depositCents = Number(payment['Amount Cents'] || 0);
  const platformFeeCents = Number(payment['Platform Fee Cents'] || 0);
  const totalChargedCents = Number(payment['Total Charged Cents'] || 0);
  const capturedCents =
    totalChargedCents > 0
      ? totalChargedCents
      : (depositCents + platformFeeCents) || depositCents;
  const refundedCents = Number(opts.refundedAmountCents ?? 0);
  const isFullRefund = !opts.partial && (capturedCents <= 0 || refundedCents <= 0 || refundedCents >= capturedCents);

  // Idempotently no-op on re-call for full refunds.
  if (isFullRefund && payment['Status'] === 'refunded') return { flipped: false };

  // Best-effort field writes — Refund Reason + Refunded Amount Cents may not
  // exist in older Airtable schemas. Catch the typed-field error and retry
  // without them.
  const fields: Record<string, any> = {
    'Refunded At': new Date().toISOString(),
  };
  if (isFullRefund) fields['Status'] = 'refunded';
  if (opts.reason) fields['Refund Reason'] = opts.reason;
  if (typeof opts.refundedAmountCents === 'number') {
    fields['Refunded Amount Cents'] = opts.refundedAmountCents;
  }

  try {
    await updateRecord(PAYMENTS_TABLE, payment.id, fields);
  } catch (e: any) {
    // Fallback: strip the new fields and retry. Old Airtable schemas without
    // Refund Reason / Refunded Amount Cents will reject those keys outright.
    console.warn('[markDepositRefunded] schema fallback (retrying without new fields):', e?.message);
    const fallback: Record<string, any> = { 'Refunded At': fields['Refunded At'] };
    if (isFullRefund) fallback['Status'] = 'refunded';
    await updateRecord(PAYMENTS_TABLE, payment.id, fallback);
  }

  // P2-A audit fix: full-refund post-flip restore.
  //
  // Pre-fix, markDepositRefunded only stamped the Payments row. The linked
  // Referral stayed Closed Won → buyer permanently showed as converted →
  // affiliate auto-enroll fired, monthly backer letters went out, repeat-
  // purchase cron emailed the buyer. Money back, funnel says "won". Disaster.
  //
  // On any FULL (non-partial) refund of a buyer-deposit Payments row whose
  // Referral was Closed Won, revert the deal:
  //   - Referral.Status → 'Refunded' (new option, typecast-created)
  //   - Clear Closed At, Sale Amount, Commission Due, Commission Status
  //   - Stamp Refunded At
  //   - Decrement rancher capacity (the deal reverts; slot opens back up)
  //   - Buyer → Buyer Stage='READY', Buyer Health='Active', Sequence Stage=''
  //   - Audit-log the restore
  //   - Telegram-alert the operator (no buyer email storm)
  //
  // Partial refunds skip the restore — the deal is still "won" with reduced
  // sale amount. Operator can manually convert to full refund if desired.
  //
  // Idempotency: the early-return on Status==='refunded' above already
  // prevents double-restore. We also guard on Referral.Status==='Closed Won'
  // so re-running against an already-restored Referral is a no-op.
  if (isFullRefund) {
    try {
      await restoreReferralAfterRefund(payment, stripePaymentIntentId);
    } catch (e: any) {
      // Restore failure is non-fatal — the Payments row already flipped,
      // operator gets a Telegram alert via the catch path.
      console.error('[markDepositRefunded] restore-referral failed (non-fatal):', e?.message || e);
      try {
        await sendTelegramUpdate(
          `WARN DEPOSIT REFUNDED — Payments row flipped but Referral restore failed. PI ${stripePaymentIntentId.slice(-8)}. Error: ${e?.message || e}. Manual cleanup required.`,
        );
      } catch {}
    }
  }

  return { flipped: true };
}

/**
 * Revert the buyer-side / rancher-side funnel state after a full deposit
 * refund. Called from markDepositRefunded — separated for readability and so
 * the catch can isolate restore failures from the Payments-row write.
 *
 * Idempotent: re-running against an already-Refunded Referral is a no-op
 * (early-return on Status check). Webhook retries safe.
 */
async function restoreReferralAfterRefund(
  payment: any,
  stripePaymentIntentId: string,
): Promise<void> {
  // Pull linked Referral id from the Payments row. Linked-record fields are
  // always returned as arrays of record IDs.
  const referralIds: string[] = (payment['Referral'] || []) as string[];
  const referralId = Array.isArray(referralIds) ? referralIds[0] : null;
  if (!referralId) {
    console.warn('[restoreReferralAfterRefund] no Referral linked on Payments row', payment.id);
    return;
  }

  const referral: any = await getRecordById(TABLES.REFERRALS, referralId);
  if (!referral) {
    console.warn('[restoreReferralAfterRefund] Referral not found', referralId);
    return;
  }

  const currentStatus = String(referral['Status'] || '');
  // Idempotency: only restore from a Closed Won state. If the Referral was
  // already flipped to Refunded (re-run), or never reached Closed Won (refund
  // before close), skip the buyer/rancher restore — operator handles edge cases.
  if (currentStatus === 'Refunded') {
    console.log('[restoreReferralAfterRefund] Referral already Refunded, no-op', referralId);
    return;
  }
  if (currentStatus !== 'Closed Won') {
    console.warn(
      `[restoreReferralAfterRefund] Referral ${referralId} status=${currentStatus} (not Closed Won) — skipping restore. Operator should review.`,
    );
    return;
  }

  const now = new Date().toISOString();
  const rancherIds: string[] = (referral['Rancher'] || []) as string[];
  const rancherId = Array.isArray(rancherIds) ? rancherIds[0] : null;
  const buyerIds: string[] = (referral['Buyer'] || []) as string[];
  const buyerId = Array.isArray(buyerIds) ? buyerIds[0] : null;

  // 1. Flip Referral state. Clear Closed Won-only fields PLUS the deposit/
  // accept lifecycle stamps (C2: stale Deposit Paid At let send-final-invoice
  // bill a refunded buyer; stale Rancher Accepted At blocked re-deposit).
  // Field set is pure + unit-tested in lib/refundLifecycle.test.ts. typecast
  // creates the 'Refunded' singleSelect option if it doesn't exist yet.
  const referralUpdates: Record<string, any> = refundReferralClearFields(now);
  try {
    await updateRecord(TABLES.REFERRALS, referralId, referralUpdates);
  } catch (e: any) {
    // Schema fallback: Refunded At on Referral may not exist yet. Retry
    // without it — the Refunded At on the Payments row is the primary audit.
    console.warn('[restoreReferralAfterRefund] Referral update fallback:', e?.message);
    const fallback = { ...referralUpdates };
    delete fallback['Refunded At'];
    await updateRecord(TABLES.REFERRALS, referralId, fallback);
  }

  // 2. Decrement rancher capacity — one count back since the deal reverts.
  // Best-effort: capacity drift on a rare refund is a non-fatal warning.
  if (rancherId) {
    try {
      const newCount = await decrementCapacity(rancherId);
      await syncCapacityToAirtable(rancherId, newCount);
    } catch (capErr: any) {
      console.warn('[restoreReferralAfterRefund] capacity decrement failed:', capErr?.message);
    }
  }

  // 3. Restore buyer to the routing pool. Sequence Stage clear stops the
  // post-purchase email sequence + repeat-purchase cron from firing.
  if (buyerId) {
    try {
      await updateRecord(TABLES.CONSUMERS, buyerId, {
        'Buyer Stage': 'READY',
        'Buyer Stage Updated At': now,
        'Buyer Health': 'Active',
        'Sequence Stage': '',
        'Ready to Buy': true,
      });
    } catch (e: any) {
      console.warn('[restoreReferralAfterRefund] Consumer restore failed:', e?.message);
    }
  }

  // 4. Audit log. typecast widens the Actor singleSelect to accept 'system'
  // if it doesn't already exist. We cast through unknown because the existing
  // AuditActor union doesn't yet include 'system' — refund-restore is a
  // brand-new actor type and we don't want to ripple the type across every
  // existing audit call site.
  try {
    await logAuditEntry({
      actor: 'system' as unknown as 'cron',
      tool: 'stripe-refund-restore',
      targetType: 'Referral',
      targetId: referralId,
      args: {
        paymentIntentId: stripePaymentIntentId,
        referralId,
        rancherId,
        buyerId,
        previousStatus: currentStatus,
      },
      result: {
        referralStatus: 'Refunded',
        capacityDecremented: !!rancherId,
        buyerRestored: !!buyerId,
      },
      reverseAction: { type: 'noop', reason: 'Stripe-driven refund — cannot un-refund via Airtable' },
    });
  } catch (e: any) {
    console.warn('[restoreReferralAfterRefund] audit log failed:', e?.message);
  }

  // 5. Telegram alert — operator decides next step. NO buyer email storm.
  try {
    await sendTelegramUpdate(
      `🔁 DEPOSIT REFUNDED — Referral reverted, buyer back in routing pool: ref=${referralId}`,
    );
  } catch (e: any) {
    console.warn('[restoreReferralAfterRefund] Telegram alert failed:', e?.message);
  }
}

export interface MarkDepositDisputedInput {
  stripePaymentIntentId: string;
  disputeStatus: string;          // Stripe dispute.status (warning_needs_response, needs_response, under_review, lost, won, etc)
  disputeAmountCents?: number;    // dispute.amount
  disputeReason?: string;         // dispute.reason (fraudulent, product_not_received, etc)
}

/**
 * Stripe dispute mutation contract. Wraps the Payments row dispute write so
 * stripe + stripe-connect webhook handlers share a single surface. Pre-H4 the
 * webhook handlers called updateRecord(PAYMENTS_TABLE, ...) directly — the
 * boundary check tolerated it (it's the same table) but the inconsistency
 * meant any future schema change (e.g. dispute-side audit field) had to be
 * patched in two webhook files instead of one contract.
 *
 * Returns { found: false } when no Payments row matches the PI (founder
 * lifetime + brand listing disputes don't write here — handler still fires
 * its own Telegram + audit).
 */
export async function markDepositDisputed(
  input: MarkDepositDisputedInput,
): Promise<{ found: boolean; recordId?: string }> {
  const escaped = input.stripePaymentIntentId.replace(/"/g, '\\"');
  const rows: any[] = await getAllRecords(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`,
  );
  if (rows.length === 0) {
    console.warn(`[markDepositDisputed] dispute event for unknown PI: ${input.stripePaymentIntentId}`);
    return { found: false };
  }
  const recordId: string = rows[0].id;
  await updateRecord(PAYMENTS_TABLE, recordId, {
    'Dispute Status': input.disputeStatus,
    'Dispute Amount': (input.disputeAmountCents || 0) / 100,
    'Dispute Reason': input.disputeReason || '',
    'Dispute Updated At': new Date().toISOString(),
  });
  return { found: true, recordId };
}

export interface ReleasePayoutInput {
  paymentId: string;
  rancherId: string;
  stripeTransferId: string;
  amountCents: number; // 90% of deposit, computed by caller
  reason: 'fulfillment_confirmed' | 'dispute_resolved';
}

/**
 * @deprecated DEAD PATH under the direct-charge model (Area E4a, 2026-07-01).
 * releasePayout() has ZERO callers: BHC charges deposits directly on the
 * rancher's Connect account, so the platform never creates transfers and no
 * code path ever writes the escrow Payouts table this function feeds. That
 * left /rancher/billing's "Recent payouts" reading a permanently-empty table;
 * the billing UI now reads LIVE Stripe payouts instead (see the stripePayouts
 * merge in app/api/rancher/billing/data/route.ts). Kept, not deleted, per the
 * zero-risk rule — removal belongs to a dedicated cleanup slice.
 */
export async function releasePayout(input: ReleasePayoutInput): Promise<{ id: string }> {
  // Idempotency: skip if a Payout row already exists for this transfer id.
  const safeTransferId = input.stripeTransferId.replace(/"/g, '\\"');
  const existing: any[] = await getAllRecords(
    PAYOUTS_TABLE,
    `{Stripe Transfer Id} = "${safeTransferId}"`
  );
  if (existing.length > 0) return { id: existing[0].id };

  const created: any = await createRecord(PAYOUTS_TABLE, {
    'Payment': [input.paymentId],
    'Rancher': [input.rancherId],
    'Stripe Transfer Id': input.stripeTransferId,
    'Amount Cents': input.amountCents,
    'Status': 'paid',
    'Released At': new Date().toISOString(),
    'Reason': input.reason,
  });
  return { id: created.id };
}
