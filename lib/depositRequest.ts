// lib/depositRequest.ts
//
// Pure decision + validation helpers for rancher-initiated deposit requests
// (POST /api/rancher/referrals/[id]/request-deposit). Extracted so the money
// gates can be unit-tested WITHOUT a live Airtable/Stripe/session — the route
// stays a thin shell that loads records, calls these, then fires side effects.
//
// MONEY SAFETY: every gate here is a hard stop. The route must never create a
// Stripe Checkout Session unless decideDepositRequest returns { ok: true }.

// Hermetic import — lib/brokerRail imports only lib/pricing, so no cycle.
import { isBrokerRancher } from '@/lib/brokerRail';

export type CutTier = 'Quarter' | 'Half' | 'Whole';

// $25 floor — a deposit below this isn't worth the Stripe processing + makes a
// "lock your slot" ask look unserious. Stripe itself requires > $0.50.
export const MIN_DEPOSIT_CENTS = 2_500; // $25
// $25k ceiling — mirrors the typo guard on lib/stripe-commission.ts +
// send-final-invoice. A deposit larger than this is almost certainly a
// fat-fingered amount; block it rather than charge a buyer thousands by mistake.
export const MAX_DEPOSIT_CENTS = 2_500_000; // $25k

export const CUT_TIERS: readonly CutTier[] = ['Quarter', 'Half', 'Whole'] as const;

export function isCutTier(v: unknown): v is CutTier {
  return typeof v === 'string' && (CUT_TIERS as readonly string[]).includes(v);
}

/** Airtable field name holding the LISTED full sale price for a cut. */
export function priceFieldForCut(cut: CutTier): 'Quarter Price' | 'Half Price' | 'Whole Price' {
  return cut === 'Quarter' ? 'Quarter Price' : cut === 'Half' ? 'Half Price' : 'Whole Price';
}

/** Airtable field name holding the suggested DEPOSIT amount for a cut. */
export function depositFieldForCut(cut: CutTier): 'Quarter Deposit' | 'Half Deposit' | 'Whole Deposit' {
  return cut === 'Quarter' ? 'Quarter Deposit' : cut === 'Half' ? 'Half Deposit' : 'Whole Deposit';
}

export interface DepositRequestInput {
  /** Rancher id from the SESSION — never from the request body. */
  sessionRancherId: string;
  /** Linked rancher ids on the referral (Rancher OR Suggested Rancher). */
  referralLinkedRancherIds: string[];
  /** Rancher record fields (pricing model, connect status/acct, cut prices). */
  rancher: Record<string, any>;
  cut: CutTier;
  /**
   * Rancher's chosen deposit in DOLLARS. Optional — if omitted/blank the cut's
   * saved {cut} Deposit field is used (falling back to the full price when no
   * separate deposit is configured).
   */
  depositAmountDollars?: number | null;
}

export interface DepositRequestDecision {
  cut: CutTier;
  fullSaleDollars: number;
  fullSaleCents: number;
  depositDollars: number;
  depositCents: number;
}

export type DepositRequestResult =
  | { ok: true; decision: DepositRequestDecision }
  | { ok: false; status: 400 | 403 | 422; error: string };

/**
 * The whole money gate, as a pure function. Order matters: ownership first
 * (403), then eligibility (422), then per-cut pricing + amount validation (422
 * for config, 400 for a bad caller amount).
 */
export function decideDepositRequest(input: DepositRequestInput): DepositRequestResult {
  // 1. OWNERSHIP — the referral must be linked to the SESSION rancher.
  if (!input.sessionRancherId) {
    return { ok: false, status: 403, error: 'No rancher session' };
  }
  if (!input.referralLinkedRancherIds.includes(input.sessionRancherId)) {
    return { ok: false, status: 403, error: 'This referral does not belong to you' };
  }

  // 2. ELIGIBILITY — tier_v2 + Connect active + Connect acct present. Legacy or
  //    non-active ranchers cannot take card deposits through BHC; they close
  //    off-platform. Reject rather than create an un-chargeable session.
  //
  //    RAIL-MATRIX belt (2026-08-04): a rancher flagged `Broker Rail` is
  //    refused OUTRIGHT, even with a full Connect footprint (the dual-flag /
  //    ambiguous case). The Connect deposit route now refuses that rancher at
  //    pay time; refusing here too means the buyer is never emailed a link
  //    that bounces. Same fail-closed answer as referralRailForRancher.
  if (isBrokerRancher(input.rancher)) {
    return {
      ok: false,
      status: 422,
      error: 'this account is set up as a represented ranch — deposits for it are handled by BuyHalfCow directly',
    };
  }
  const pricingModel = String(input.rancher['Pricing Model'] || '').toLowerCase();
  if (pricingModel !== 'tier_v2') {
    return {
      ok: false,
      status: 422,
      error: 'deposit requests are only available on the tier_v2 plan',
    };
  }
  const connectStatus = String(input.rancher['Stripe Connect Status'] || '').toLowerCase();
  const connectAcct = String(input.rancher['Stripe Connect Account Id'] || '').trim();
  if (!connectAcct) {
    return {
      ok: false,
      status: 422,
      error: 'connect your stripe account before requesting deposits',
    };
  }
  if (connectStatus !== 'active') {
    return {
      ok: false,
      status: 422,
      error: `your stripe connect status is "${connectStatus || 'unknown'}" — finish onboarding before requesting deposits`,
    };
  }

  // 3. PRICING — the chosen cut must have a saved full price. Without it the
  //    buyer's deposit link would 409 (dead link) downstream, so refuse here.
  const fullSaleDollars = Number(input.rancher[priceFieldForCut(input.cut)] || 0);
  if (!isFinite(fullSaleDollars) || fullSaleDollars <= 0) {
    return {
      ok: false,
      status: 422,
      error: `no price set for ${input.cut.toLowerCase()} — set it on your page before requesting a deposit`,
    };
  }
  const fullSaleCents = Math.round(fullSaleDollars * 100);

  // 4. DEPOSIT AMOUNT — caller-supplied wins; else the cut's saved deposit;
  //    else the full price (deposit == full sale). Then enforce floor/ceiling
  //    and never let a deposit exceed the full sale price for the cut.
  const savedDeposit = Number(input.rancher[depositFieldForCut(input.cut)] || 0);
  let depositDollars: number;
  if (
    typeof input.depositAmountDollars === 'number' &&
    isFinite(input.depositAmountDollars) &&
    input.depositAmountDollars > 0
  ) {
    depositDollars = input.depositAmountDollars;
  } else if (input.depositAmountDollars != null) {
    // Explicit but non-positive (0, NaN, negative) → caller error.
    return { ok: false, status: 400, error: 'deposit amount must be a positive number' };
  } else {
    depositDollars = savedDeposit > 0 ? savedDeposit : fullSaleDollars;
  }

  const depositCents = Math.round(depositDollars * 100);
  if (depositCents < MIN_DEPOSIT_CENTS) {
    return {
      ok: false,
      status: 400,
      error: `deposit must be at least $${(MIN_DEPOSIT_CENTS / 100).toFixed(0)}`,
    };
  }
  if (depositCents > MAX_DEPOSIT_CENTS) {
    return {
      ok: false,
      status: 400,
      error: `deposit exceeds the $${(MAX_DEPOSIT_CENTS / 100).toLocaleString()} ceiling — looks like a typo`,
    };
  }
  if (depositCents > fullSaleCents) {
    return {
      ok: false,
      status: 400,
      error: `deposit ($${depositDollars.toFixed(0)}) can't exceed the full ${input.cut.toLowerCase()} price ($${fullSaleDollars.toFixed(0)})`,
    };
  }

  return {
    ok: true,
    decision: { cut: input.cut, fullSaleDollars, fullSaleCents, depositDollars, depositCents },
  };
}

// ── Email-truth outcome (GO-LIVE MONEY HARDENING finding 3, 2026-07-02) ─────
//
// guardedSend (lib/email.ts) returns { success:false, suppressed:true }
// WITHOUT throwing for bounced/unsubscribed recipients. The request-deposit
// route used to ignore the return value and answer ok:true — the rancher
// believed the buyer was emailed when nothing went out. This pure helper
// collapses a guardedSend-shaped result (or its absence, when the send threw)
// into the honest { emailSent, suppressed, reason } that rides the route
// response and drives the rancher UI's "share the link directly" fallback.
//
// Strict `=== true` checks: a truthy-but-not-boolean flag must never report
// an email as sent. Decision table pinned in
// lib/depositRequest.emailOutcome.test.ts.

export interface DepositEmailOutcome {
  emailSent: boolean;
  suppressed: boolean;
  reason?: string;
}

export function depositEmailOutcome(
  result: { success?: boolean; suppressed?: boolean; reason?: string } | null | undefined,
): DepositEmailOutcome {
  if (result?.success === true) return { emailSent: true, suppressed: false };
  return {
    emailSent: false,
    suppressed: result?.suppressed === true,
    reason: result?.reason,
  };
}
