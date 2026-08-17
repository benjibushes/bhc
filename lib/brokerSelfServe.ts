// BROKER SELF-SERVE — pure view model + gates for the public reserve surface.
//
// A represented (broker rail) ranch is invisible to the platform by design;
// deposits normally happen only via operator-minted /r/b/<token> links. The
// per-rancher `Broker Self Serve` checkbox (see lib/brokerRail
// BROKER_SELF_SERVE_FIELD) opts ONE ranch into public promotion: its page
// renders a broker-correct pricing/reserve experience and
// POST /api/checkout/broker-reserve runs the same referral+checkout flow the
// /r/b redemption uses — no token, the buyer self-serves.
//
// Everything here is PURE and hermetic (imports lib/brokerRail only) so the
// page's cut cards and the route's gate are unit-testable without Airtable.
// All money decisions delegate to assertBrokerEligible — nothing in this file
// re-derives a price, a deposit, or a range (drift between this surface and
// the /r/b redemption gate is how you publish a card that bounces at pay).
//
// COPY CONTRACT (docs/BUSINESS-MODEL.md model 3): the deposit is "toward your
// share"; the balance is "paid to the ranch". Buyer-facing copy NEVER says
// commission or fee, and never borrows Connect-rail language — on this rail
// nothing is added on top and the split is not the buyer's transaction.

import {
  assertBrokerEligible,
  isBrokerSelfServe,
  brokerBalanceNote,
  brokerPricingNote,
  brokerFulfillmentSteps,
  brokerAdditionalCosts,
  type BrokerEligibility,
  type Cut,
} from '@/lib/brokerRail';

export const BROKER_CUTS: Cut[] = ['quarter', 'half', 'whole'];

/**
 * One sellable cut, shaped for the public page's cards. Mirrors the broker
 * checkout GET projection (buildBrokerCheckoutInfo): EXACT-mode cuts keep the
 * exact key set; WEIGHT-PRICED cuts additionally carry the range ceilings and
 * the page must say "estimated $floor–$max", never an exact total or balance.
 * The deposit is EXACT in both modes.
 */
export interface BrokerCutCard {
  cut: Cut;
  label: string;
  /** Full share price — the range FLOOR when weightPriced. */
  priceCents: number;
  /** Deposit due today — exact in both pricing modes. */
  depositCents: number;
  /** price − deposit, owed to the RANCH — the range LOW end when weightPriced. */
  balanceCents: number;
  weightPriced?: true;
  priceMaxCents?: number;
  balanceMaxCents?: number;
}

/**
 * Every cut this ranch can actually sell on the broker rail, via the SAME
 * gate the /r/b redemption + checkout run (assertBrokerEligible). A cut that
 * fails any money gate simply doesn't render — fail closed, never a card the
 * checkout would refuse.
 */
export function brokerSelfServeCutCards(rancher: any): BrokerCutCard[] {
  const cards: BrokerCutCard[] = [];
  for (const cut of BROKER_CUTS) {
    const gate = assertBrokerEligible(rancher, cut);
    if (!gate.ok) continue;
    const q = gate.quote;
    const card: BrokerCutCard = {
      cut,
      label: q.cutLabel,
      priceCents: q.priceCents,
      depositCents: q.depositCents,
      balanceCents: q.balanceCents,
    };
    if (q.weightPriced && q.priceMaxCents && q.balanceMaxCents !== undefined) {
      card.weightPriced = true;
      card.priceMaxCents = q.priceMaxCents;
      card.balanceMaxCents = q.balanceMaxCents;
    }
    cards.push(card);
  }
  return cards;
}

/** Everything the public page's broker reserve section renders. */
export interface BrokerSelfServeView {
  cards: BrokerCutCard[];
  /** How/when the balance is paid to the ranch (fallback copy when unset). */
  balanceNote: string;
  /** How the exact balance is determined — '' unless a weight-priced cut
   *  exists (never rendered for exact-mode ranches). */
  pricingNote: string;
  /** Buyer-facing next steps, one per entry. [] = render nothing. */
  fulfillmentSteps: string[];
  /** Third-party cost (e.g. butcher fee). '' = render nothing. */
  additionalCosts: string;
}

export function buildBrokerSelfServeView(rancher: any): BrokerSelfServeView {
  const cards = brokerSelfServeCutCards(rancher);
  return {
    cards,
    balanceNote: brokerBalanceNote(rancher),
    // Same rule as the checkout projection: the $/lb explanation renders only
    // where weight-priced money is shown — an exact-mode ranch has no
    // weight-based pricing to explain.
    pricingNote: cards.some((c) => c.weightPriced) ? brokerPricingNote(rancher) : '',
    fulfillmentSteps: brokerFulfillmentSteps(rancher),
    additionalCosts: brokerAdditionalCosts(rancher),
  };
}

/**
 * The self-serve reserve gate: is this rancher publicly reservable for this
 * cut, with buyer-safe refusals?
 *
 * Composes (in order):
 *   1. assertBrokerEligible — the exact money gates the /r/b redemption and
 *      the broker checkout run (broker rail, no Connect footprint, priced,
 *      explicit deposit, deposit < price) with its exact statuses (bad cut →
 *      400, missing rancher → 404, non-broker → 409, unsellable → 409);
 *   2. the self-serve opt-in — an otherwise-sellable broker ranch WITHOUT the
 *      flag stays token-only (409).
 *
 * Fail closed: every refusal is a refusal, never a guess. The route re-runs
 * the money gates again inside findOrCreateBrokerReferral (via
 * assertBrokerEligible) — deliberate double-checking, same as the sell-links
 * mint vs the /r/b tap.
 */
export function assertBrokerSelfServeReservable(rancher: any, cut: Cut): BrokerEligibility {
  const gate = assertBrokerEligible(rancher, cut);
  if (!gate.ok) return gate;
  if (!isBrokerSelfServe(rancher)) {
    return {
      ok: false,
      status: 409,
      code: 'self_serve_unavailable',
      error: 'This ranch is not taking online reservations right now.',
    };
  }
  return gate;
}
