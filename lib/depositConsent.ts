// F2/A4 — consent gate for NEW deposit-checkout creates.
//
// Nothing on the deposit page or in the Stripe session used to capture the
// buyer agreeing to the Terms/refund policy at the payment point — no
// acceptance record = weak chargeback rebuttal. The deposit page now requires
// a checkbox (labelled with REFUND_POLICY_SHORT from lib/refundPolicy) and
// sends `termsAccepted: true` in the POST body; the route 400s
// ('terms_required') when it's absent.
//
// STRICT semantics on purpose: only the boolean literal `true` counts as
// acceptance. 'true' (string), 1, or any other truthy value is rejected — a
// consent record that a dispute rebuttal will cite must never be the product
// of type coercion. The client always sends a real boolean once the box is
// checked, so legitimate buyers never see the 400.

export function validateDepositConsent(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  return (body as Record<string, unknown>).termsAccepted === true;
}
