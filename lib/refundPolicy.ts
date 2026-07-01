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
