// lib/depositOptionality.ts
//
// DEPOSIT OPTIONALITY (2026-06-30) — the single source of truth for "can this
// qualified buyer deposit right now, or do they have to book a call?"
//
// Background / cash leak: a qualified buyer matched to a tier_v2 (Stripe-Connect
// active) rancher used to be routed to "book a 15-min call with Ben" with NO
// option to deposit now. The fix: for a deposit-CAPABLE match the buyer always
// gets a one-tap deposit as the dominant primary CTA (funnel reveal + qualified
// email), with the call demoted to a quiet secondary. Only ranchers that
// genuinely can't take a self-serve deposit (legacy / Operator-without-Connect)
// stay call-only.
//
// A match is deposit-capable iff ALL THREE:
//   1. pricingModel === 'tier_v2'  (the rancher is on the Connect deposit rail), AND
//   2. a referralId exists         (so the deposit deep-link can point at
//                                    /checkout/<refId>/deposit — without it the
//                                    deposit page has nothing to charge against), AND
//   3. Stripe Connect Status is 'active' (2026-07-15 dead-CTA fix: Pricing Model
//                                    flips to tier_v2 before Connect onboarding
//                                    finishes; until it's active the deposit
//                                    endpoint 409s — app/api/checkout/deposit/
//                                    route.ts:155 — so minting the CTA ships a
//                                    guaranteed-broken primary button. Mirrors
//                                    isRancherOnConnect, which server mint sites
//                                    holding the full rancher record use).
//
// Pure + dependency-free so both app/api/qualify/route.ts and the funnel reveal
// reason about it identically, and so it's unit-testable.

export function isDepositCapableMatch(
  pricingModel: string | null | undefined,
  referralId: string | null | undefined,
  connectStatus: string | null | undefined,
): boolean {
  return (
    pricingModel === 'tier_v2' &&
    String(connectStatus || '').toLowerCase() === 'active' &&
    !!referralId
  );
}
