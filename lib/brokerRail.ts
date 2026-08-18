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
// Verified against the live schema 2026-08-03.
export const BROKER_FULFILLMENT_STEPS_FIELD = 'Broker Fulfillment Steps'; // multilineText, Ranchers
export const BROKER_ADDITIONAL_COSTS_FIELD = 'Broker Additional Costs';   // multilineText, Ranchers

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

// WEIGHT-PRICED (range) mode — 2026-08-05. Some represented ranches price on
// HANGING WEIGHT ($/lb × carcass weight), so the exact share price does not
// exist until the animal is processed. When a cut's Max field is set AND
// strictly above its Price field, that cut is WEIGHT-PRICED: the Price field is
// the range FLOOR and Max is the ceiling. Max missing, ≤ the floor, or
// malformed → EXACT mode, byte-identical to before these fields existed.
// Verified against the live schema 2026-08-05.
const CUT_PRICE_MAX_FIELD: Record<Cut, string> = {
  quarter: 'Quarter Price Max',
  half: 'Half Price Max',
  whole: 'Whole Price Max',
};

/** Buyer-facing explanation of how the exact balance is determined ($/lb,
 *  typical carcass weights). Rendered wherever a WEIGHT-PRICED cut's money is
 *  shown; never rendered for exact-mode cuts. multilineText, Ranchers. */
export const BROKER_PRICING_NOTE_FIELD = 'Broker Pricing Note';

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

// Per-rancher SELF-SERVE opt-in (2026-08-17). Ben can flip a represented ranch
// publicly promotable: with BOTH `Broker Rail` and this box checked, the
// ranch's public page renders a broker-correct reserve experience and
// /api/checkout/broker-reserve runs the same referral+checkout flow the /r/b
// redemption uses — no operator-minted token.
//
// ROUTABLE SUPPLY (2026-08-17, Ben's call — see isBrokerRoutable below). The
// opt-in now also makes the ranch NORMAL SUPPLY for the matching engine: "it's
// the same concept, I'm just accepting the money and handling the coordination
// myself." A broker ranch WITHOUT this box stays fully invisible — token-only,
// never routed, never campaigned, never counted as coverage.
// Verified against the live schema 2026-08-17.
export const BROKER_SELF_SERVE_FIELD = 'Broker Self Serve'; // checkbox, Ranchers

/** Admin opt-out from every public surface. The slug-resolution formula
 *  (lib/airtable rancherOrProspectBySlugFormula) gates on it unconditionally,
 *  so routing must too — see isBrokerRoutable. Verified live 2026-08-17. */
export const PUBLIC_MAP_HIDDEN_FIELD = 'Public Map Hidden'; // checkbox, Ranchers

/**
 * Is this rancher a SELF-SERVE broker ranch — represented (broker rail) AND
 * explicitly opted in to public promotion?
 *
 * Requires isBrokerRancher: the self-serve box on a NON-broker rancher is a
 * data error and must never relax anything (fail closed in both directions,
 * same strict parse as isBrokerRancher — Airtable omits unchecked boxes and a
 * string 'false' is truthy in JS).
 */
export function isBrokerSelfServe(rancher: any): boolean {
  if (!isBrokerRancher(rancher)) return false;
  const raw = rancher?.[BROKER_SELF_SERVE_FIELD];
  if (raw === true) return true;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}

/** Airtable singleSelect reads come back as a string OR a {name} object. */
function readEnumOrString(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

/**
 * Is this represented ranch REAL, ROUTABLE SUPPLY for the matching engine?
 *
 * THE DECISION (Ben, 2026-08-17): a self-serve broker ranch is normal supply —
 * "it's the same concept, I'm just accepting the money and handling the
 * coordination myself, there's no need for complications." Before this, AZ had
 * zero routable ranches (Gila River is broker-flagged) so AZ buyers fell to the
 * nationwide fallback and were handed to a MONTANA ranch. A broker ranch
 * WITHOUT the self-serve box is phone-only and stays invisible.
 *
 * This is the broker ANALOGUE of the Connect gates in lib/rancherEligibility —
 * NOT a relaxation of them. A represented ranch structurally cannot satisfy
 * Active Status / Agreement Signed / Onboarding Status / Subscription Status /
 * Connect-active (it signed none of that and has no dashboard), so applying
 * those would just re-hide it. What it CAN satisfy, and must:
 *
 *   1. isBrokerSelfServe   — Ben's explicit publish opt-in (implies broker).
 *   2. Verification != Removed — same closed-account belt as the Connect gate.
 *   3. NOT Public Map Hidden — never route to a page that will not resolve:
 *      lib/airtable rancherOrProspectBySlugFormula gates on this
 *      unconditionally, so a hidden ranch's slug 404s.
 *   4. a non-empty Slug — on this rail the reserve surface IS the slug page.
 *      No slug, no way for the matched buyer to pay.
 *   5. at least one cut passing assertBrokerEligible — priced ≥ MIN_TIER_PRICE,
 *      an EXPLICIT per-cut deposit, deposit < price, no Connect footprint. The
 *      exact gate the checkout runs, so a routed buyer can never meet a
 *      refusal at pay time (the broker mirror of the tier_v2 Connect-active
 *      gate, which exists for precisely that reason).
 *
 * FAIL CLOSED like everything else in this file: anything missing → not
 * routable → the ranch keeps its old invisibility.
 */
export function isBrokerRoutable(rancher: any): boolean {
  if (!isBrokerSelfServe(rancher)) return false;
  if (readEnumOrString(rancher?.['Verification Status']) === 'Removed') return false;
  if (rancher?.[PUBLIC_MAP_HIDDEN_FIELD]) return false;
  if (!String(rancher?.['Slug'] || '').trim()) return false;
  return (Object.keys(CUT_LABELS) as Cut[]).some((cut) => assertBrokerEligible(rancher, cut).ok);
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

/**
 * Whole-dollar-friendly money formatting for composed buyer/rancher copy:
 * "$1,050" for round amounts, "$1,799.99" when cents actually exist. NaN-safe.
 */
export function formatUsdCents(cents: number): string {
  const n = Number(cents);
  const safe = Number.isFinite(n) ? Math.round(n) : 0;
  const whole = safe % 100 === 0;
  return `$${(safe / 100).toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * WEIGHT-PRICED composition: when a valid range is passed, the note LEADS with
 * the honest range statement — the buyer must never read a collection
 * instruction that implies an exact balance exists before the hanging weight
 * is known. With no range argument (or a degenerate one) this is byte-identical
 * to the original helper, so every exact-mode caller is untouched.
 */
export function brokerBalanceNote(
  rancher: any,
  range?: { balanceCents: number; balanceMaxCents: number },
): string {
  const note = String(rancher?.[BROKER_BALANCE_NOTE_FIELD] || '').trim() || BROKER_BALANCE_NOTE_FALLBACK;
  if (
    range &&
    Number.isFinite(range.balanceCents) &&
    Number.isFinite(range.balanceMaxCents) &&
    range.balanceMaxCents > range.balanceCents
  ) {
    return (
      `Your final share price is set by hanging weight, so the balance you pay the ranch ` +
      `will land between ${formatUsdCents(range.balanceCents)} and ${formatUsdCents(range.balanceMaxCents)}. ` +
      note
    );
  }
  return note;
}

/**
 * The ranch's own explanation of how the final price is determined ($/lb rate,
 * typical carcass weights). '' when unset — callers render NOTHING in that
 * case (and never render it at all for an exact-priced cut, where there is no
 * weight-based pricing to explain).
 */
export function brokerPricingNote(rancher: any): string {
  return String(rancher?.[BROKER_PRICING_NOTE_FIELD] || '').trim();
}

// ---------------------------------------------------------------------------
// Fulfillment transparency — what happens after the deposit, and what else the
// buyer will be asked to pay
// ---------------------------------------------------------------------------
//
// A represented ranch's process is NOT uniform. Some hand the buyer a box at the
// gate for the balance and nothing else; some sell the animal and hand the buyer
// off to a separate processor who bills the buyer directly for cutting and
// wrapping. That second shape means a real cost the buyer owes to someone who is
// neither the ranch nor BuyHalfCow — and until it is disclosed BEFORE payment,
// the buyer meets it as a surprise bill after they have already committed.
//
// Both fields are per-rancher free text because the shape varies by ranch; both
// are OPTIONAL and blank is the common case. Blank must render NOTHING (not an
// empty heading, not a fallback sentence) — an all-in ranch has no extra steps
// and no extra costs, and inventing copy for one would be its own lie.
//
// UNLIKE brokerBalanceNote these have NO fallback: the balance always exists and
// so always needs an instruction, whereas "there is nothing else to pay" is
// correctly expressed by silence.

/** Hard cap on rendered steps. A checkout page is not a manual; a ranch that
 *  needs more than this should shorten the list rather than have it truncated
 *  mid-story on a phone. */
export const BROKER_FULFILLMENT_STEPS_MAX = 8;

/**
 * The buyer-facing "what happens next" script, one step per line.
 *
 * Returns [] for unset/blank/non-string values so every caller can render with
 * a plain `.length` check. Leading list markers the rancher may have typed
 * ("1.", "2)", "-", "•") are stripped: the surfaces render an ORDERED list, so
 * a hand-typed number would double up as "1. 1. Call the ranch".
 */
export function brokerFulfillmentSteps(rancher: any): string[] {
  const raw = rancher?.[BROKER_FULFILLMENT_STEPS_FIELD];
  if (typeof raw !== 'string') return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-–—*•]|\d{1,2}[.)])\s+/, '').trim())
    .filter(Boolean)
    .slice(0, BROKER_FULFILLMENT_STEPS_MAX);
}

/**
 * Money the buyer pays a THIRD PARTY on top of the share price — a processor's
 * cut-and-wrap bill, a hauler, a locker fee. NOT the ranch balance (that is
 * brokerBalanceNote) and never anything owed to BuyHalfCow.
 *
 * '' means the share price is all-in. Callers MUST treat '' as "render nothing".
 */
export function brokerAdditionalCosts(rancher: any): string {
  return String(rancher?.[BROKER_ADDITIONAL_COSTS_FIELD] || '').trim();
}

// ---------------------------------------------------------------------------
// The quote
// ---------------------------------------------------------------------------

export interface BrokerQuote {
  cut: Cut;
  cutLabel: string;
  /** The rancher's FULL share price — what the buyer ultimately pays in total.
   *  In WEIGHT-PRICED mode this is the range FLOOR (the conservative number:
   *  it is what `Total Sale Amount` is stamped with, so money reads never
   *  overstate a weight-priced sale). */
  priceCents: number;
  /** Collected by BHC now, kept in full. This IS the commission — EXACT in
   *  both modes, entirely unaffected by the final hanging weight. */
  depositCents: number;
  /** price − deposit. Buyer owes this to the RANCH; it is also the rancher's
   *  net. In WEIGHT-PRICED mode this is the LOW end of the balance range. */
  balanceCents: number;
  /** WEIGHT-PRICED (range) mode: true when a valid `<Cut> Price Max` exists
   *  strictly above the floor. The exact share price is set by hanging weight
   *  after processing — no surface may state an exact balance for this cut. */
  weightPriced: boolean;
  /** Range ceiling of the share price. Present ONLY when weightPriced. */
  priceMaxCents?: number;
  /** priceMax − deposit — the HIGH end of the balance range. Present ONLY when
   *  weightPriced. */
  balanceMaxCents?: number;
  /** A `<Cut> Price Max` value existed but was malformed (garbage / negative)
   *  and was treated as absent — the cut sold in EXACT mode. Surfaced so the
   *  operator can see the field needs fixing; never blocks the sale. */
  priceMaxIgnored?: 'malformed';
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

  // ── WEIGHT-PRICED (range) detection — AFTER every refusal gate above, so it
  // can only ever ANNOTATE an already-sellable exact quote, never rescue an
  // unsellable one. The deposit gates (explicit, > 0, strictly < the FLOOR)
  // ran against the floor and are deliberately untouched: the deposit is the
  // commission and nothing about a hanging-weight ceiling may alter it.
  //   • Max set and strictly above the floor → RANGE mode.
  //   • Max missing / blank / ≤ floor        → EXACT mode, silently (a ranch
  //     with no ceiling is the normal case, not an error).
  //   • Max malformed (garbage, negative)    → EXACT mode, noted on the quote
  //     so the operator console can surface the broken field.
  const rawMax = rancher[CUT_PRICE_MAX_FIELD[cut]];
  let weightPriced = false;
  let priceMaxCents = 0;
  let priceMaxIgnored: 'malformed' | undefined;
  if (rawMax !== undefined && rawMax !== null && String(rawMax).trim() !== '') {
    const maxDollars = Number(rawMax);
    if (!Number.isFinite(maxDollars) || maxDollars < 0) {
      priceMaxIgnored = 'malformed';
    } else {
      const maxCents = Math.round(maxDollars * 100);
      if (maxCents > priceCents) {
        weightPriced = true;
        priceMaxCents = maxCents;
      }
    }
  }

  const quote: BrokerQuote = {
    cut,
    cutLabel: CUT_LABELS[cut],
    priceCents,
    depositCents,
    balanceCents: priceCents - depositCents,
    weightPriced,
  };
  // Range fields exist ONLY in range mode — an exact quote keeps the exact
  // shape (pinned by test) so no reader can mistake a collapsed 0 for money.
  if (weightPriced) {
    quote.priceMaxCents = priceMaxCents;
    quote.balanceMaxCents = priceMaxCents - depositCents;
  }
  if (priceMaxIgnored) quote.priceMaxIgnored = priceMaxIgnored;
  return { ok: true, quote };
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
 *
 * WEIGHT-PRICED mode: `metadata.priceCents` carries the range FLOOR (that is
 * what `Total Sale Amount` gets stamped with — conservative, never overstates)
 * and `metadata.priceMaxCents` the ceiling. A missing / malformed / not-above-
 * floor ceiling collapses the range to the exact price (weightPriced=false and
 * max fields == the exact fields), so every exact-mode read is unchanged. The
 * DEPOSIT read is identical in both modes — the commission never varies with
 * the final weight.
 */
export function readBrokerMoney(pi: any): {
  depositCents: number;
  priceCents: number;
  balanceCents: number;
  weightPriced: boolean;
  priceMaxCents: number;
  balanceMaxCents: number;
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
  const rawMax = Number(pi?.metadata?.priceMaxCents);
  const weightPriced = Number.isFinite(rawMax) && Math.round(rawMax) > priceCents;
  const priceMaxCents = weightPriced ? Math.round(rawMax) : priceCents;
  return {
    depositCents,
    priceCents,
    balanceCents: Math.max(0, priceCents - depositCents),
    weightPriced,
    priceMaxCents,
    balanceMaxCents: Math.max(0, priceMaxCents - depositCents),
  };
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
// Guardrails — a broker rancher is INVISIBLE to the platform, with ONE
// deliberate exception
// ---------------------------------------------------------------------------
//
// A represented rancher never signed up, never agreed to onboarding, and has no
// dashboard. By default they must not be routed buyers, listed, mapped, chased
// by an onboarding cron, counted as supply, or emailed a broadcast.
//
// THE EXCEPTION (2026-08-17): a ranch passing isBrokerRoutable — self-serve
// opt-in + a resolvable public page + at least one sellable cut — IS routable
// supply and IS campaignable, because Ben publishes it on purpose. See
// isBrokerRoutable above and lib/rancherEligibility.
//
// The exception is DEMAND-SIDE ONLY. Everything that would touch the RANCH
// stays off for every broker ranch, routable or not: no onboarding/Connect/
// trust crons, no rancher lead emails, no rancher broadcasts, no dashboard
// links. The helpers below are the explicit, greppable belt for that, and they
// deliberately key on isBrokerRancher (ALL broker ranches) — never on
// isBrokerRoutable — because a represented ranch that now receives buyers is
// still a ranch with no login to send anything to.
//
// `Active Status` is left EMPTY at signup, so it can never be the belt: a
// careless admin flip must not change any of this, in either direction.

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
