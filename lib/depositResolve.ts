// lib/depositResolve.ts — THE single deposit resolution for the CONNECT rail.
//
// P0 (2026-08-18): the deposit page displayed a different number than the card
// was charged. Two independent implementations of "what is the deposit for this
// cut" had drifted:
//
//   • POST /api/checkout/deposit (the CHARGE) honored a rancher's custom quote
//     on the referral (`Deposit Amount` + `Order Type` + `Deposit Requested At`).
//   • GET /api/checkout/deposit → buildCut (the RENDER) never read the referral
//     for money at all — it called depositDisplay(price, rancher's stored
//     per-cut deposit, rate) and so quoted the per-cut DEFAULT.
//
//   Live case: Silverline Quarter — price $1,950, stored deposit $500, rancher
//   quoted $600, locked rate 10%. Page rendered $695.00; card was charged
//   $795.00. Five live payable referrals were sitting in that state while an
//   hourly nudge cron drove buyers at the page. The last screen before the card
//   is hit is the one surface that may never lie.
//
// The fix is structural, not a patch: BOTH paths now call resolveDepositMoney
// here, so the displayed total and the charged total cannot diverge again —
// there is only one number.
//
// SCOPE — CONNECT RAIL ONLY. This module encodes the Connect money model:
// the rancher keeps 100% of the price and BHC's commission is ADDED ON TOP for
// the buyer, charged as one payment at deposit time. The BROKER rail is a
// different model entirely (flat deposit that IS the whole commission, nothing
// added on top, never derived) and lives in lib/brokerRail.ts —
// assertBrokerEligible. Do not route broker money through here.
//
// PURE: no I/O, no Airtable, no Stripe. Callers hand in the already-fetched
// referral + rancher records. Imports only lib/pricing (which imports nothing),
// so both the GET render path and the POST charge path can use it with no cycle.

import { deriveDeposit, type DepositDisplay } from './pricing';

export type DepositCut = 'quarter' | 'half' | 'whole';

/** Rancher per-cut price fields (dollars). */
export const CUT_PRICE_FIELD: Record<DepositCut, string> = {
  quarter: 'Quarter Price',
  half: 'Half Price',
  whole: 'Whole Price',
};

/** Rancher per-cut stored deposit fields (dollars). */
export const CUT_DEPOSIT_FIELD: Record<DepositCut, string> = {
  quarter: 'Quarter Deposit',
  half: 'Half Deposit',
  whole: 'Whole Deposit',
};

/**
 * Which rung of the precedence ladder produced the deposit. Surfaced for
 * operator/debug logging and pinned in tests — never rendered to a buyer
 * (the buyer sees ONE number; see the fee-invisible directive in lib/pricing).
 */
export type DepositSource = 'rancher-quote' | 'stored' | 'derived';

export interface ResolvedDeposit {
  /** Deposit in WHOLE DOLLARS (the rancher's portion — fee is added on top). */
  depositDollars: number;
  source: DepositSource;
}

/**
 * Is the referral's `Deposit Amount` genuinely a live rancher quote for THIS
 * cut? Three conditions, all required — this is the guard that keeps a stale or
 * unrelated number off the charge:
 *
 *   1. `Order Type` matches the cut being priced. The referral carries exactly
 *      one quoted cut; the deposit page lists all three. A $600 Quarter quote
 *      must not follow a buyer who switches to Half.
 *   2. `Deposit Requested At` is stamped. That stamp is what makes the quote an
 *      ASK — request-deposit (rancher) and send-deposit-invoice (admin) write
 *      `Order Type` + `Deposit Amount` + `Deposit Requested At` together. A
 *      `Deposit Amount` with no stamp is residue from another writer, not a
 *      quote anyone made to this buyer.
 *
 * `Order Type` is compared case-insensitively: the request writers stamp
 * 'Quarter' | 'Half' | 'Whole' while the cut slug is lowercase.
 */
export function referralQuotesCut(referral: any, cut: DepositCut): boolean {
  const orderType = String(referral?.['Order Type'] ?? '').trim().toLowerCase();
  const requestedAt = String(referral?.['Deposit Requested At'] ?? '').trim();
  return orderType === cut && requestedAt !== '';
}

/**
 * Resolve the deposit (dollars) for one cut. THE precedence, in order:
 *
 *   1. RANCHER QUOTE — `referral['Deposit Amount']`, but only when the quote is
 *      genuinely for this cut and this ask (referralQuotesCut) and it is within
 *      the same bounds every other rung respects: 0 < quote ≤ price. This rung
 *      exists because the custom ask IS the feature: a rancher who says "$600
 *      to hold your quarter" has quoted the buyer that number by email, and the
 *      buyer must see and be charged exactly it.
 *   2. STORED PER-CUT DEPOSIT — `rancher['<Cut> Deposit']`, same 0 < dep ≤ price
 *      bounds. The rancher's standing default when they made no custom ask.
 *   3. DERIVED — deriveDeposit(price), the standard ~25% reserve floored at
 *      DEPOSIT_MIN and capped strictly below price. An un-backfilled rancher
 *      charges a true partial reserve, never 100% of the price.
 *
 * Bounds are identical on every rung on purpose: a quote above the full price
 * would make the "balance due at pickup" negative and defeat the reserve model,
 * so an out-of-bounds quote falls THROUGH to the stored/derived rungs rather
 * than being charged.
 *
 * Returns null when the cut has no usable price — the caller decides whether
 * that is a 409 (charge path) or a hidden cut (render path).
 */
export function resolveDepositDollars(
  referral: any,
  rancher: any,
  cut: DepositCut,
): ResolvedDeposit | null {
  const price = Number(rancher?.[CUT_PRICE_FIELD[cut]]);
  if (!Number.isFinite(price) || price <= 0) return null;

  // 1 — the rancher's own quote for this exact ask.
  const quoted = Number(referral?.['Deposit Amount']);
  if (referralQuotesCut(referral, cut) && Number.isFinite(quoted) && quoted > 0 && quoted <= price) {
    return { depositDollars: quoted, source: 'rancher-quote' };
  }

  // 2 — the rancher's standing per-cut deposit.
  const stored = Number(rancher?.[CUT_DEPOSIT_FIELD[cut]]);
  if (Number.isFinite(stored) && stored > 0 && stored <= price) {
    return { depositDollars: stored, source: 'stored' };
  }

  // 3 — the standard derived reserve.
  return { depositDollars: deriveDeposit(price), source: 'derived' };
}

export interface ResolvedDepositMoney extends DepositDisplay {
  /** The resolved deposit in whole dollars, before the cents conversion. */
  depositDollars: number;
  /** Full sale price in cents — the base the BHC commission is computed on. */
  fullCents: number;
  /** Which precedence rung produced depositDollars. */
  source: DepositSource;
}

/**
 * The ONE money shape for a Connect deposit. `dueNowCents` is simultaneously:
 *   • what the deposit page renders as "due today", and
 *   • what Stripe charges the card (amountCents + gross application fee).
 *
 * The arithmetic mirrors POST /api/checkout/deposit exactly, INCLUDING the
 * rounding ORDER — cents first, then rate:
 *     fullCents  = round(price × 100)
 *     feeCents   = round(fullCents × commissionRate)
 * Rounding the other way (dollars × rate, then ×100) drifts by a cent on
 * cents-bearing prices, and a cent of drift at the card is still a lie.
 *
 * NOTE on net-your-number (lib/feeMath absorbStripeFee): the charge path
 * absorbs the Stripe processing estimate out of the APPLICATION FEE so the
 * rancher nets their full deposit. That absorption changes only the platform/
 * rancher SPLIT of an unchanged buyer total — `totalChargedCents` is computed
 * from the GROSS fee, before absorption. So dueNowCents here is the buyer's
 * total on both sides, and no absorption belongs in this helper.
 *
 * Returns null when the cut has no usable price.
 */
export function resolveDepositMoney(
  referral: any,
  rancher: any,
  cut: DepositCut,
  commissionRate: number,
): ResolvedDepositMoney | null {
  const price = Number(rancher?.[CUT_PRICE_FIELD[cut]]);
  if (!Number.isFinite(price) || price <= 0) return null;
  const resolved = resolveDepositDollars(referral, rancher, cut);
  if (!resolved) return null;

  const fullCents = Math.round(price * 100);
  const depositCents = Math.round(resolved.depositDollars * 100);
  const feeCents = Math.round(fullCents * commissionRate);
  return {
    depositDollars: resolved.depositDollars,
    fullCents,
    depositCents,
    feeCents,
    dueNowCents: depositCents + feeCents,
    balanceCents: fullCents - depositCents,
    source: resolved.source,
  };
}
