// Single source of truth for the deposit refund policy (NRD-2026-06-05).
//
// The deposit is refundable UNTIL the rancher accepts the slot, then
// non-refundable. Every buyer-facing surface MUST use these strings. Prior copy
// had drifted to three contradictory versions — "7 days" (storefront), "until
// processing" (funnel reveal), and "until they accept" (deposit/success) — a
// consumer-protection exposure if a refund dispute cited the wrong terms.
// Change the policy here, once, and it updates everywhere.

export const REFUND_POLICY_SHORT = 'fully refundable until your rancher accepts your slot';

export const REFUND_POLICY_LONG =
  'Your deposit is fully refundable until your rancher accepts your slot (usually 24–48 hrs), then it becomes non-refundable.';

// ── BROKER RAIL variants (RAIL-MATRIX 2026-08-04) ──────────────────────────
//
// The Connect copy above is mechanically FALSE on the broker rail: a
// represented ranch has no dashboard and never "accepts a slot" in the system
// (no Rancher Accepted At, no slot-locked email), and the deposit sits in
// BuyHalfCow's OWN Stripe balance — so a refund comes from BuyHalfCow, not
// from the ranch. The buyer-facing promise must match those mechanics: the
// window closes when the RANCH confirms the animal (which happens off-platform,
// on the phone), and the money comes back from BuyHalfCow.
//
// WORDING CONSTRAINT: these strings appear on the broker checkout page and the
// broker buyer receipt, which must NEVER mention commission/fee/"we keep"
// language (pinned in lib/brokerNotify.test.ts) — keep them split-silent.

export const BROKER_REFUND_POLICY_SHORT =
  'fully refundable until the ranch confirms your animal — refunded by BuyHalfCow';

export const BROKER_REFUND_POLICY_LONG =
  'Your deposit is fully refundable until the ranch confirms your animal. Need to cancel before then? Email hello@buyhalfcow.com and BuyHalfCow refunds it in full.';
