// lib/foundersTiers.ts
//
// SINGLE SOURCE OF TRUTH for Founding Herd tier display pricing + caps
// (Wave B stats-truth sweep, 2026-08-17). Before this file existed the IG DM
// closer (app/api/webhooks/manychat/route.ts) quoted Founding 100 at a
// hardcoded $1,000 and Title Founder at "$5k+" while the live /founders page
// derived the early-bird flip to $1,500 and rendered $15,000 / 10 spots — the
// DM bot quoted prices the checkout would contradict. Every surface that
// states a Founding Herd price MUST pull it from here
// (lib/foundersTiers.test.ts enforces it on both consumers).
//
// Charge truth: Founding 100 charges getFounding100PriceCents() via the
// cap-enforced /api/founders/checkout; the subscription tiers and Title
// Founder charge whatever their Stripe Payment Link says (lib/secrets
// STRIPE_PAYMENT_LINK_*). The dollar amounts below are the DISPLAY copy for
// those links — if Ben changes a Payment Link price in Stripe, change it here
// in the same breath.

import {
  FOUNDING_100_CAP,
  TITLE_FOUNDER_CAP,
  FOUNDING_100_POST_EARLY_BIRD_CENTS,
  getFounding100PriceLabel,
} from './secrets';

export const HERD_MONTHLY_DOLLARS = 9;
export const HERD_ANNUAL_DOLLARS = 90;
export const OUTLAW_MONTHLY_DOLLARS = 25;
export const OUTLAW_ANNUAL_DOLLARS = 250;
export const STEWARD_MONTHLY_DOLLARS = 75;
export const STEWARD_ANNUAL_DOLLARS = 750;
export const TITLE_FOUNDER_DOLLARS = 15000;

/** "$15,000" — Title Founder display label. */
export const TITLE_FOUNDER_PRICE_LABEL = `$${TITLE_FOUNDER_DOLLARS.toLocaleString('en-US')}`;

/** The Title Founder CHARGE amount in cents, derived from the SAME constant
 *  the display label renders so the two can never drift —
 *  /api/founders/checkout used to hardcode the cents beside a page that
 *  derived the dollars (comms containment 2026-08-18). CHARGE TRUTH: must
 *  stay byte-identical to the old literal (1500000);
 *  lib/foundersTiers.test.ts pins the value. */
export const TITLE_FOUNDER_CENTS = TITLE_FOUNDER_DOLLARS * 100;

/** "$1,500" — what Founding 100 costs once the early-bird window closes. */
export const FOUNDING_100_POST_EARLY_BIRD_LABEL = `$${Math.round(
  FOUNDING_100_POST_EARLY_BIRD_CENTS / 100
).toLocaleString('en-US')}`;

/** "$9 / mo or $90 / yr" — the /founders TierCard priceLine format. */
export function subscriptionPriceLine(monthly: number, annual: number): string {
  return `$${monthly} / mo or $${annual} / yr`;
}

/**
 * The Founding Herd tier ladder as prompt prose for the IG DM closer.
 * Called per request (NOT frozen at module load) so the Founding 100
 * early-bird price flip reaches DMs the moment it reaches /founders —
 * price truth at the moment of commitment.
 */
export function foundersTierLadderPromptBlock(): string {
  const f100Label = getFounding100PriceLabel();
  return `  • Herd ($${HERD_MONTHLY_DOLLARS}/mo or $${HERD_ANNUAL_DOLLARS}/yr) — entry tier. Patches, founder letters, state alerts. Easy yes.
  • Outlaw ($${OUTLAW_MONTHLY_DOLLARS}/mo or $${OUTLAW_ANNUAL_DOLLARS}/yr) — Founders Wall + behind-scenes drops + first dibs on rancher batches.
  • Steward ($${STEWARD_MONTHLY_DOLLARS}/mo or $${STEWARD_ANNUAL_DOLLARS}/yr) — quarterly office-hours call + direct email line + public wall placement.
  • Founding 100 (${f100Label} one-time, ${FOUNDING_100_CAP} numbered spots) — the "real backer" tier. Lifetime perks. Popular pick for people who want skin in the game.
  • Title Founder (${TITLE_FOUNDER_PRICE_LABEL} one-time, ${TITLE_FOUNDER_CAP} spots, co-build) — escalate to needs_human=true. Don't sell this in DMs.`;
}
