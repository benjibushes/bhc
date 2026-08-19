// lib/obligations.ts
//
// Fulfillment audit P0-1 (2026-08-18) — THE OBLIGATIONS SELECTOR.
//
// THE HOLE THIS CLOSES: until now the only money-at-risk number on any
// operator surface was the cockpit's "Stuck" tile, built from
// `Deposit Paid At && !Rancher Accepted At`. The moment a rancher tapped
// Accept, the deal left EVERY operator view — and nothing anywhere read
// `Fulfillment Confirmed At` / `Fulfillment Status`. So the one question that
// matters after money changes hands — "what do I owe a customer right now?" —
// had no answer on any screen. The chase crons knew (lib/fulfillmentChase,
// lib/productFulfillmentSla), but they speak only in emails and Telegram
// cards that scroll away, and both ladders go permanently quiet.
//
// THE DEFINITION, one line: an obligation is a row where BHC has taken a
// customer's money and cannot prove the customer got their beef.
//
// Three rails, one band:
//   connect — a Referral with `Deposit Paid At` and no fulfillment
//             confirmation, not closed, not refunded/disputed. Covers BOTH
//             the never-accepted case (the old Stuck tile, P0-2's cohort) and
//             the accepted-then-silent case that used to vanish.
//   broker  — a represented-ranch Referral with a deposit. There is no Accept
//             and no dashboard on this rail, so the only observable milestone
//             is whether the fulfillment sheet reached the ranch at all
//             (`Intro Sent At` ≥ `Deposit Paid At`, the stamp
//             lib/brokerSettlement writes only on a real delivery). An
//             undelivered sheet is the WORSE case, not an exclusion — the
//             ranch does not even know the order exists — so it lands here
//             pinned rather than being dropped.
//   shop    — a Rancher Order still in Status='New' past the window the ranch
//             itself promised at checkout (`Ships In Days`), via the same
//             lib/productFulfillmentSla arithmetic the chase cron uses, so
//             the band and the cron can never disagree about "late".
//             Connector-pushed rows are excluded on the same `External Push
//             Status !== 'pushed'` test the cron applies — Shopify/Printify
//             fulfill those, BHC does not.
//
// WHAT COUNTS AS OVER (review fix B1). "Closed" is NOT this module's own
// opinion any more: it imports lib/fulfillmentChase::isFulfillmentTerminal,
// the same predicate the chase lanes and the exhaustion escalation use, so a
// row can never again be chaseable-but-invisible. The load-bearing case is
// CONNECT 'Closed Won', which means the buyer paid the BALANCE — not that beef
// moved — and therefore stays an obligation until something confirms delivery
// (bounded by FULFILLMENT_TRACKING_EPOCH so pre-tracking deals don't swamp the
// band). On BROKER, Closed Won is written by the same operation that stamps
// the confirmation, so there it really does mean delivered.
//
// WHAT COUNTS AS REFUNDED (review fix B3). Only money genuinely returned —
// lib/depositSla::isMoneyReturnedToBuyer, not the broader isRefundedOrDisputed
// the send rails use. A partial refund and a live chargeback both leave the
// obligation standing.
//
// PURE — no IO, no env, no Date.now(); the caller passes `now` and the already-
// loaded Airtable snapshots. Everything that touches a possibly-missing field
// (Fulfillment Confirmed At, Fulfillment Status, the chase stamps) is read in
// JS where absent is just `undefined` — the {Refunded At} lesson.

import { isMoneyReturnedToBuyer, isBrokerRailReferral, ESCALATION_AFTER_HOURS } from './depositSla';
import { FULFILLMENT_FIELDS } from './fulfillmentTracking';
import {
  CHASE_FIELDS,
  FULFILLMENT_ESCALATED_AT_FIELD,
  MAX_LIFETIME_CHASES,
  isFulfillmentTerminal,
} from './fulfillmentChase';
import { orderKind, slaWindowFor } from './productFulfillmentSla';
import { isSyntheticTestEmail } from './demandRouter';

export type ObligationRail = 'connect' | 'broker' | 'shop';

export interface ObligationRow {
  /** Airtable record id — Referrals for connect/broker, Rancher Orders for shop. */
  id: string;
  rail: ObligationRail;
  /** Hours since the money landed (deposit settled / order placed). */
  ageHours: number;
  /**
   * Money collected FROM THE CUSTOMER, in cents — the deposit plus the on-top
   * platform fee they were actually charged (see collectedCents). Not the
   * rancher's take, and not BHC's fee.
   */
  amountCents: number;
  buyerName: string;
  buyerState: string;
  ranchName: string;
  /** Short "where this sits" label for the row. */
  stage: string;
  /** The single next thing a human does about it. */
  nextAction: string;
  /**
   * Every automated ladder for this row is finished (or never started) — a
   * human is the only thing left. These sort no differently (age is the
   * ordering truth) but the surface marks them so they can't be scrolled past.
   */
  pinned: boolean;
  /** shop only: the ranch's own `Ships In Days` promise, when it has one. */
  promisedDays: number | null;
}

export interface ObligationsInput {
  /** Referrals snapshot rows (connect + broker rails). */
  referrals: Array<Record<string, any>>;
  /** Rancher Orders snapshot rows (shop rail). */
  rancherOrders?: Array<Record<string, any>>;
  /** Referral id → its Payments row, for refund/dispute exclusion. */
  paymentByReferralId?: Map<string, any>;
  /** Rancher record id → the Ranchers row (name + the `Broker Rail` truth). */
  rancherById?: Map<string, any>;
  /** Product record id → `Ships In Days`, the promise made at checkout. */
  shipDaysByProductId?: Map<string, number>;
  now: number;
  /** Row cap. The oldest money always survives the cut. Default 50. */
  limit?: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DEFAULT_LIMIT = 50;

function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object' && 'name' in (v as any)) return String((v as any).name ?? '');
  return String(v);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function ms(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : null;
}

function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/** Confirmed via EITHER path — the binary stamp or the richer tracker. */
function isFulfillmentConfirmed(row: Record<string, any>): boolean {
  if (row['Fulfillment Confirmed At']) return true;
  return str(row[FULFILLMENT_FIELDS.status]).toLowerCase() === 'fulfilled';
}

/**
 * Has every automated chase for this referral run out? `Fulfillment Escalated
 * At` is the durable stamp the exhausted ladder writes (P0-3); the Count read
 * is the belt that works TODAY, before that field exists in the schema — the
 * selector skips a row forever once Count hits the lifetime cap, so the cap
 * itself IS the exhaustion signal.
 */
export function isChaseExhausted(ref: Record<string, any>): boolean {
  if (ref[FULFILLMENT_ESCALATED_AT_FIELD]) return true;
  return num(ref[CHASE_FIELDS.count]) >= MAX_LIFETIME_CHASES;
}

function rancherOf(
  ref: Record<string, any>,
  rancherById?: Map<string, any>,
): Record<string, any> | null {
  const linked = ref['Rancher'] || ref['Suggested Rancher'];
  const id = Array.isArray(linked) ? String(linked[0] || '') : '';
  if (!id || !rancherById) return null;
  return rancherById.get(id) || null;
}

function ranchNameOf(ref: Record<string, any>, rancher: Record<string, any> | null): string {
  return (
    str(rancher?.['Ranch Name']) ||
    str(rancher?.['Operator Name']) ||
    str(ref['Rancher Name']) ||
    str(ref['Suggested Rancher Name']) ||
    'the ranch'
  );
}

/**
 * Is this referral on the BROKER rail?
 *
 * Delegates to lib/depositSla::isBrokerRailReferral so this band uses the SAME
 * three-signal test as every other broker surface: the linked rancher's
 * `Broker Rail` checkbox (authoritative), the Payments row's
 * Type='broker_deposit' (written at settle), and the referral's `Match Type`
 * (written at mint). The Payments signal is the one this function used to be
 * missing, and its absence had teeth: a broker row whose Ranchers record could
 * not be read AND whose Match Type had drifted fell through to
 * connectObligation, which told the operator "the ranch never accepted the
 * slot" — on a rail that HAS no accept step, so that row would also pin itself
 * at 72h and never stop. OR-of-signals is the right bias: a false "broker"
 * costs slightly vaguer copy, a false "connect" invents a milestone.
 */
function isBrokerRow(
  ref: Record<string, any>,
  rancher: Record<string, any> | null,
  payment: Record<string, any> | null,
): boolean {
  return isBrokerRailReferral({ ...ref, __rancher: rancher, __payment: payment });
}

/**
 * What the CUSTOMER actually paid, in cents.
 *
 * `Deposit Amount` is the deposit alone. On the Connect rail BHC's 10% is
 * charged ON TOP of it (money model #1 — the rancher keeps 100% of the price,
 * the buyer pays the fee), so the deposit understates the charge by exactly
 * the platform fee and a tile labelled "collected" was quietly wrong. Same
 * precedence as lib/contracts/payments::markDepositRefunded's capturedCents,
 * so this band and the refund gate agree on what a full charge is:
 *   1. 'Total Charged Cents' — stamped at settlement, the true charged total;
 *   2. deposit + 'Platform Fee Cents' — for rows predating that field;
 *   3. the Payments row's deposit alone;
 *   4. the Referral's 'Deposit Amount' (dollars) when there is no Payments row.
 */
function collectedCents(ref: Record<string, any>, payment: Record<string, any> | null): number {
  const fallback = toCents(num(ref['Deposit Amount']));
  if (!payment) return fallback;
  const total = num(payment['Total Charged Cents']);
  if (total > 0) return total;
  const deposit = num(payment['Amount Cents']);
  const fee = num(payment['Platform Fee Cents']);
  if (deposit > 0) return deposit + fee;
  return fallback;
}

function days(msSpan: number): number {
  return Math.floor(msSpan / DAY);
}

// ── The three rails ─────────────────────────────────────────────────────────

function connectObligation(
  ref: Record<string, any>,
  rancher: Record<string, any> | null,
  paidAt: number,
  now: number,
  amountCents: number,
): ObligationRow {
  const ageDays = days(now - paidAt);
  const ranchName = ranchNameOf(ref, rancher);
  const exhausted = isChaseExhausted(ref);
  const unaccepted = !ref['Rancher Accepted At'];

  let stage: string;
  let nextAction: string;
  let pinned: boolean;

  if (unaccepted) {
    const hrs = Math.floor((now - paidAt) / HOUR);
    stage = 'paid, never accepted';
    nextAction = `Deposit paid ${ageDays}d ago and ${ranchName} never accepted the slot — call them, re-route, or refund.`;
    // Past the 72h operator escalation the machine has said everything it can.
    pinned = hrs >= ESCALATION_AFTER_HOURS;
  } else if (exhausted) {
    stage = 'accepted, chase exhausted';
    nextAction = `Every automated chase is spent and nothing confirms delivery — call ${ranchName} and close this out.`;
    pinned = true;
  } else {
    stage = 'accepted, unconfirmed';
    nextAction = `Waiting on ${ranchName} to confirm fulfillment.`;
    pinned = false;
  }

  return {
    id: String(ref.id),
    rail: 'connect',
    ageHours: Math.floor((now - paidAt) / HOUR),
    amountCents,
    buyerName: str(ref['Buyer Name']),
    buyerState: str(ref['Buyer State']),
    ranchName,
    stage,
    nextAction,
    pinned,
    promisedDays: null,
  };
}

function brokerObligation(
  ref: Record<string, any>,
  rancher: Record<string, any> | null,
  paidAt: number,
  now: number,
  amountCents: number,
): ObligationRow {
  const ageDays = days(now - paidAt);
  const ranchName = ranchNameOf(ref, rancher);
  // deliverBrokerRancherSheet stamps 'Intro Sent At' with the SAME nowIso that
  // stamps 'Deposit Paid At'; an older stamp is the pre-deposit routing one.
  const sheetAt = ms(ref['Intro Sent At']);
  const sheetDelivered = sheetAt !== null && sheetAt >= paidAt;
  const exhausted = isChaseExhausted(ref);

  let stage: string;
  let nextAction: string;
  let pinned: boolean;

  if (!sheetDelivered) {
    stage = 'paid, sheet undelivered';
    nextAction = `Deposit taken ${ageDays}d ago but the fulfillment sheet never reached ${ranchName} — they do not know this order exists. Send it, then call.`;
    pinned = true;
  } else if (exhausted) {
    stage = 'sheet sent, chase exhausted';
    nextAction = `Buyer check-ins are spent and nothing confirms pickup — call ${ranchName} directly (they are off-platform).`;
    pinned = true;
  } else {
    stage = 'sheet sent, pickup unconfirmed';
    nextAction = `Confirm pickup happened — the buyer is the only party who can tell us on this rail.`;
    pinned = false;
  }

  return {
    id: String(ref.id),
    rail: 'broker',
    ageHours: Math.floor((now - paidAt) / HOUR),
    amountCents,
    buyerName: str(ref['Buyer Name']),
    buyerState: str(ref['Buyer State']),
    ranchName,
    stage,
    nextAction,
    pinned,
    promisedDays: null,
  };
}

function shopObligation(
  order: Record<string, any>,
  orderedAt: number,
  now: number,
  shipDaysByProductId?: Map<string, number>,
): ObligationRow | null {
  const productId = str(order['Product Record ID']).trim();
  const promised = productId ? (shipDaysByProductId?.get(productId) ?? null) : null;
  const kind = orderKind(str(order['Order Ref']));
  const { nudgeDays, escalateDays, fromPromise } = slaWindowFor(kind, promised);

  const ageDays = (now - orderedAt) / DAY;
  if (ageDays < nudgeDays) return null; // inside the promise — not late, not owed

  const whole = Math.floor(ageDays);
  const ranchName = str(order['Rancher Name']) || 'the ranch';
  const windowNote = fromPromise
    ? `${promised}-day ship promise`
    : kind === 'ship'
      ? `${nudgeDays}-day window`
      : `${nudgeDays}-day ${kind} window`;

  return {
    id: String(order.id),
    rail: 'shop',
    ageHours: Math.floor((now - orderedAt) / HOUR),
    amountCents: toCents(num(order['Buyer Paid'])),
    buyerName: str(order['Buyer Name']),
    buyerState: '',
    ranchName,
    stage: `paid, still 'New' (${kind})`,
    nextAction: `Not marked shipped ${whole}d after checkout, against a ${windowNote} — chase ${ranchName} or refund.`,
    pinned: ageDays >= escalateDays,
    promisedDays: promised,
  };
}

// ── The band ────────────────────────────────────────────────────────────────

/**
 * Every open obligation across all three rails, oldest money first.
 *
 * Sorted purely by age: the longest a customer has been waiting is the only
 * ordering that can't be argued with, and `pinned` marks the rows no machine
 * will touch again so the surface can flag them without reordering the truth.
 */
export function selectObligations(input: ObligationsInput): ObligationRow[] {
  const { referrals, rancherOrders, paymentByReferralId, rancherById, shipDaysByProductId } = input;
  const now = input.now;
  const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : DEFAULT_LIMIT;

  const rows: ObligationRow[] = [];

  for (const ref of referrals || []) {
    if (!ref || !ref.id) continue;

    // 1. Money actually landed.
    const paidAt = ms(ref['Deposit Paid At']);
    if (paidAt === null) continue;

    // 2. Delivery is genuinely unproven.
    if (isFulfillmentConfirmed(ref)) continue;

    // 3. Which rail — decided BEFORE the terminal test, because 'Closed Won'
    //    does not mean the same thing on both (see isFulfillmentTerminal).
    const payment = paymentByReferralId?.get(String(ref.id)) ?? null;
    const rancher = rancherOf(ref, rancherById);
    const broker = isBrokerRow(ref, rancher, payment);

    // 4. The deal is still open — THE SHARED RULE, identical to the one the
    //    chase lanes and the exhaustion escalation use (lib/fulfillmentChase).
    //    This band used to drop every 'Closed Won' row while the chase cron
    //    happily kept chasing them: a Connect deal where the buyer paid the
    //    balance IN FULL and the beef never moved took all three chases, hit
    //    the lifetime cap, and then vanished from both terminal surfaces.
    if (isFulfillmentTerminal(ref, { rail: broker ? 'broker' : 'connect' })) continue;

    // 5. The money actually came back. NARROW on purpose (isMoneyReturnedToBuyer,
    //    not isRefundedOrDisputed): a partial refund and an in-flight chargeback
    //    both leave the obligation standing — a buyer who got $1 back on a $750
    //    deposit is still a buyer waiting on a side of beef.
    if (isMoneyReturnedToBuyer({ ...ref, __payment: payment })) continue;

    // 6. Synthetic e2e rows never reach a human's list.
    const email = str(ref['Buyer Email']).toLowerCase();
    if (email && isSyntheticTestEmail(email)) continue;

    const amountCents = collectedCents(ref, payment);
    rows.push(
      broker
        ? brokerObligation(ref, rancher, paidAt, now, amountCents)
        : connectObligation(ref, rancher, paidAt, now, amountCents),
    );
  }

  for (const order of rancherOrders || []) {
    if (!order || !order.id) continue;
    if (str(order.Status) !== 'New') continue;
    // Connector-pushed orders are Shopify's/Printify's to fulfill — mirrors
    // app/api/cron/product-fulfillment-sla exactly (`!== 'pushed'` is kept).
    // The store ships on its own SLA and the reverse webhook stamps Shipped,
    // so these are not BHC obligations; without this they would not merely
    // appear, they would PIN past the escalate window and hijack the cockpit's
    // single `oneMove` slot with an order nobody at BHC is meant to touch.
    if (str(order['External Push Status']) === 'pushed') continue;
    if (order['Refunded At'] || order['Cancelled At']) continue;
    const orderedAt = ms(order['Ordered At']);
    if (orderedAt === null) continue;
    const email = str(order['Buyer Email']).toLowerCase();
    if (email && isSyntheticTestEmail(email)) continue;

    const row = shopObligation(order, orderedAt, now, shipDaysByProductId);
    if (row) rows.push(row);
  }

  rows.sort((a, b) => b.ageHours - a.ageHours || a.id.localeCompare(b.id));
  return rows.slice(0, limit);
}

export interface ObligationsSummary {
  count: number;
  totalCents: number;
  pinnedCount: number;
  oldestHours: number | null;
  byRail: Record<ObligationRail, number>;
}

/** Headline numbers for the tile above the band. */
export function summarizeObligations(rows: ObligationRow[]): ObligationsSummary {
  const byRail: Record<ObligationRail, number> = { connect: 0, broker: 0, shop: 0 };
  let totalCents = 0;
  let pinnedCount = 0;
  let oldestHours: number | null = null;
  for (const r of rows || []) {
    byRail[r.rail] += 1;
    totalCents += r.amountCents;
    if (r.pinned) pinnedCount += 1;
    if (oldestHours === null || r.ageHours > oldestHours) oldestHours = r.ageHours;
  }
  return { count: (rows || []).length, totalCents, pinnedCount, oldestHours, byRail };
}
