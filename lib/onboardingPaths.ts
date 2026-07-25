// lib/onboardingPaths.ts
//
// ONE ROAD, TWO WAYS TO SELL (2026-07-24, founder directive: "all roads
// onboarding lead to the same route").
//
// Both of BHC's money rails already exist and BOTH take the fee ON TOP of the
// rancher's own price. What did not exist was a single, honest statement of
// what a rancher must do to go from nothing to live — so onboarding asked for
// ten steps without ever saying how anyone gets paid. This module is that
// statement, and it is the SINGLE SOURCE OF TRUTH shared by the setup wizard,
// the rancher dashboard, admin, and onboarding emails. (The drift that stranded
// 48 buyers came from four copies of one rule — see lib/rancherEligibility.ts.
// Don't inline a second copy of this.)
//
// THE ROAD (identical for everyone): Stripe Connect. It is how money reaches
// the rancher's bank on both paths — the shares rail charges the buyer directly
// on their connected account (lib/stripeConnect.ts:334) and the store rail
// settles product orders against the same account (lib/productSettlement.ts).
// There is no live path to getting paid that skips it.
//
// THE OPTIONALITY (all this actually differs): where the catalog comes from and
// who ships.
//   • 'shares' — beef shares. Rancher sets quarter/half/whole prices, BHC runs
//     checkout, buyer pays deposit + BHC's fee on top (lib/stripeConnect.ts:334).
//   • 'store'  — an existing store (Shopify today). BHC syncs the catalog and
//     lists it at base × (1 + markup%) (lib/shopifyCatalogSync.ts:18), the buyer
//     pays BHC's listed price, and the rancher's own store receives a normal
//     paid order that their existing fulfillment ships.
//
// Requirement ORDER encodes the design thesis: everything an admin can fill for
// the rancher comes FIRST, and the two irreducible acts — Stripe identity/bank
// (KYC) and signing the agreement — come LAST. Concierge onboarding can then
// pre-fill the whole record and leave the rancher exactly two things to do.
//
// Pure. No I/O, no imports — every branch is unit-tested.

export type SellPath = 'shares' | 'store';

/** Who is *able* to complete a step — the concierge/irreducible split. */
export type Actor = 'either' | 'rancher';

export interface Requirement {
  key: string;
  /** Rancher-facing label. */
  label: string;
  /** Plain-language reason, so onboarding explains itself instead of just demanding. */
  why: string;
  done: boolean;
  actor: Actor;
}

export interface OnboardingState {
  path: SellPath;
  requirements: Requirement[];
  /** First incomplete requirement, or null when everything is done. */
  nextAction: Requirement | null;
  /** Every requirement satisfied — eligible to be pushed live. */
  readyToGoLive: boolean;
  /** Already routing buyers. */
  isLive: boolean;
}

export interface StoreConfig {
  provider: string;
  mode?: string;
  markupPercent?: number | null;
}

/** Airtable singleSelects read back as a string OR a {name} object. */
function enumStr(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

function nonEmpty(v: unknown): boolean {
  return String(v ?? '').trim().length > 0;
}

/**
 * Read a field that arrives under DIFFERENT casings on different surfaces.
 *
 * This helper is the single source of truth for onboarding state, so it must
 * be right for every caller. Two shapes reach it:
 *   • RAW Airtable rows (dashboard, admin, crons): 'Ranch Name',
 *     'Agreement Signed', 'Fulfillment Integration', …
 *   • The wizard's GET /api/rancher/setup payload: a whitelisted subset where
 *     several keys are camelCased (ranchName, operatorName, agreementSigned,
 *     pageLive, onboardingStatus) and the raw names are absent entirely.
 * Reading only the raw name made the step-0 roadmap wrong on the exact surface
 * it was added to (contact showed unfinished forever). `pick` tries each key
 * and returns the first defined value.
 */
function pick(r: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (r[k] !== undefined && r[k] !== null && r[k] !== '') return r[k];
  }
  return undefined;
}

/**
 * Parse the `Fulfillment Integration` JSON blob written by lib/shopifyConnectFlow.
 *
 * Deliberately minimal — it reads only the three fields onboarding cares about
 * and never throws. A blob without a `provider` is not a connected store, so a
 * half-written config can't make a rancher look further along than they are.
 */
export function readStoreConfig(raw: unknown): StoreConfig | null {
  if (!nonEmpty(raw)) return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const provider = String((parsed as any).provider || '').trim();
    if (!provider) return null;
    const rawMarkup = (parsed as any).markupPercent;
    return {
      provider,
      mode: (parsed as any).mode ? String((parsed as any).mode) : undefined,
      markupPercent: typeof rawMarkup === 'number' && Number.isFinite(rawMarkup) ? rawMarkup : null,
    };
  } catch {
    return null;
  }
}

/**
 * Which selling path this rancher is on.
 *
 * A connected store wins; otherwise beef shares — the default, and what a
 * rancher with no e-commerce presence (most of them) gets.
 */
export function detectSellPath(rancher: Record<string, unknown>): SellPath {
  const r = rancher || {};
  return readStoreConfig(pick(r, 'Fulfillment Integration', 'fulfillmentIntegration')) ? 'store' : 'shares';
}

function hasAnyPrice(r: Record<string, unknown>): boolean {
  return ['Quarter Price', 'Half Price', 'Whole Price'].some((f) => Number(r?.[f]) > 0);
}

/** Canonical rancher-facing money copy. Every surface renders THESE strings. */
export const MONEY_MODEL = {
  headline:
    'You set your price. The buyer pays your price plus our service fee on top. You net your number.',
  sharePath:
    'Beef shares: you set your quarter/half/whole prices. We bring the buyer and run checkout, and our fee is added on top of your price — never taken out of it. Your deposit lands in your own Stripe account.',
  storePath:
    'Your store: we sync your catalog and list it at your price plus our margin. The buyer pays us, your store receives a normal paid order, and your existing fulfillment ships it exactly like any other sale.',
  connect:
    'Stripe Connect is how the money reaches your bank on either path. The account is yours — we never hold your funds.',
  /** The one sentence that must be true on EVERY rancher surface. */
  keep: 'You keep 100% of your price.',
  /** Plain-text long form for emails and any surface without markup. */
  emailLine:
    'You keep 100% of your price — our 10% is added on top and paid by the buyer at deposit, never taken out of what you set. You never owe us anything.',
} as const;

/** Fee percentage by tier slug. Mirrors lib/tiers.ts commissionRate. */
export const TIER_FEE_PERCENT: Record<string, number> = {
  legacy_connect: 10,
  pasture: 7,
  ranch: 3,
  operator: 0,
};

export interface CommissionCopy {
  /** Constant lead — the part that is true at every rate. */
  keep: string;
  /** What the BUYER pays, at this rancher's rate. */
  fee: string;
  /** When it's charged / what it isn't. May be ''. */
  detail: string;
  /** All three as one plain-text sentence (emails, alt text, tests). */
  line: string;
}

/**
 * Rancher-facing commission copy at a given rate — the ONLY place this
 * sentence is composed.
 *
 * THE RULE (docs/BUSINESS-MODEL.md ⭐ GROUND TRUTH, LOCKED 2026-07-24): the
 * rancher keeps 100% of the price they set, and BHC's percentage is ADDED to
 * the buyer as a marketplace service fee (Connect `application_fee` at
 * deposit). It is NOT deducted, NOT a 90/10 split, and the rancher never owes
 * BHC anything.
 *
 * This existed because the wizard's SIGNATURE screen — the one place a rancher
 * legally signs — said "10% commission on closed deals only", the deducted
 * framing, while step 0 two screens earlier said the opposite. One source now.
 *
 * @param ratePercent whole percent (10, 7, 3, 0), or null when the rancher
 *   hasn't locked a tier yet — then the copy states the range instead.
 * @param planLabel optional plan name to name the rate, e.g. 'free plan'.
 */
export function commissionCopyFor(
  ratePercent: number | null | undefined,
  planLabel?: string,
): CommissionCopy {
  const plan = planLabel ? ` (${planLabel})` : '';
  const keep = MONEY_MODEL.keep;

  let fee: string;
  let detail: string;

  if (ratePercent === null || ratePercent === undefined || !Number.isFinite(ratePercent)) {
    // No tier locked yet — state the range, still buyer-pays-on-top.
    fee =
      'The buyer pays our service fee on top of it, at the rate set by the plan you pick (free plan 10% · Pasture 7% · Ranch 3% · Operator 0%).';
    detail = 'Whatever the rate, it is added to the buyer — never taken out of your price.';
  } else if (ratePercent <= 0) {
    fee = `The buyer pays no service fee at all${plan}.`;
    detail = 'Your plan covers it — a flat subscription instead of a per-sale fee.';
  } else {
    fee = `The buyer pays our ${ratePercent}% on top of it${plan}.`;
    detail =
      'Charged with their deposit, only when a deal actually closes — nothing on tire-kickers, nothing on no-shows.';
  }

  return { keep, fee, detail, line: [keep, fee, detail].filter(Boolean).join(' ') };
}

/**
 * What this rancher still has to do to go from nothing to live.
 *
 * Requirements are returned in completion order: admin-fillable first, the two
 * irreducible rancher acts last.
 */
export function evaluateOnboarding(rancher: Record<string, unknown>): OnboardingState {
  const r = rancher || {};
  const path = detectSellPath(r);
  const store = readStoreConfig(pick(r, 'Fulfillment Integration', 'fulfillmentIntegration'));

  const requirements: Requirement[] = [];

  // 1. Contact — pure data entry, an admin can do all of it. Reads both the
  //    raw and camelCase shapes (the wizard payload camelCases the names).
  //
  //    SATISFIABILITY INVARIANT (2026-07-24): every field named here must be
  //    reachable from the wizard, or this renders a checkbox on screen 1 that
  //    a rancher can never tick and cannot fix. It shipped broken once —
  //    Operator Name wasn't in the wizard's PATCH allowlist and Phone wasn't
  //    required at step 1. Both are now writable AND collected at step 1
  //    (app/api/rancher/setup ALLOWED_FIELDS + RancherSetupWizard step 1).
  //    Ranch Name is the exception on purpose: it seeds the Slug so the wizard
  //    must not edit it — but all three signup doors require it at creation,
  //    so it is never blank on a real record. Do NOT add a field here without
  //    checking the rancher has a way to fill it.
  requirements.push({
    key: 'contact',
    label: 'Ranch + contact details',
    why: 'So buyers know who they are buying from and we can reach you about a sale.',
    done:
      nonEmpty(pick(r, 'Ranch Name', 'ranchName')) &&
      nonEmpty(pick(r, 'Operator Name', 'operatorName')) &&
      nonEmpty(pick(r, 'Email', 'email')) &&
      nonEmpty(pick(r, 'Phone', 'phone')),
    actor: 'either',
  });

  // 2. What you sell — the ONLY place the two paths differ.
  if (path === 'store') {
    requirements.push({
      key: 'store',
      label: 'Connect your store',
      why: MONEY_MODEL.storePath,
      done: !!store,
      actor: 'rancher',
    });
    requirements.push({
      key: 'markup',
      label: 'Set the marketplace margin',
      // A connected store with no markup lists at cost — BHC earns nothing on
      // every order. This requirement is what stops that shipping silently.
      why: 'Your listed price is your price plus this margin. Without it we would list at your cost and earn nothing.',
      done: typeof store?.markupPercent === 'number' && store.markupPercent > 0,
      actor: 'either',
    });
  } else {
    requirements.push({
      key: 'prices',
      label: 'Set your share prices',
      why: MONEY_MODEL.sharePath,
      done: hasAnyPrice(r),
      actor: 'either',
    });
  }

  // 3. Get paid — IRREDUCIBLE. Stripe requires the account holder's own
  //    identity + bank details; nobody can complete this for them.
  requirements.push({
    key: 'payout',
    label: 'Connect your bank (Stripe)',
    why: MONEY_MODEL.connect,
    done: String(pick(r, 'Stripe Connect Status', 'stripeConnectStatus') || '').toLowerCase() === 'active',
    actor: 'rancher',
  });

  // 4. Sign — IRREDUCIBLE. It's their signature on the commission agreement.
  requirements.push({
    key: 'agreement',
    label: 'Sign the agreement',
    why: 'One e-signature covering our commission and how we work together.',
    done: !!pick(r, 'Agreement Signed', 'agreementSigned'),
    actor: 'rancher',
  });

  const nextAction = requirements.find((x) => !x.done) || null;
  const onboardingStatus = enumStr(pick(r, 'Onboarding Status', 'onboardingStatus'));
  return {
    path,
    requirements,
    nextAction,
    readyToGoLive: nextAction === null,
    isLive: enumStr(pick(r, 'Active Status', 'activeStatus')) === 'Active' && onboardingStatus === 'Live',
  };
}
