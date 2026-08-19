// Single source of truth for "can this rancher receive a buyer right now?"
//
// Before this lived in 4+ places that quietly drifted apart:
//   - app/api/consumers/route.ts (signup-time waitlist gate)
//   - app/api/matching/suggest/route.ts (match engine)
//   - app/api/cron/rancher-launch-warmup/route.ts (Page Live=TRUE filter)
//   - lib/bulkRoute.ts (just Active Status)
//
// Drift caused real customer pain: ranchers with Active=Active +
// Onboarding=Live + Agreement Signed (e.g. ZK Ranches in TN, DD Ranch in OR)
// were rejected by the signup gate (because Page Live wasn't toggled), but
// accepted by the match engine. Buyers in those states got sent to waitlist
// emails despite an operational rancher serving them. 48 stranded.
//
// The unified rule (ONBOARDED / Connect-rail ranchers):
//   • Active Status === 'Active'                    — admin gating
//   • Agreement Signed === true                      — legal: must have signed
//   • Onboarding Status === 'Live' (or '')           — onboarding finished
//   • Subscription Status NOT in past_due|unpaid|    — Stripe collections gate
//     canceled (active/trialing/'' all pass)
//
// BROKER RAIL (2026-08-17). A represented ranch is on none of the above by
// construction, so it is answered by its OWN gate — isBrokerRoutable in
// lib/brokerRail — and never falls through to the Connect rule. Self-serve
// opted-in + publicly resolvable + at least one sellable cut ⇒ routable
// supply; every other represented ranch stays invisible. See the block inside
// isRancherOperationalForBuyers for why the two rules must stay separate.
//
// Page Live is NOT a routing requirement — it's a UX flag that the rancher's
// public landing page is published. Routing happens via email; if the buyer
// asks for the page and it's not up yet, the rancher's intro email still
// reaches them. Tying routing to Page Live just hides ready ranchers behind
// a flag that operators forget to flip.
//
// Subscription Status gate (2026-05-27): mirrors the 409 gate in
// /api/checkout/deposit/route.ts. Without this, matching/suggest routed
// buyers to ranchers in past_due/unpaid/canceled state — rancher took the
// call, then buyer hit a 409 wall at deposit time. Broken experience. The
// deposit endpoint stays as a defense-in-depth backstop, but the primary
// fix is excluding these ranchers from the routing pool upstream. Active,
// trialing, and empty/unset values all pass (legacy ranchers predating
// subscription flow have no value).
//
// Capacity is intentionally NOT checked here — it's caller-dependent (hot-lead
// bypass, etc.). This function answers "is this rancher live + signed up?",
// not "can they take one more right now?"
//
// TWO PREDICATES, AND THE DIFFERENCE MATTERS (2026-08-19):
//   • isRancherOperationalForBuyers — "can they RECEIVE a buyer" (unchanged).
//   • isRancherSellableForBuyers    — "...and can that buyer actually PAY":
//     operational AND a cut clearing the price floor the deposit endpoint
//     enforces. Every surface that COUNTS supply, or promises a buyer their
//     state is covered, must use the second one. Three of them used three
//     different weaker rules, and California's only page-live ranch — tier_v2,
//     Stripe Connect stuck in 'onboarding', no cut priced — was sold to
//     visitors as "1 ranch is live in California right now" while the matcher
//     rejected it and every completed quiz landed on a waitlist.

import { normalizeState, normalizeStates } from './states';
// lib/brokerRail is deliberately hermetic (imports only lib/pricing) so this
// import cannot close a cycle back through lib/reserveDeposit.
import { isBrokerRancher, isBrokerRoutable } from './brokerRail';
// lib/pricing imports NOTHING at all — the same reason brokerRail can hold it.
import { MIN_TIER_PRICE } from './pricing';
// Hermetic (zero imports of its own) — cannot close a cycle.
import { isRequestOnlyRancher } from './requestOnlyRanchers';

export type RancherFields = Record<string, unknown> & {
  'Active Status'?: unknown;
  'Agreement Signed'?: unknown;
  'Onboarding Status'?: unknown;
  'Subscription Status'?: unknown;
  'Pricing Model'?: unknown;
  'Stripe Connect Status'?: unknown;
  'State'?: unknown;
  'States Served'?: unknown;
  'Verification Status'?: unknown;
};

function readEnumOrString(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

/**
 * True iff the rancher is operationally ready to receive a buyer match.
 * Use this everywhere — signup gates, match filters, warmup queries.
 *
 * Gates (all must pass):
 *   - Active Status === 'Active'
 *   - Onboarding Status === 'Live' (or empty/unset)
 *   - Agreement Signed === true
 *   - Subscription Status NOT in past_due|unpaid|canceled. Active, trialing,
 *     and empty/unset all pass. Mirrors the deposit 409 gate so we never
 *     route a buyer to a rancher whose deposit would be blocked downstream.
 *   - tier_v2 ONLY: Stripe Connect Status === 'active'. Legacy (non-tier_v2)
 *     ranchers are exempt — they checkout off-platform and never hit the
 *     Connect deposit endpoint. Mirrors the deposit 409 gate (Connect not
 *     active → buyer dead-ends at deposit time).
 */
export function isRancherOperationalForBuyers(rancher: RancherFields): boolean {
  // BROKER RAIL — represented ranchers answer a DIFFERENT question, so they
  // never fall through to the Connect gates below.
  //
  // 2026-07-31: every represented rancher was non-routable. Correct then —
  // they had no public page, and Ben sold their beef by phone.
  // 2026-08-17 (Ben's call): a ranch that passes isBrokerRoutable — the
  // `Broker Self Serve` opt-in, a resolvable public page, and at least one
  // cut that the broker checkout will actually take money for — is NORMAL
  // ROUTABLE SUPPLY. "It's the same concept, I'm just accepting the money and
  // handling the coordination myself." Without this, AZ (whose only ranch is
  // represented) had zero supply and its buyers were routed to MONTANA.
  //
  // A broker ranch WITHOUT the opt-in is phone-only and stays invisible:
  // isBrokerRoutable returns false, and so do we.
  //
  // Why this RETURNS rather than falling through: every gate below is
  // Connect-shaped (Active Status, Agreement Signed, Onboarding Status,
  // Subscription Status, tier_v2 ⇒ Connect active). A represented ranch signed
  // none of it and has no Stripe account, so running those gates would reject
  // 100% of broker supply. isBrokerRoutable is the broker ANALOGUE — the same
  // "can this buyer actually pay at the end?" question, asked against the
  // rail this ranch is actually on. Everything genuinely rail-independent
  // (Verification=Removed, price fit, exclusive ZIP, Tier Specialty, delivery
  // radius, request-only, the Closed-Won cap, the per-state sub-cap, home-state
  // coverage) lives in the CALLERS and still applies to broker ranches.
  //
  // Their `Active Status` is left EMPTY at signup and must stay irrelevant:
  // routability is decided by the broker predicate, so no careless Active
  // Status flip can publish a phone-only ranch — or hide a self-serve one.
  if (isBrokerRancher(rancher)) return isBrokerRoutable(rancher);

  // Wave C (2026-07-14) — defense in depth for CLOSED accounts. Self-serve
  // closure sets Verification Status='Removed' + Active Status='Paused';
  // the Active gate below already excludes them, but a one-click Resume (or
  // any future path that flips Active Status back) must never re-open buyer
  // routing for a closed account whose public page 404s.
  if (readEnumOrString(rancher['Verification Status']) === 'Removed') return false;

  const active = readEnumOrString(rancher['Active Status']);
  if (active !== 'Active') return false;

  const onboarding = readEnumOrString(rancher['Onboarding Status']);
  if (onboarding && onboarding !== 'Live') return false;

  if (!rancher['Agreement Signed']) return false;

  // Subscription Status gate. Mirrors /api/checkout/deposit/route.ts so we
  // don't route buyers to ranchers whose deposit endpoint would 409 them.
  // Active, trialing, and unset values all pass — only the Stripe collections
  // states (past_due, unpaid, canceled) exclude.
  const subStatus = String(rancher['Subscription Status'] || '').toLowerCase();
  if (subStatus === 'past_due' || subStatus === 'unpaid' || subStatus === 'canceled') {
    return false;
  }

  // Stripe Connect gate — tier_v2 ONLY (2026-06-15). tier_v2 buyers pay via
  // the platform deposit endpoint, which hard-requires Stripe Connect
  // Status==='active' (app/api/checkout/deposit/route.ts:123 → 409 otherwise).
  // Without this gate, a tier_v2 rancher mid-onboarding (Connect='onboarding')
  // gets routed buyers + a deposit link, then the buyer hits a 409 wall at
  // deposit time — a dead-end conversion. Mirror the deposit endpoint here so
  // these ranchers are excluded from the routing pool until Connect is live.
  //
  // Legacy ranchers (Pricing Model != tier_v2, e.g. Payment Link model) are
  // INTENTIONALLY exempt: they route buyers to their own off-platform checkout
  // on /ranchers/[slug] and never touch the Connect deposit endpoint, so a
  // Connect status (which they may not even have) must NOT gate them.
  const pricingModel = String(rancher['Pricing Model'] || '').toLowerCase();
  if (pricingModel === 'tier_v2') {
    const connectStatus = String(rancher['Stripe Connect Status'] || '').toLowerCase();
    if (connectStatus !== 'active') return false;
  }

  return true;
}

/**
 * The buyer cut a price floor is being asked about. `null` = the buyer has not
 * pinned a cut yet ("Not Sure" / blank Order Type), or the caller is asking the
 * SUPPLY question ("can this ranch sell anything at all?") rather than the
 * match question.
 */
export type BuyerCut = 'Quarter' | 'Half' | 'Whole' | null;

const CUT_PRICE_FIELD: Record<Exclude<BuyerCut, null>, string> = {
  Quarter: 'Quarter Price',
  Half: 'Half Price',
  Whole: 'Whole Price',
};

function clearsFloor(price: unknown): boolean {
  const n = Number(price);
  return Number.isFinite(n) && n >= MIN_TIER_PRICE;
}

/**
 * THE cut-price floor — one definition, two callers.
 *
 * A tier_v2 rancher who has not validly priced a cut CANNOT accept a deposit
 * for it: /api/checkout/deposit derives the charge from that cut's price and
 * 409s when it is missing or below MIN_TIER_PRICE (the DD-Ranch "$7.40 whole
 * cow" class of per-lb mis-entry). This used to live ONLY inside
 * app/api/matching/suggest as a local `passesTierV2CutFloor`, which is why
 * every supply-COUNTING surface disagreed with the matcher: California's only
 * page-live ranch has no cut priced at all, and three screens still called it
 * live supply.
 *
 * WHO IS EXEMPT, and why the exemption is load-bearing:
 *   • LEGACY (Pricing Model != 'tier_v2') — they check out off-platform via
 *     their own links, or on the phone, and never touch the Connect deposit
 *     endpoint that enforces this floor. Applying it here would strand the
 *     rail that has earned most of BHC's money to date.
 *   • BROKER / represented — a blank Pricing Model reads as legacy here, which
 *     is correct: their sellability is decided by assertBrokerEligible (price
 *     floor INCLUDED) inside isBrokerRoutable, on the rail they are actually on.
 *
 * `cut === null` falls back to any-cut so an undecided buyer is never
 * over-excluded — the matcher's documented behavior, preserved verbatim.
 */
export function passesCutPriceFloor(rancher: RancherFields, cut: BuyerCut): boolean {
  if (String(rancher['Pricing Model'] || 'legacy').toLowerCase() !== 'tier_v2') return true;
  if (cut) return clearsFloor(rancher[CUT_PRICE_FIELD[cut]]);
  return (['Quarter', 'Half', 'Whole'] as const).some((c) =>
    clearsFloor(rancher[CUT_PRICE_FIELD[c]]),
  );
}

/**
 * CAN A BUYER IN THIS STATE ACTUALLY COMPLETE A PURCHASE HERE, TODAY?
 *
 * This is what "live supply" has to mean on every surface that spends ad money
 * or makes a promise to a visitor. It is deliberately the SAME two questions
 * the matcher asks, in the same order and with no fourth definition:
 *
 *   1. isRancherOperationalForBuyers — rail-aware "can they receive a buyer"
 *      (Connect gates for the Connect rail, isBrokerRoutable for represented).
 *   2. passesCutPriceFloor(r, null)  — "and is there a cut they can be paid for"
 *      (tier_v2 only; the exemptions above).
 *
 * WHAT IT COST TO NOT HAVE THIS. lib/stateSupply counted a ranch as live supply
 * on {Page Live} alone. California's 5 Bar Beef is page-live, tier_v2, Stripe
 * Connect stuck on 'onboarding', and has NO cut priced — so /half-a-cow/california
 * advertised "1 ranch is live in California right now" while the matcher rejected
 * that same ranch and dead-ended every completed quiz on a waitlist. Maine was
 * identical (Rocky Ridge Livestock).
 *
 * NOT included here: the request-only belt. That is a GENERIC-supply question,
 * not a sellability one — a request-only ranch sells perfectly well to a buyer
 * who asked for it by name. lib/routingSegment layers isRequestOnlyRancher on
 * top for the coverage answers; lib/requestOnlyRanchers documents which paths
 * stay open.
 */
export function isRancherSellableForBuyers(rancher: RancherFields): boolean {
  if (!isRancherOperationalForBuyers(rancher)) return false;
  return passesCutPriceFloor(rancher, null);
}

/**
 * Returns the deduped 2-letter state codes a rancher serves.
 *
 * HOME-STATE GATE (2026-05-13): default behavior is HOME STATE ONLY. Multi-
 * state coverage requires admin opt-in via the `Admin Approved Multi-State`
 * boolean. Without the boolean, even a populated Routing States list is
 * ignored. Prevents bulk-imported nationwide lists, accidental dashboard
 * over-shares, or rancher-edited Preferred States from silently routing
 * cross-state. Matches the gate in app/api/matching/suggest/route.ts so
 * the signup-time "rancher available in your state?" check stays consistent.
 */
export function getOperationalServedStates(rancher: RancherFields): string[] {
  // BROKER RAIL — a PHONE-ONLY represented ranch serves NO states for routing
  // purposes. This helper is the supply-coverage answer used by state counts,
  // campaign targeting, and the reserve gate, and it deliberately does NOT
  // call isRancherOperationalForBuyers — so the rule has to be repeated here
  // or a represented ranch would silently show up as coverage in their state.
  //
  // 2026-08-17: a SELF-SERVE broker ranch (isBrokerRoutable) is real coverage
  // and falls through to the normal state read — that is the whole point of
  // making it routable. It needs NO new Airtable field: the primary `State`
  // seeds the set below, and Routing States / States Served stay ignored
  // unless `Admin Approved Multi-State` is ticked, exactly as for everyone
  // else. Kept in LOCKSTEP with isRancherOperationalForBuyers above — a ranch
  // that is operational but serves no state is invisible supply, and a ranch
  // that serves a state but is not operational strands the buyers it attracts.
  if (isBrokerRancher(rancher) && !isBrokerRoutable(rancher)) return [];
  const out = new Set<string>();
  const primary = normalizeState(rancher['State']);
  if (primary) out.add(primary);
  const approved = !!(rancher as any)['Admin Approved Multi-State'];
  if (approved) {
    // Prefer Routing States (admin-controlled); fall back to legacy States Served.
    const routing = String((rancher as any)['Routing States'] || rancher['States Served'] || '');
    for (const s of normalizeStates(routing)) out.add(s);
  }
  return Array.from(out);
}

/**
 * True iff the rancher is on Stripe Connect AND Connect is active.
 *
 * "On Connect" means: Pricing Model === 'tier_v2' AND Stripe Connect Status
 * === 'active' (both case-insensitive). Single source of truth used by:
 *   - app/ranchers/[slug]/pay/[tier]/route.ts  (blocks Payment-Link redirect)
 *   - app/ranchers/[slug]/page.tsx             (suppresses raw Payment-Link hrefs)
 *
 * For ALL such ranchers every buyer-facing payment path must route through
 * BHC's Connect commission rails (/access?rancher=<slug>). Legacy ranchers
 * (non-tier_v2 or Connect not active) are UNAFFECTED.
 */
export function isRancherOnConnect(rancher: RancherFields): boolean {
  const pricingModel = String(rancher['Pricing Model'] || '').toLowerCase();
  const connectStatus = String(rancher['Stripe Connect Status'] || '').toLowerCase();
  return pricingModel === 'tier_v2' && connectStatus === 'active';
}

/**
 * Convenience: is there GENERIC supply a buyer in `buyerState` could actually
 * buy from? Used by the signup-time gate to decide ready-to-buy-prompt vs
 * waitlist (app/api/consumers: Buyer Stage READY vs WAITING, and the public
 * `rancherAvailable` flag on the signup response).
 *
 * Deliberately the SAME two belts lib/routingSegment.getServedStates applies,
 * because it is the same question asked one state at a time —
 * lib/sellableSupply.test.ts pins that the two agree:
 *   • SELLABLE, not merely operational. Gating on operational alone told a
 *     buyer in a state whose only ranch cannot take a deposit that they were
 *     READY, and the matcher then found nobody.
 *   • NOT request-only. Specialty supply is reachable only by explicit buyer
 *     request, so it can never satisfy "is my state covered?".
 * (It cannot import getServedStates — routingSegment imports THIS module.)
 */
export function hasOperationalRancherForState(
  ranchers: RancherFields[],
  buyerState: unknown
): boolean {
  const stateNorm = normalizeState(buyerState);
  if (!stateNorm) return false;
  return ranchers.some((r) => {
    if (!isRancherSellableForBuyers(r)) return false;
    if (isRequestOnlyRancher(r)) return false;
    const served = getOperationalServedStates(r);
    return served.includes(stateNorm);
  });
}
