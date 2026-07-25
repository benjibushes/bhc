// lib/connectStepDecision.ts
//
// The onboarding wizard's HONEST answers to three questions it used to guess:
//
//   1. "Which step does this rancher belong on right now?"  (the 11→6 loop)
//   2. "What is Stripe actually still waiting on?"          (machine → English)
//   3. "Does signing really take this page live?"           (the over-promise)
//
// Pure. No fetch, no Stripe client, no React — every branch is unit-tested in
// lib/connectStepDecision.test.ts. The wizard renders exactly what this module
// decides; it never re-derives "is he stuck?" from a scatter of booleans.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// 12 ranchers started Stripe Connect. 6 finished. Five of the six stalled at
// Stripe screen ONE (tos_acceptance.date: null) — they never even reached the
// bank/SSN pages. Two separate wizard bugs then made that survivable-looking:
//
//   • The ?connectComplete=1 return handler branched on fulfillment/signature
//     and NEVER asked whether Connect actually went active. A rancher whose
//     KYC landed pending walked straight to Sign, signed, did not go live, and
//     then read "Connect your bank →" on the Done screen — the very step they
//     believed they had just finished.
//   • The signature screen promised "Sign and your page goes live" whether or
//     not the go-live union in app/api/ranchers/sign-agreement was satisfiable.
//
// Both are decisions, not rendering. So both live here, tested, one dialect.

import type { ConnectHandoffState } from './connectResumeState';

export type { ConnectHandoffState };

// ── 1. Reading a Connect status from any of the three shapes we store ───────
//
// The same fact reaches the wizard under three vocabularies:
//   • GET /api/rancher/connect/status → `state` (the #480 handoff states)
//   • the same route's legacy `status` field and the Airtable cache
//     ('Stripe Connect Status') → 'not_connected' | 'onboarding' | 'restricted'
//     | 'active'
//   • nothing at all, when the read failed.
//
// Returns null for "we do not know" — deliberately NOT 'never_started', so a
// failed read can never be mistaken for a rancher who hasn't begun (which
// would render a "start from scratch" CTA at someone mid-KYC).

/**
 * Normalize any stored/returned Connect status into the four handoff states.
 * Unknown or unreadable input yields null.
 */
export function connectStateFrom(raw: unknown): ConnectHandoffState | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'active') return 'active';
  if (s === 'restricted') return 'restricted';
  if (s === 'onboarding' || s === 'incomplete' || s === 'pending') return 'incomplete';
  if (s === 'not_connected' || s === 'never_started' || s === 'none') return 'never_started';
  // 'unknown' and anything unrecognized: we do not know.
  return null;
}

// ── 2. Machine requirement codes → something a rancher can act on ───────────
//
// Stripe's V2 `requirements.entries[].description` values are dotted machine
// codes ('identity.attestations.terms_of_service.account'). #480 made the due
// list REAL for the first time; showing it raw would just be a new flavor of
// unhelpful. Substring rules (not exact matches) so a schema drift degrades to
// a prettified code instead of vanishing.

const REQUIREMENT_PHRASES: Array<[RegExp, string]> = [
  [/terms_of_service|tos_acceptance/, 'Accept Stripe’s terms of service'],
  [/bank_account|external_account|payout_method/, 'Add your bank account (routing + account number)'],
  [/id_number|ssn/, 'Verify your identity (last 4 of your SSN)'],
  [/document|passport|driver/, 'Upload a photo ID'],
  [/tax_id|\bein\b/, 'Add your business tax ID (EIN)'],
  [/date_of_birth|\bdob\b/, 'Add your date of birth'],
  [/product_description/, 'Describe what you sell in a sentence'],
  [/business_details\.url|\burl\b|website/, 'Add your website (or a note about where you sell)'],
  [/ownership|owner|director|representative|executive/, 'Confirm who owns or represents the ranch'],
  [/address/, 'Confirm your address'],
  [/phone/, 'Confirm your phone number'],
  [/email/, 'Confirm your email address'],
  [/\bname\b/, 'Confirm your legal name'],
];

/**
 * Turn one Stripe requirement code into a plain-English line.
 *
 * Never returns '' for non-empty input — a rancher staring at a blank bullet
 * is worse than a slightly clunky one.
 */
export function humanizeRequirement(code: unknown): string {
  const raw = String(code ?? '').trim();
  if (!raw) return '';
  const key = raw.toLowerCase();
  for (const [pattern, phrase] of REQUIREMENT_PHRASES) {
    if (pattern.test(key)) return phrase;
  }
  // Fallback: prettify the tail of the dotted path. 'identity.foo.bar_baz'
  // → 'Foo bar baz'.
  const segments = raw.split('.').filter(Boolean);
  const tail = segments.slice(-2).join(' ');
  const words = (tail || raw).replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return raw;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Humanize a whole due list, de-duplicated (two codes can map to one phrase). */
export function humanizeRequirements(codes: unknown): string[] {
  if (!Array.isArray(codes)) return [];
  const out: string[] = [];
  for (const c of codes) {
    const phrase = humanizeRequirement(c);
    if (phrase && !out.includes(phrase)) out.push(phrase);
  }
  return out;
}

// ── 3. Where a rancher goes after Stripe hands them back ────────────────────

/** Wizard step ids this decision can produce. Numbers are historical — see
 *  lib/onboardingFlow. NEVER renumber them (localStorage-keyed resume). */
export type ConnectReturnStep = 5 | 6 | 8 | 9;

export type ConnectReturnReason =
  | 'connect-not-active'
  | 'fulfillment-missing'
  | 'already-signed'
  | 'ready-to-sign';

export interface ConnectReturnDecision {
  step: ConnectReturnStep;
  reason: ConnectReturnReason;
}

export interface ConnectReturnInput {
  /** Live Connect state. Anything but 'active' blocks the advance. */
  connectStatus?: ConnectHandoffState | string | null;
  /** Has the rancher chosen at least one fulfillment type (step 8)? */
  fulfillmentDone: boolean;
  /** Is the partner agreement already signed? */
  agreementSigned: boolean;
  /**
   * Does this rancher need Connect at all? Legacy (non-tier_v2) ranchers are
   * paid through their OWN payment links and are invoiced for commission — a
   * Connect account is not part of their road, and gating them on one would
   * strand every legacy rancher at step 9 forever. Defaults to true (the
   * tier_v2 majority, and the safe direction: an unknown model is gated).
   */
  connectRequired?: boolean;
}

/**
 * The single branch that decides where a rancher lands after Stripe.
 *
 * THE RULE THAT WAS MISSING: never advance past step 9 unless Connect is
 * genuinely active. Everything downstream of 9 — signing, going live, taking a
 * deposit — is a lie without it, and the Done screen's honest "Connect your
 * bank →" nudge is exactly where the loop closed on itself.
 *
 * Order matters:
 *   1. Connect gate (when required) — keeps them on 9 with the honest state.
 *   2. Fulfillment — an OLD-FLOW rancher (Connect used to come BEFORE step 8)
 *      still owes us fulfillment before buyers see an empty section.
 *   3. Already signed → Done. SignStep 400s on a second signature.
 *   4. Otherwise → Sign.
 *
 * A null/unknown connectStatus fails CLOSED (treated as not active): a status
 * read we could not complete must never be spent as permission to sign.
 */
export function decideConnectReturnStep(input: ConnectReturnInput): ConnectReturnDecision {
  const required = input.connectRequired !== false;
  if (required && connectStateFrom(input.connectStatus) !== 'active') {
    return { step: 9, reason: 'connect-not-active' };
  }
  if (!input.fulfillmentDone) return { step: 8, reason: 'fulfillment-missing' };
  if (input.agreementSigned) return { step: 6, reason: 'already-signed' };
  return { step: 5, reason: 'ready-to-sign' };
}

// ── 4. Does signing actually take the page live? ────────────────────────────
//
// MIRROR OF app/api/ranchers/sign-agreement/route.ts (:119-148). That route
// computes:
//
//   hasSlug        = !!Slug
//   hasPrice       = !!(Quarter Price || Half Price || Whole Price)
//   hasPaymentLink = !!(Quarter|Half|Whole Payment Link)
//   readyToGoLive  = tier_v2 ? hasSlug && hasPrice && connect === 'active'
//                            : hasSlug && hasPrice && hasPaymentLink
//
// If you change that route, change this — and its tests will tell you.

export type GoLiveBlockerKey = 'slug' | 'price' | 'payment_link' | 'connect';

export interface GoLiveBlocker {
  key: GoLiveBlockerKey;
  /** Rancher-facing name of the missing thing. */
  label: string;
}

export interface GoLiveReadiness {
  readyToGoLive: boolean;
  blockers: GoLiveBlocker[];
  /** Sign button label that never promises more than the API will deliver. */
  ctaLabel: string;
  /** One honest sentence for the signature screen's subhead. */
  promise: string;
}

export interface GoLiveInput {
  pricingModel?: string | null;
  hasSlug: boolean;
  hasPrice: boolean;
  hasPaymentLink: boolean;
  connectStatus?: ConnectHandoffState | string | null;
}

function joinList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/**
 * What signing will ACTUALLY do for this rancher, right now.
 *
 * The wizard used to say "Sign and your page goes live" unconditionally. For a
 * rancher missing a price (or with Connect still pending) the signature lands,
 * the go-live union does not, and they leave believing they are routing. Say
 * what is left instead — the Done screen already tells this truth, so this just
 * stops the two screens from contradicting each other.
 */
export function goLiveReadiness(input: GoLiveInput): GoLiveReadiness {
  const isTierV2 = String(input.pricingModel ?? '').toLowerCase() === 'tier_v2';
  const blockers: GoLiveBlocker[] = [];

  if (!input.hasSlug) blockers.push({ key: 'slug', label: 'your page address' });
  if (!input.hasPrice) blockers.push({ key: 'price', label: 'a price on at least one share' });
  if (isTierV2) {
    if (connectStateFrom(input.connectStatus) !== 'active') {
      blockers.push({ key: 'connect', label: 'your bank connected through Stripe' });
    }
  } else if (!input.hasPaymentLink) {
    blockers.push({ key: 'payment_link', label: 'a payment link on at least one share' });
  }

  const readyToGoLive = blockers.length === 0;
  return {
    readyToGoLive,
    blockers,
    ctaLabel: readyToGoLive ? 'Sign & go live →' : 'Sign the agreement →',
    promise: readyToGoLive
      ? 'One signature. No PDF, no notary, no email round-trip. Sign and your page goes live — buyers can route to you right away.'
      : `One signature. No PDF, no notary, no email round-trip. Your signature is locked in straight away; your page goes live once you add ${joinList(
          blockers.map((b) => b.label),
        )}.`,
  };
}

// ── 5. Step 3's money guard, on the same truth as go-live ───────────────────

/**
 * Does the rancher have a real, sellable price on at least one share they say
 * they sell?
 *
 * `sells` is the 'Tier Specialty' multi-select; step 3 NULLS every tier the
 * rancher doesn't sell before saving, so a price on an unsold tier is about to
 * be erased and must not count. This is the same union sign-agreement's
 * hasPrice reads after that save lands.
 *
 * A tier_v2 rancher used to pass step 3 with no price at all (the money guard
 * only fired for legacy), then sign, then not go live, and only discover it on
 * the Done screen. This predicate is what step 3 now enforces for BOTH models.
 */
export function hasSellablePrice(sells: unknown, prices: Record<string, unknown> | null | undefined): boolean {
  const sold = Array.isArray(sells) ? sells.map((s) => String(s)) : [];
  if (sold.length === 0) return false;
  const p = prices || {};
  return (['Quarter', 'Half', 'Whole'] as const).some((tier) => {
    if (!sold.includes(tier)) return false;
    const n = Number(p[`${tier} Price`]);
    return Number.isFinite(n) && n > 0;
  });
}
