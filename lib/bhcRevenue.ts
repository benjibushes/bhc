// lib/bhcRevenue.ts — THE ONE DEFINITION of "what has BuyHalfCow earned".
//
// WHY THIS MODULE EXISTS (money-truth audit, 2026-08-19).
//
// The founder had two money screens and they disagreed, and the one he opens
// first understated what he had made by most of it:
//
//   • /admin/today "Earned" was `Connect fee captured + shop margin`. The
//     LEGACY invoiced-commission rail was absent BY CONSTRUCTION — and legacy
//     is where the money actually is: $3,350.80 of $3,982.57 lifetime (84%) on
//     the live base the day this shipped. Month-to-date read $178.72 against a
//     true $273.13. The arming runbook treats that screen as ground truth.
//   • /admin's command-center had its own three-way split (current / legacy /
//     allRails) computed inline from a fourth set of reduces, and a per-source
//     analytics route had a FIFTH ("legacy + connect + inquiry commission",
//     shop margin omitted). Five live definitions of one number.
//   • The BROKER rail was in the totals and nobody could tell: recordBrokerDeposit
//     writes the deposit into BOTH 'Amount Cents' and 'Platform Fee Cents' on
//     purpose (on that rail the deposit IS the whole commission), and
//     computeConnectFeeCaptured sums 'Platform Fee Cents' with no Type filter.
//     So broker income was reported as "Connect fee · N deals". Splitting the
//     rails here RE-LABELS; lib/bhcRevenue.test.ts pins that the two together
//     still equal computeConnectFeeCaptured, so no total moves.
//
// EVERY figure this module returns carries the rail list it covers, and the
// screens render that list next to the number. A partial must never again be
// readable as a total.
//
// PURE. No Airtable, no env, no clock — the caller passes the snapshots it has
// already read and the range predicate it wants (lib/followUpQueue.operatorToday
// keeps the "Ben's calendar day is America/Denver" question in one place).

import { legacyClosedWon } from './commissionStats';
import { isBrokerPaymentRow } from './paymentCapture';
import { TERMINAL_PRODUCT_ORDER_STATUSES } from './productOrderStatus';

/**
 * The rails BHC actually earns on AND can measure from Airtable, in the order
 * the screens render them. Adding a rail here is the ONLY way to add it to a
 * total — that is the point of the list existing.
 */
export const REVENUE_RAILS = [
  'connectFee',
  'brokerDeposit',
  'shopMargin',
  'legacyCommission',
  'founders',
  'brandPartner',
] as const;

export type RevenueRail = (typeof REVENUE_RAILS)[number];

/** Screen-facing label per rail — what the number IS, in the founder's words. */
export const REVENUE_RAIL_LABELS: Record<RevenueRail, string> = {
  connectFee: 'Connect marketplace fee (taken at deposit)',
  brokerDeposit: 'Broker deposit (kept in full)',
  shopMargin: 'Shop margin',
  legacyCommission: 'Legacy commission (invoiced after close, collected)',
  founders: 'Founding Herd backers',
  brandPartner: 'Brand partners',
};

/**
 * Rails that take real money in Stripe and record NO amount in Airtable, so no
 * honest total can include them. Rendered beside the total so "all rails" is
 * never read as "all money". Fixing any of these is a schema change, not a
 * reporting change.
 */
export const UNMEASURED_REVENUE_RAILS: ReadonlyArray<{ rail: string; why: string }> = [
  {
    rail: 'Rancher subscription tiers (Pasture / Ranch / Operator)',
    why: 'the tier webhook writes Tier + Subscription Status only — no amount, no paid-at. Prices live in lib/tiers.ts.',
  },
  {
    rail: 'Founding Herd RENEWALS',
    why: "invoice.paid falls through for founder subs; only the FIRST charge lands in Consumers['Tier Amount Paid'].",
  },
  {
    rail: 'Brand partner RENEWALS',
    why: "invoice.paid stamps Brands['Last Renewal At'] only; the renewal amount goes to the Funnel Events log, not the Brands row.",
  },
  {
    rail: 'Rancher add-ons (video / photo / founder letter)',
    why: "Add-On Purchases carries Amount Cents but the webhook only flips Status='paid' — there is no paid-at stamp to date it by.",
  },
  {
    rail: 'Gear affiliate + merch',
    why: 'clicks are logged, earnings are not ingested at all; merch is entirely off-platform Shopify.',
  },
];

/** The table snapshots this module reads. `null` = that read FAILED. */
export interface RevenueSnapshot {
  /** Payments — Connect + broker deposits. */
  payments: Array<Record<string, any>> | null;
  /** Rancher Orders — the low-ticket shop rail. */
  rancherOrders: Array<Record<string, any>> | null;
  /** Referrals — the legacy invoiced-commission rail. */
  referrals: Array<Record<string, any>> | null;
  /** Consumers — Founding Herd backers. */
  consumers: Array<Record<string, any>> | null;
  /** Brands — brand partners. */
  brands: Array<Record<string, any>> | null;
}

export interface BhcRevenue {
  /** Dollars per rail. `null` ⇒ that table could not be read — NOT zero. */
  byRail: Record<RevenueRail, number | null>;
  /** Sum of the rails that COULD be read, in dollars. */
  total: number;
  /** Rails whose source table failed to read; their money is missing from `total`. */
  unreadableRails: RevenueRail[];
  /** true iff every rail was readable. false ⇒ `total` is a floor, not a total. */
  complete: boolean;
  /**
   * Legacy commission BILLED but not yet paid, in the same window. NOT part of
   * `total` — this is a receivable, money owed to BHC by a rancher. `null` when
   * the Referrals table could not be read.
   *
   * Kept separate because `total` is shown to the founder as revenue: booking a
   * billed-but-unpaid commission as earned is how a dashboard tells you that you
   * were paid when you were not.
   */
  legacyReceivable: number | null;
}

/** `true` when this ISO timestamp belongs to the window being asked about. */
export type InRange = (isoTimestamp: string) => boolean;

const toNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number): number => Math.round(n * 100) / 100;
const cell = (v: unknown): string =>
  v == null ? '' : typeof v === 'object' && 'name' in (v as any) ? String((v as any).name ?? '') : String(v);

/**
 * Sum `amount(row)` over the rows whose `stamp(row)` falls in range.
 * A row with no usable stamp is OUT of every range — undated money cannot be
 * claimed for a day or a month, and claiming it is how a tile drifts.
 */
function sumInRange(
  rows: Array<Record<string, any>>,
  stamp: (row: Record<string, any>) => string,
  amount: (row: Record<string, any>) => number,
  inRange: InRange,
): number {
  let total = 0;
  for (const row of rows) {
    const ts = stamp(row);
    if (!ts || !inRange(ts)) continue;
    total += amount(row);
  }
  return round2(total);
}

/**
 * Every dollar BHC earned in the window, by rail.
 *
 * Rail sources — verbatim Airtable fields, and the stamp each is dated by:
 *   connectFee       Payments      'Platform Fee Cents'  ← 'Captured At' || 'Created At'
 *   brokerDeposit    Payments      'Platform Fee Cents'  ← 'Captured At' || 'Created At'
 *   shopMargin       Rancher Orders'BHC Margin'          ← 'Ordered At'
 *   legacyCommission Referrals     'Commission Due'      ← 'Closed At'
 *   founders         Consumers     'Tier Amount Paid'    ← 'Subscribed At'
 *   brandPartner     Brands        'Amount Paid'         ← 'Paid At'
 *
 * Only money that MOVED counts: succeeded payments (pending / abandoned /
 * failed / refunded never landed), non-terminal shop orders (a Refunded or
 * Cancelled order is not earned), and Closed Won legacy-rail referrals.
 */
export function computeBhcRevenue(snap: RevenueSnapshot, inRange: InRange): BhcRevenue {
  const byRail = {} as Record<RevenueRail, number | null>;
  // Billed legacy commission still uncollected in this window. Null when the
  // Referrals table could not be read — unknown is not zero.
  let legacyReceivable: number | null = null;

  // ── Payments: two rails off one table, split by the ledger's own marker ──
  if (snap.payments === null) {
    byRail.connectFee = null;
    byRail.brokerDeposit = null;
  } else {
    const settled = snap.payments.filter((p) => cell(p['Status']) === 'succeeded');
    const stamp = (p: Record<string, any>) => String(p['Captured At'] || p['Created At'] || '');
    const fee = (p: Record<string, any>) => toNum(p['Platform Fee Cents']) / 100;
    // isBrokerPaymentRow reads the row's own 'Type', never a join back to the
    // rancher — the row is the thing that was charged.
    byRail.connectFee = sumInRange(settled.filter((p) => !isBrokerPaymentRow(p)), stamp, fee, inRange);
    byRail.brokerDeposit = sumInRange(settled.filter(isBrokerPaymentRow), stamp, fee, inRange);
  }

  // ── Shop rail ───────────────────────────────────────────────────────────
  if (snap.rancherOrders === null) {
    byRail.shopMargin = null;
  } else {
    // TERMINAL ORDERS DO NOT EARN. The refund path flips Status and stamps
    // 'Refunded At' but leaves 'BHC Margin' intact on purpose (it records what
    // the sale WAS), so a margin sum with no status filter keeps counting money
    // that went back out. The Connect rail has always been protected by its
    // succeeded-only filter; this is the same rule for this rail.
    const live = snap.rancherOrders.filter(
      (o) => !TERMINAL_PRODUCT_ORDER_STATUSES.has(cell(o['Status'])),
    );
    byRail.shopMargin = sumInRange(
      live,
      (o) => String(o['Ordered At'] || ''),
      (o) => toNum(o['BHC Margin']),
      inRange,
    );
  }

  // ── Legacy invoiced commission ──────────────────────────────────────────
  if (snap.referrals === null) {
    byRail.legacyCommission = null;
  } else {
    // legacyClosedWon is the canonical rail filter: Closed Won, no deposit
    // stamped (a deposit means the fee was already skimmed at checkout), and
    // not a broker row (BHC already kept that deposit in full — counting a
    // hand-stamped Commission Due on top would bill the same sale twice).
    //
    // COLLECTED ONLY. `Commission Due` is what BHC BILLED; `Commission Paid`
    // is whether the rancher actually paid it. This total is presented to the
    // founder as revenue, so it must mean money received — summing the billed
    // figure booked 8 uncollected deals ($1,083.62, oldest closed 2026-05-04)
    // as earned, and legacy is ~84% of lifetime, so the headline overstated
    // cash by a quarter. The vocabulary already existed and disagreed with the
    // sum: lib/commissionStats::computeLegacyCommissionEarned is documented as
    // "a receivable-book number, NOT total BHC revenue".
    //
    // The unpaid remainder is not dropped — it surfaces as `legacyReceivable`
    // below, which is a collectable list, not a rounding error.
    const legacy = legacyClosedWon(snap.referrals as any) as Array<Record<string, any>>;
    byRail.legacyCommission = sumInRange(
      legacy.filter((r) => r['Commission Paid'] === true),
      (r) => String(r['Closed At'] || ''),
      (r) => toNum(r['Commission Due']),
      inRange,
    );
    // Billed-but-unpaid, same window + same rail filter. Deliberately OUTSIDE
    // `total` — it is money owed to BHC, not money BHC has.
    legacyReceivable = sumInRange(
      legacy.filter((r) => r['Commission Paid'] !== true),
      (r) => String(r['Closed At'] || ''),
      (r) => toNum(r['Commission Due']),
      inRange,
    );
  }

  // ── Founding Herd backers ───────────────────────────────────────────────
  if (snap.consumers === null) {
    byRail.founders = null;
  } else {
    byRail.founders = sumInRange(
      snap.consumers,
      (c) => String(c['Subscribed At'] || ''),
      (c) => toNum(c['Tier Amount Paid']),
      inRange,
    );
  }

  // ── Brand partners ──────────────────────────────────────────────────────
  if (snap.brands === null) {
    byRail.brandPartner = null;
  } else {
    byRail.brandPartner = sumInRange(
      snap.brands,
      (b) => String(b['Paid At'] || ''),
      (b) => toNum(b['Amount Paid']),
      inRange,
    );
  }

  const unreadableRails = REVENUE_RAILS.filter((rail) => byRail[rail] === null);
  const total = round2(
    REVENUE_RAILS.reduce((sum, rail) => sum + (byRail[rail] ?? 0), 0),
  );

  return { byRail, total, unreadableRails, complete: unreadableRails.length === 0, legacyReceivable };
}

/**
 * The one-line provenance string the screens render under a revenue figure, so
 * a reader can tell a partial from a total without opening this file.
 */
export function revenueCoverageNote(revenue: BhcRevenue): string {
  const rails = REVENUE_RAILS.map((r) => REVENUE_RAIL_LABELS[r]).join(' + ');
  const missing = revenue.unreadableRails.length
    ? ` — ${revenue.unreadableRails.map((r) => REVENUE_RAIL_LABELS[r]).join(' + ')} unavailable, so this is a floor`
    : '';
  return `${rails}${missing}`;
}
