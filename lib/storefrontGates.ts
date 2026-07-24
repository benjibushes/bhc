// lib/storefrontGates.ts
//
// Pure storefront presentation gates for the low-ticket product rail
// (/shop/[id] PDP + /shop/checkout/[id]). These MIRROR the money-truth
// decisions the actual charge mints make in lib/productBuyGates.ts so the
// buyer-facing surfaces and the charge can never disagree. Kept pure +
// unit-tested (lib/storefrontGates.test.ts) precisely because the whole
// point is byte-parity with the gate — a silent drift here is a checkout
// dead-end (L12) or a total that overstates the charge (L13).

/**
 * Can this ranch take a BHC direct product charge right now?
 *
 * BYTE-PARITY with lib/productBuyGates.ts `resolveProductPurchase` (the
 * Connect clause both charge routes resolve through):
 *   - Stripe Connect Status === 'active'   (case-SENSITIVE, exactly as the
 *     gate compares — a capital 'Active' fails the gate, so it must fail
 *     here too or the PDP would show a Buy button the gate then 409s)
 *   - Stripe Connect Account Id present    (trimmed non-empty)
 *
 * Used by the PDP to hide the Buy button (render an honest "temporarily
 * unavailable" state) when the owning ranch can't be charged — instead of
 * sending the buyer to a checkout that hard-rejects.
 */
export function rancherCanTakeProductCharge(rancher: any): boolean {
  if (!rancher) return false;
  if (String(rancher['Stripe Connect Status'] || '') !== 'active') return false;
  if (!String(rancher['Stripe Connect Account Id'] || '').trim()) return false;
  return true;
}

/**
 * The shipping amount (in dollars) actually added to a product charge — and
 * therefore the ONLY shipping the order summary may display.
 *
 * MIRRORS lib/productBuyGates.ts: shipping is forced to 0 for deposit-style
 * AND local-pickup products (a pickup product charging a shipping fee is the
 * exact mismatch that rail exists to make impossible). Everything else pays
 * the (non-negative) Shipping Cost passthrough.
 *
 * Fixes L13: the checkout summary was adding Shipping Cost for a local-pickup
 * product carrying a Shipping Cost, overstating the total above what the
 * Payment Element actually charges.
 */
export function chargedShippingDollars(input: {
  depositStyle: boolean;
  localOnly: boolean;
  shippingCost: number;
}): number {
  if (input.depositStyle || input.localOnly) return 0;
  return Math.max(0, Number(input.shippingCost) || 0);
}
