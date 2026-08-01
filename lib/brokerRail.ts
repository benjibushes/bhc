// BROKER RAIL — pure decision logic. THE THIRD MONEY MODEL.
//
// Read docs/BUSINESS-MODEL.md before changing anything here. This rail is NOT
// Stripe Connect and must never be "fixed" into it.
//
// WHAT IT IS
// ----------
// Ben represents a rancher who is on NOTHING: no Stripe Connect account, no
// marketplace listing, no onboarding wizard, no login. Ben sells that rancher's
// beef himself, by phone, and sends a link.
//
// The buyer pays a deposit that goes 100% to BHC's OWN Stripe account. That
// deposit IS Ben's entire commission. There is no `application_fee_amount`, no
// `transfer_data`, no `stripeAccount` header, no split of any kind — a plain
// Checkout Session on the platform account (see lib/brokerCheckout.ts).
//
// THE MONEY (Ben's decision, 2026-07-31 — deliberate, do not "correct" it)
// ----------------------------------------------------------------------
//   buyer total   = the rancher's full share price      (UNCHANGED vs buying direct)
//   buyer pays us = deposit                              (BHC keeps 100%)
//   buyer pays ranch = price − deposit                   (direct, outside BHC)
//   rancher nets  = price − deposit                      (he funds the commission
//                                                         out of his own price)
//
// So `deposit` is simultaneously (a) the buyer's deposit toward the share and
// (b) BHC's whole fee. Those are the same dollars viewed from two sides, which
// is why the two settlement emails say DIFFERENT true things:
//   • the rancher is told plainly the deposit was BHC's commission and he nets
//     price − deposit. He agrees to this at signup (/partner/represent) — it is
//     never a surprise at order time.
//   • the buyer is told "deposit toward your share, balance paid to the ranch".
//     The buyer's total is identical either way, so the split is not their
//     business and BHC keeping it is never mentioned.
//
// CONTRAST WITH THE OTHER TWO RAILS (never reuse their helpers here):
//   • share deposit  — app/api/checkout/deposit + lib/stripeConnect
//     createDepositCheckout: Connect DIRECT charge on the RANCHER's account
//     with application_fee_amount. Buyer pays deposit + 10% ON TOP; the
//     rancher keeps 100% of his price.
//   • product markup — lib/productCheckout: Connect direct charge +
//     application_fee on the rancher's account.
// Both require `Stripe Connect Account Id`. The broker rail REFUSES a rancher
// who has one — that rancher belongs on the Connect rail and charging him here
// would double-bill (Connect fee AND the deposit-as-commission).
//
// FAIL CLOSED. Every predicate below answers "no" on missing/ambiguous data.

// HERMETIC BY CONSTRUCTION — imports lib/pricing (which imports nothing) and
// NOTHING ELSE. lib/rancherEligibility imports this module for the routing
// guardrail, and lib/reserveDeposit imports rancherEligibility, so importing
// reserveDeposit's CUT_LABELS here would close an import cycle
// (brokerRail → reserveDeposit → rancherEligibility → brokerRail). The cut
// union + labels are therefore restated below rather than imported — the same
// hermeticity trade lib/reserveDeposit itself makes for hasValidTier and
// normalizeReservePhone. Keep these two in sync with lib/reserveDeposit; the
// unit test pins them to identical values.
import { MIN_TIER_PRICE } from '@/lib/pricing';

export type Cut = 'quarter' | 'half' | 'whole';

export const CUT_LABELS: Record<Cut, string> = {
  quarter: 'Quarter Cow',
  half: 'Half Cow',
  whole: 'Whole Cow',
};

// Airtable field names — declared once so nothing in the rail guesses (repo
// hard rule #1). Verified against the live schema 2026-07-31.
export const BROKER_RAIL_FIELD = 'Broker Rail';               // checkbox, Ranchers
export const BROKER_BALANCE_NOTE_FIELD = 'Broker Balance Note'; // multilineText, Ranchers

const CUT_PRICE_FIELD: Record<Cut, string> = {
  quarter: 'Quarter Price',
  half: 'Half Price',
  whole: 'Whole Price',
};

const CUT_DEPOSIT_FIELD: Record<Cut, string> = {
  quarter: 'Quarter Deposit',
  half: 'Half Deposit',
  whole: 'Whole Deposit',
};

/**
 * The `Match Type` value stamped on a broker referral.
 *
 * Contains the substring "Deposit" ON PURPOSE: lib/campaignReferral's reuse
 * filter (`matchType.includes('Deposit')`) only recycles deposit-intent
 * referrals, and a broker referral must be recyclable the same way so a
 * re-tapped link doesn't spawn duplicates.
 *
 * Written with Airtable typecast (the choice is not in the singleSelect's
 * schema list) — the same way 'Direct (Rancher Page) — Deposit' and 'Manual'
 * already are. It is a REPORTING marker, not the rail's source of truth: the
 * authoritative rail signal is the rancher's `Broker Rail` checkbox at mint
 * time and `metadata.rail === 'broker'` (Stripe-held, tamper-proof) at
 * settlement. A typecast strip therefore costs a label, never money.
 */
export const BROKER_MATCH_TYPE = 'Broker — Deposit';

/** The `rail` value stamped into Stripe metadata. Settlement branches on it. */
export const BROKER_RAIL_METADATA_VALUE = 'broker';

/** Payments.Type value for a broker-rail ledger row. */
export const BROKER_PAYMENT_TYPE = 'broker_deposit';

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Is this rancher REPRESENTED (broker rail) rather than onboarded?
 *
 * Strict truthiness on the Airtable checkbox. Airtable omits the key entirely
 * when unchecked, so undefined → false. A string 'false' would be truthy in
 * JS, so it is explicitly rejected — a broker rancher is invisible to the
 * platform (see the guardrails in lib/rancherEligibility + the marketplace /
 * map / cron filters), and mis-reading one as broker would hide a real rancher
 * while mis-reading one as NOT broker would expose a represented one. Both
 * directions matter, so parse exactly.
 */
export function isBrokerRancher(rancher: any): boolean {
  const raw = rancher?.[BROKER_RAIL_FIELD];
  if (raw === true) return true;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}

/**
 * Does this rancher have ANY Stripe Connect footprint?
 *
 * Deliberately broad — an account id, a non-empty status, or the tier_v2
 * pricing model all count. The broker rail refuses such a rancher outright:
 * they belong on the Connect rail, and taking a broker deposit for them would
 * bill the buyer BHC's commission twice (once as the Connect application_fee,
 * once as the whole broker deposit) or route money to the wrong account.
 */
export function rancherHasConnectAccount(rancher: any): boolean {
  const acct = String(rancher?.['Stripe Connect Account Id'] || '').trim();
  if (acct) return true;
  const status = String(rancher?.['Stripe Connect Status'] || '').trim().toLowerCase();
  if (status && status !== 'none') return true;
  const model = String(rancher?.['Pricing Model'] || '').trim().toLowerCase();
  return model === 'tier_v2';
}

/**
 * The rancher's own instruction for how the buyer pays him the remainder
 * ("cash or check at pickup", "Venmo @…", "invoice on delivery"). Shown to the
 * buyer on the receipt and echoed back to the rancher.
 *
 * Falls back to honest generic copy rather than an empty line — the buyer must
 * always leave the receipt knowing the balance is settled with the RANCH.
 */
export const BROKER_BALANCE_NOTE_FALLBACK =
  'The ranch will tell you how to pay the balance when they contact you about pickup or delivery.';

export function brokerBalanceNote(rancher: any): string {
  const note = String(rancher?.[BROKER_BALANCE_NOTE_FIELD] || '').trim();
  return note || BROKER_BALANCE_NOTE_FALLBACK;
}

// ---------------------------------------------------------------------------
// The quote
// ---------------------------------------------------------------------------

export interface BrokerQuote {
  cut: Cut;
  cutLabel: string;
  /** The rancher's FULL share price — what the buyer ultimately pays in total. */
  priceCents: number;
  /** Collected by BHC now, kept in full. This IS the commission. */
  depositCents: number;
  /** price − deposit. Buyer owes this to the RANCH; it is also the rancher's net. */
  balanceCents: number;
}

export type BrokerEligibility =
  | { ok: true; quote: BrokerQuote }
  | { ok: false; status: number; code: string; error: string };

/**
 * Gate a broker checkout. Pure — the route does the Airtable I/O and hands the
 * already-fetched rancher record here.
 *
 * Every gate refuses rather than guesses. In particular the deposit is NEVER
 * derived (unlike the Connect rail, which falls back to deriveDeposit at 25%):
 * on this rail the deposit IS the commission, so inventing one would invent
 * Ben's fee and silently change what the rancher nets. Ben sets it per cut, or
 * the cut is not sellable on this rail.
 */
export function assertBrokerEligible(rancher: any, cut: Cut): BrokerEligibility {
  if (!CUT_LABELS[cut]) {
    return { ok: false, status: 400, code: 'bad_cut', error: 'cut must be quarter|half|whole' };
  }
  if (!rancher) {
    return { ok: false, status: 404, code: 'rancher_not_found', error: 'Rancher not found' };
  }

  // GATE 1 — represented, not onboarded.
  if (!isBrokerRancher(rancher)) {
    return {
      ok: false,
      status: 409,
      code: 'not_broker_rail',
      error: 'This ranch is not on the represented-seller rail.',
    };
  }

  // GATE 2 — hard refusal for anyone with a Connect footprint. Double-billing
  // risk is real: a Connect rancher's buyer already pays BHC's fee on top via
  // application_fee, and a broker deposit would ALSO be kept in full by BHC.
  if (rancherHasConnectAccount(rancher)) {
    return {
      ok: false,
      status: 409,
      code: 'connect_rancher',
      error: 'This ranch is set up on Stripe Connect and cannot be sold on the broker rail.',
    };
  }

  // GATE 3 — the cut must be priced.
  const priceDollars = Number(rancher[CUT_PRICE_FIELD[cut]]);
  if (!Number.isFinite(priceDollars) || priceDollars <= 0) {
    return {
      ok: false,
      status: 409,
      code: 'cut_unpriced',
      error: `No ${CUT_LABELS[cut]} price is set for this ranch.`,
    };
  }
  // Per-lb mis-entry floor — same guard the Connect charge path uses. A "$7.40
  // whole cow" is a per-pound number typed into a total field; refuse to charge.
  if (priceDollars < MIN_TIER_PRICE) {
    return {
      ok: false,
      status: 409,
      code: 'price_implausible',
      error: `${CUT_LABELS[cut]} pricing looks misconfigured — check the price before selling.`,
    };
  }

  // GATE 4 — the cut must have an explicit deposit. Never derived: see above.
  const depositDollars = Number(rancher[CUT_DEPOSIT_FIELD[cut]]);
  if (!Number.isFinite(depositDollars) || depositDollars <= 0) {
    return {
      ok: false,
      status: 409,
      code: 'no_deposit',
      error: `No ${CUT_LABELS[cut]} deposit is set for this ranch — set it before selling.`,
    };
  }

  // GATE 5 — deposit MUST be strictly less than price. A deposit >= price is a
  // configuration error, not a 100%-upfront sale: it would leave the rancher a
  // zero (or negative) net while the buyer thinks a balance is still coming.
  // Refuse rather than clamp — clamping would silently pick a number nobody set.
  if (depositDollars >= priceDollars) {
    return {
      ok: false,
      status: 409,
      code: 'deposit_exceeds_price',
      error: `${CUT_LABELS[cut]} deposit ($${depositDollars}) is not less than the price ($${priceDollars}) — fix the pricing before selling.`,
    };
  }

  const priceCents = Math.round(priceDollars * 100);
  const depositCents = Math.round(depositDollars * 100);
  return {
    ok: true,
    quote: {
      cut,
      cutLabel: CUT_LABELS[cut],
      priceCents,
      depositCents,
      balanceCents: priceCents - depositCents,
    },
  };
}

// ---------------------------------------------------------------------------
// Rail identification at settlement — FAIL CLOSED
// ---------------------------------------------------------------------------

/**
 * Is this Stripe object's metadata a BROKER-rail deposit?
 *
 * The ONLY trusted rail signal at settlement time. Stripe holds this metadata;
 * it was written by lib/brokerCheckout at session-create and cannot be edited
 * by a buyer. Requires an EXACT `rail === 'broker'` match — anything else
 * (absent, blank, 'Broker', 'broker ', a Connect deposit's metadata) is NOT
 * this rail and must fall through to the existing handlers.
 */
export function isBrokerRailMetadata(metadata: any): boolean {
  return metadata?.rail === BROKER_RAIL_METADATA_VALUE;
}

/**
 * Pure money read from a settled broker PaymentIntent (or Checkout Session).
 *
 * Lives HERE rather than in lib/brokerSettlement so it is unit-testable without
 * prod env — importing the settlement module drags in lib/email → lib/secrets,
 * which throws at module load in a bare environment. Same hermetic split as
 * classifyConnectStatus vs lib/stripeConnect. Re-exported from brokerSettlement
 * so callers keep one import site.
 *
 * `amount` (what Stripe actually charged) is authoritative for the deposit, so
 * a drifting or malicious metadata value can never record more collected than
 * was taken. The price exists only in metadata (Stripe never sees it) and is
 * floored at the deposit so the balance can never go negative.
 */
export function readBrokerMoney(pi: any): {
  depositCents: number;
  priceCents: number;
  balanceCents: number;
} {
  const charged = Math.max(0, Math.round(Number(pi?.amount ?? pi?.amount_total ?? 0) || 0));
  const rawDeposit = Number(pi?.metadata?.depositCents);
  const depositCents =
    Number.isFinite(rawDeposit) && rawDeposit > 0
      ? Math.min(Math.round(rawDeposit), charged || Math.round(rawDeposit))
      : charged;
  const rawPrice = Number(pi?.metadata?.priceCents);
  const priceCents =
    Number.isFinite(rawPrice) && rawPrice > depositCents ? Math.round(rawPrice) : depositCents;
  return { depositCents, priceCents, balanceCents: Math.max(0, priceCents - depositCents) };
}

/**
 * Fail-closed rail check for a REFERRAL about to be charged, given the rancher
 * it is pinned to.
 *
 * Returns 'broker' only when the rancher is unambiguously represented AND has
 * no Connect footprint; 'connect' when they have a Connect footprint and are
 * not flagged broker; and 'ambiguous' for the contradictory case (BOTH broker
 * and Connect) or an unreadable rancher. Callers MUST refuse on 'ambiguous' —
 * that is a data error a human resolves, never a coin flip with money.
 */
// ---------------------------------------------------------------------------
// Guardrails — a broker rancher is INVISIBLE to the platform
// ---------------------------------------------------------------------------
//
// A represented rancher never signed up, never agreed to onboarding, and has no
// public page. They must not be routed buyers, listed, mapped, chased by an
// onboarding cron, counted as supply, or emailed a broadcast.
//
// `Active Status` is left EMPTY at signup, which already blocks routing — but
// that is ONE field one careless admin flip away from exposing them. These two
// helpers are the explicit, greppable belt.

/** Airtable filterByFormula fragment. AND() this into any Ranchers query that
 *  feeds a public / marketplace / SEO surface. */
export const BROKER_RAIL_EXCLUSION_FORMULA = 'NOT({Broker Rail} = 1)';

/** Drop represented ranchers from an already-fetched list. Use immediately at
 *  the read boundary of any cron that scans the Ranchers table. */
export function excludeBrokerRanchers<T>(rows: T[]): T[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => !isBrokerRancher(r));
}

export function referralRailForRancher(rancher: any): 'broker' | 'connect' | 'ambiguous' {
  if (!rancher) return 'ambiguous';
  const broker = isBrokerRancher(rancher);
  const connect = rancherHasConnectAccount(rancher);
  if (broker && connect) return 'ambiguous';
  if (broker) return 'broker';
  return 'connect';
}
