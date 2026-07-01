// Stripe Connect Express — platform takes 100% deposit, holds it, pays rancher
// 90% on fulfillment confirm, retains 10% as commission + monthly platform fee.
//
// Two Airtable tables back this contract:
//   - Payments: every deposit attempt (pending/succeeded/refunded/failed)
//   - Payouts:  every release to a rancher's connected account
// Idempotency is keyed on Stripe Payment Intent ID + Stripe Transfer ID so
// webhook retries never double-process.

import { createRecord, updateRecord, getAllRecords, getFirstRecord, getRecordById, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { decrementCapacity, syncCapacityToAirtable } from '@/lib/rancherCapacity';
import { logAuditEntry } from '@/lib/auditLog';
import { sendTelegramUpdate } from '@/lib/telegram';
import { refundReferralClearFields, shouldDecrementOnRefundRestore } from '@/lib/refundLifecycle';

export type PaymentStatus = 'pending' | 'succeeded' | 'refunded' | 'failed' | 'abandoned' | 'requires_webhook_replay';
export type PayoutStatus = 'pending' | 'paid' | 'failed';

export const PAYMENTS_TABLE = 'Payments';
export const PAYOUTS_TABLE = 'Payouts';

// ── Payments-by-referral lookup (G1/E6 — referral-id denorm) ─────────────────
//
// Clover defers the PaymentIntent to pay-time, so the deposit-dedup and the
// settlement fallback must find the Payments row BY REFERRAL. The historical
// pattern was `SEARCH("<refId>", ARRAYJOIN({Referral}))` — an unindexable
// full-table formula scan that is ALSO semantically DEAD in this base:
// ARRAYJOIN over a link field joins the linked records' PRIMARY-FIELD values,
// and the Referrals primary field (`Name`, singleLineText) is never written by
// any code path — verified 2026-07-01 against the live schema + row samples
// (every sampled Referrals.Name is empty). So ARRAYJOIN({Referral}) emits ""
// and SEARCH(recId, "") NEVER matches. (The old comment here claiming the
// Referral link's primary value "is the record ID" was wrong.)
//
// Fix: recordDeposit denormalizes the referral record id into a plain
// `Referral Id Text` field on Payments; every by-referral lookup queries that
// with an exact match FIRST and only falls back to the legacy ARRAYJOIN scan
// for rows written before the field existed. One release after this ships the
// legacy fallback can be dropped (the prod Payments table was EMPTY when this
// landed, so in practice there are no legacy rows to preserve).
//
// SCHEMA DEPENDENCY: `Referral Id Text` (single line text) must exist on the
// Payments table. If it doesn't, createRecord/updateRecord strip it with a
// console.warn + throttled operator Telegram alert (see lib/airtable.ts), and
// recordDeposit below ALSO read-back-verifies the first write and warns loudly.

export const REFERRAL_ID_TEXT_FIELD = 'Referral Id Text';

// Airtable record ids are exactly `rec` + 14 alphanumerics. Validating the
// shape BEFORE interpolating means no quote/backslash can ever reach the
// formula string (escapeAirtableValue below is belt-and-braces on top).
const AIRTABLE_RECORD_ID = /^rec[A-Za-z0-9]{14}$/;

/**
 * Build the Payments-by-referral filterByFormula clause. Pure — unit-tested in
 * payments.byReferral.test.ts.
 *
 *   - default: `{Referral Id Text} = "<refId>"` (exact match on the
 *     denormalized scalar — the fast path for every row written after the
 *     field shipped).
 *   - { legacy: true }: the old `SEARCH("<refId>", ARRAYJOIN({Referral}))`
 *     scan, kept ONLY as a back-compat fallback for pre-field rows. Drop one
 *     release after 2026-07-01.
 *
 * A referralId that is not shaped like a record id returns `FALSE()` — a
 * never-matching clause — instead of interpolating attacker-controllable text
 * into the formula. (A malformed id could never identify a row anyway, and a
 * substring-y one like "rec" inside SEARCH could match the WRONG rows.)
 */
export function paymentsByReferralFormula(
  referralId: string,
  opts: { legacy?: boolean } = {},
): string {
  if (!AIRTABLE_RECORD_ID.test(referralId)) {
    console.warn(
      `[paymentsByReferralFormula] refusing non-record-id referralId ${JSON.stringify(String(referralId).slice(0, 40))} — returning never-match clause`,
    );
    return 'FALSE()';
  }
  const escaped = escapeAirtableValue(referralId); // no-op for a valid rec id; defense in depth
  return opts.legacy
    ? `SEARCH("${escaped}", ARRAYJOIN({Referral}))`
    : `{${REFERRAL_ID_TEXT_FIELD}} = "${escaped}"`;
}

/**
 * Fetch Payments rows for a referral: exact-match on `Referral Id Text` first,
 * then (only when that returns nothing) the legacy ARRAYJOIN scan for rows
 * written before the field existed. `statusClause` is an optional trusted
 * formula fragment (literal constants at call sites, e.g. `{Status} = "pending"`)
 * AND-ed onto both queries.
 *
 * LEGACY FALLBACK — DROP ONE RELEASE AFTER 2026-07-01: once every live row
 * carries `Referral Id Text` (all rows created after this ships do, and the
 * table was empty at ship time), delete the second query.
 */
export async function findPaymentsByReferral(
  referralId: string,
  opts: { statusClause?: string } = {},
): Promise<any[]> {
  if (!AIRTABLE_RECORD_ID.test(String(referralId || ''))) return [];
  const compose = (byRef: string) =>
    opts.statusClause ? `AND(${byRef}, ${opts.statusClause})` : byRef;
  const fast: any[] = await getAllRecords(
    PAYMENTS_TABLE,
    compose(paymentsByReferralFormula(referralId)),
  );
  if (fast.length > 0) return fast;
  return (await getAllRecords(
    PAYMENTS_TABLE,
    compose(paymentsByReferralFormula(referralId, { legacy: true })),
  )) as any[];
}

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
    // Denormalized scalar copy of the referral record id (G1/E6). The link
    // field above is authoritative for humans + rollups; this plain-text copy
    // exists so filterByFormula can find the row by referral with an exact
    // match instead of the (dead — see paymentsByReferralFormula) ARRAYJOIN
    // full-table scan. Settlement under Clover depends on this lookup.
    [REFERRAL_ID_TEXT_FIELD]: input.referralId,
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
    // Match by PI (the same-session resubmit) OR by a still-pending row for this
    // referral. The referral clause only WIDENS the candidate set so we can see
    // an in-flight row — the reuse decision below still requires an exact PI
    // match. By-referral matching uses the denormalized {Referral Id Text}
    // exact match (see paymentsByReferralFormula — the old ARRAYJOIN scan
    // never matched because Referrals' primary field is empty).
    let existing: any[] = await getAllRecords(
      PAYMENTS_TABLE,
      `OR({Stripe Payment Intent Id} = "${piEscaped}", AND(${paymentsByReferralFormula(input.referralId)}, {Status} = "pending"))`,
    );
    // LEGACY FALLBACK — DROP ONE RELEASE AFTER 2026-07-01. Rows written before
    // `Referral Id Text` existed can only be seen via the old ARRAYJOIN scan.
    // Running it ONLY when the fast query returned nothing is behavior-
    // equivalent to the old single query for the reuse decision: a row this
    // skips is by construction a different-PI row (a same-PI row would have
    // matched the PI clause above), and selectReusablePaymentRow maps
    // different-PI candidates and absent candidates to the SAME outcome
    // (create a new row).
    if (existing.length === 0) {
      existing = await getAllRecords(
        PAYMENTS_TABLE,
        `OR({Stripe Payment Intent Id} = "${piEscaped}", AND(${paymentsByReferralFormula(input.referralId, { legacy: true })}, {Status} = "pending"))`,
      );
    }
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
        // Backfill the denormalized referral id on reuse so a pre-field row
        // migrates to the fast lookup path (no-op re-stamp on new rows).
        [REFERRAL_ID_TEXT_FIELD]: input.referralId,
      });
      return { id: reusable.id };
    }
  } catch (e: any) {
    console.warn('[recordDeposit] dedup lookup failed — creating new row:', e?.message);
  }

  const created: any = await createRecord(PAYMENTS_TABLE, fields);
  // VERIFY the denormalized field persisted. createRecord auto-strips unknown
  // fields (with its own warn + throttled operator alert — see lib/airtable.ts)
  // and returns the record AS SAVED, so a missing key here means the field
  // doesn't exist on the Payments table yet. Warn loudly with the exact fix:
  // without this field, by-referral lookups fall back to the legacy ARRAYJOIN
  // scan, which NEVER matches (Referrals' primary field is empty) — i.e.
  // Clover settlement-by-referral stays broken until the field is added.
  // Zero extra API calls: we inspect the create response, no read-back fetch.
  const savedRefIdText = created?.fields?.[REFERRAL_ID_TEXT_FIELD];
  if (savedRefIdText !== input.referralId) {
    console.warn(
      `[recordDeposit] '${REFERRAL_ID_TEXT_FIELD}' did NOT persist on Payments row ${created?.id} ` +
      `(got ${JSON.stringify(savedRefIdText)}). ACTION REQUIRED: add '${REFERRAL_ID_TEXT_FIELD}' ` +
      `(single line text) to the Payments table in Airtable. Until it exists, Payments-by-referral ` +
      `lookups (deposit dedup, Clover settlement fallback, fulfillment payment gate, SLA/demand-router ` +
      `enrichment) cannot use the exact-match path and the legacy ARRAYJOIN fallback never matches.`,
    );
  }
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
  // Unique-key lookup — maxRecords:1 (getFirstRecord) instead of a full
  // filtered pagination. Wrapped back into an array so selectSettlementRow's
  // (pure, tested) decision contract is untouched.
  const piFirst = await getFirstRecord(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`
  );
  const piMatched: any[] = piFirst ? [piFirst] : [];
  // CLOVER async-PI fallback: under apiVersion 2026-02-25 the PaymentIntent
  // doesn't exist at checkout-create, so recordDeposit stored the row with an
  // EMPTY 'Stripe Payment Intent Id'. By the payment_intent.succeeded webhook
  // we know both the real PI id AND the referral (pi.metadata.referralId). When
  // no row matches the PI id, fall back to the still-pending row for that
  // referral and backfill the PI id so the ledger settles + repeat deliveries
  // dedupe by PI. Decision extracted to selectSettlementRow (pure, tested).
  // Lookup swap (G1/E6): exact match on the denormalized {Referral Id Text}
  // first, legacy ARRAYJOIN scan only when that returns nothing (pre-field
  // rows — drop one release after 2026-07-01). NOTE the legacy scan never
  // actually matched in this base (Referrals' primary field is empty — see
  // paymentsByReferralFormula), so for rows carrying the new field this is
  // the first time the Clover settle-by-referral fallback can fire at all.
  let referralPending: any[] = [];
  if (piMatched.length === 0 && opts.referralId) {
    referralPending = await findPaymentsByReferral(String(opts.referralId), {
      statusClause: `{Status} = "pending"`,
    });
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
  // Same rationale as the PI backfill, for the by-referral path: stamp the
  // denormalized referral id onto rows that predate {Referral Id Text} so
  // future by-referral lookups (fulfillment gate, SLA/demand-router
  // enrichment) hit the exact-match path. Same update call — zero extra API
  // cost; strip-safe if the schema field is missing. Settlement decision is
  // untouched. Deliberately NOT added to the schema-fallback retry below —
  // that path stays minimal so the critical Status flip can't be blocked.
  if (
    opts.referralId &&
    !payment[REFERRAL_ID_TEXT_FIELD] &&
    /^rec[A-Za-z0-9]{14}$/.test(String(opts.referralId))
  ) {
    fields[REFERRAL_ID_TEXT_FIELD] = String(opts.referralId);
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
  const payment: any = await getFirstRecord(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`,
  );
  if (!payment) return { found: false, flipped: false };
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
  const payment: any = await getFirstRecord(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`,
  );
  if (!payment) return { found: false, flipped: false };
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
  const payment: any = await getFirstRecord(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`
  );
  if (!payment) return { flipped: false };

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
  //   - Rancher capacity: NO decrement from Closed Won (C4 — recordClose
  //     already freed the slot at close time; gated via
  //     shouldDecrementOnRefundRestore for any future non-Closed-Won restore)
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

  // 2. Rancher capacity — gated, never unconditional (C4 fix). recordClose
  // already freed the slot when the deal transitioned to Closed Won, so
  // decrementing again here pushed the counter BELOW the true held count and
  // let the matcher over-book a genuinely-full rancher (compounding on every
  // close→refund cycle). Only decrement when the status captured BEFORE the
  // refund flip (currentStatus) still occupied a slot — pure decision,
  // unit-tested in lib/refundLifecycle.test.ts. On today's path currentStatus
  // is always 'Closed Won' (early-returns above), so this never fires; the
  // gate keeps any future widening of the restore path capacity-correct.
  // syncCapacityToAirtable only runs when the counter actually moved.
  let capacityDecremented = false;
  if (rancherId && shouldDecrementOnRefundRestore(currentStatus)) {
    try {
      const newCount = await decrementCapacity(rancherId);
      await syncCapacityToAirtable(rancherId, newCount);
      capacityDecremented = true;
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
        // C4: truthful — reflects the gated decrement actually landing, not
        // merely "a rancher was linked" (which logged true on the buggy
        // unconditional path AND when the decrement threw).
        capacityDecremented,
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
  const row = await getFirstRecord(
    PAYMENTS_TABLE,
    `{Stripe Payment Intent Id} = "${escaped}"`,
  );
  if (!row) {
    console.warn(`[markDepositDisputed] dispute event for unknown PI: ${input.stripePaymentIntentId}`);
    return { found: false };
  }
  const recordId: string = row.id;
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
