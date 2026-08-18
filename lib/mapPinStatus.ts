// /map PIN BUCKETING — the single source of truth for how a Ranchers row
// becomes a pin status on the public Discover Map (app/map/page.tsx).
//
// Extracted from the page (2026-08-18) because the inline version predated the
// broker self-serve carve-out and mislabeled the carve-out's flagship supply:
// a REPRESENTED ranch (Broker Rail + `Broker Self Serve`, e.g. Gila River
// Cattle, AZ) never runs the wizard and never signs anything, so its
// Verification Status, Onboarding Status, and Self-Submitted At are ALL empty
// — and the old fallthrough dumped it in 'prospect', painting a deposit-ready,
// routable ranch as "○ On our radar (unclaimed)" on the PR's headline surface.
//
// Status priority — most-progressed wins:
//   verified    → Onboarding Status = Live (canonical terminal state), OR
//                 Verification Status = Verified. Connect-rail truth,
//                 unchanged from the original inline logic.
//   represented → isBrokerSelfServe: a ranch BuyHalfCow represents that Ben
//                 explicitly opted into public promotion (#628/#630). It is
//                 deposit-ready TODAY via the broker rail, so it outranks the
//                 pipeline buckets below — a represented ranch structurally
//                 has none of those fields anyway, but if one ever carries a
//                 stray Onboarding Status mid-conversion, "you can reserve
//                 now" is the truer public label than "being onboarded".
//                 Sits BELOW verified: a ranch that graduates to the Connect
//                 rail reads as the more-progressed thing it became.
//                 Token-only broker ranches (no `Broker Self Serve`) never
//                 reach this code at all — mapPinsFormula's carve-out excludes
//                 them at fetch time (pinned by lib/brokerDiscoverySurfaces
//                 .test.ts) — and isBrokerSelfServe fails closed for them
//                 anyway, so even a formula regression could not label one
//                 "represented".
//   onboarding  → Onboarding Status in ONBOARDING_STAGES (visible, not yet
//                 routable; stageLabel carries the sub-stage).
//   self-submitted → Self-Submitted At set (raised hand / fan-flagged).
//   prospect    → cold-discovered, no progress.
//
// FAIL CLOSED: anything unrecognized falls through to 'prospect', the least
// promising label — never the other direction.

import { isBrokerSelfServe, isBrokerRoutable } from './brokerRail';
import { isRancherOnConnect } from './rancherEligibility';

export const ONBOARDING_STAGES = [
  'Call Scheduled',
  'Call Complete',
  'Docs Sent',
  'Agreement Signed',
  'Verification Pending',
  'Verification Complete',
];

export type MapPinStatus =
  | 'verified'
  | 'represented'
  | 'onboarding'
  | 'self-submitted'
  | 'prospect';

export function derivePinStatus(r: any): { status: MapPinStatus; stageLabel: string } {
  const verification = (r?.['Verification Status'] || '').toString();
  const onboarding = (r?.['Onboarding Status'] || '').toString();
  const selfSubmittedAt = (r?.['Self-Submitted At'] || '').toString();

  // Onboarding="Live" is the canonical terminal state — by the time a rancher
  // reaches Live, they've cleared agreement + verification and are routable.
  // Verification Status is a legacy/duplicate gate; some ranchers reach Live
  // without it ever being flipped to "Verified" (Self-Submit drip path skips
  // that field). Treat Live as verified regardless of Verification Status
  // (Removed is already excluded at fetch time via mapPinsFormula).
  if (onboarding === 'Live') return { status: 'verified', stageLabel: '' };
  if (verification === 'Verified') return { status: 'verified', stageLabel: '' };
  if (isBrokerSelfServe(r)) return { status: 'represented', stageLabel: '' };
  if (ONBOARDING_STAGES.includes(onboarding)) {
    return { status: 'onboarding', stageLabel: onboarding };
  }
  if (selfSubmittedAt) return { status: 'self-submitted', stageLabel: '' };
  return { status: 'prospect', stageLabel: '' };
}

/**
 * Will this rancher's public page actually render a deposit form?
 *
 * The map's "Reserve →" CTA must never promise a checkout the slug page can't
 * deliver (dead-ends the buyer), and must never undersell one it can. Two
 * rails can take a deposit, and they are mutually exclusive by construction:
 *
 *   - Connect rail: tier_v2 + ACTIVE Stripe Connect (isRancherOnConnect —
 *     the exact gate the storefront deposit form uses).
 *   - Broker rail:  isBrokerRoutable — self-serve opt-in + not Removed/hidden
 *     + a real slug + at least one cut assertBrokerEligible accepts (the
 *     exact gate /api/checkout/broker-reserve runs). A represented ranch
 *     with no eligible cut stays FALSE and its pin card reads "View ranch".
 *
 * (isBrokerRoutable is false for any Connect-footprint rancher, and
 * isRancherOnConnect is false for broker ranches, so the OR never double-
 * claims.)
 */
export function isPinDepositReady(r: any): boolean {
  return isRancherOnConnect(r) || isBrokerRoutable(r);
}
