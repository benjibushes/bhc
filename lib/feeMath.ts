// lib/feeMath.ts
//
// NET-YOUR-NUMBER (2026-07-08): BHC absorbs the rancher's Stripe processing
// cost out of its own application fee, so the rancher's payout matches the
// number their dashboard promised ("you net $X") — which, before this,
// quietly overstated their take by the Stripe fee.
//
// Mechanics on a direct charge: Stripe's fee comes from the RANCHER's
// balance (fees_collector='stripe'), so we can't pay it directly — instead
// we shrink our application fee by an estimate of it. Rancher nets
//   total − appFee − actualStripe ≈ promisedNet + (estimate − actual)
// Domestic cards (2.9% + 30¢) land within a cent of the promise; premium/
// international cards run hotter and the difference stays small change.
//
// FLOOR: BHC margin never absorbs below max($1, 2% of the charge) — a
// thin-margin transaction gets PARTIAL absorption rather than a negative
// or zero platform fee. The absorbed amount is returned for metadata /
// scorecard tracking, so the processing P&L is observable, never vibes.

/** Stripe's advertised US card rate — the estimate we absorb against. */
export function stripeFeeEstimateCents(totalChargeCents: number): number {
  const total = Math.max(0, Math.round(totalChargeCents));
  if (total === 0) return 0;
  return Math.round(total * 0.029) + 30;
}

export interface AbsorbResult {
  /** The application fee to actually charge (>= 0, <= grossFeeCents). */
  feeCents: number;
  /** How much Stripe-fee absorption the rancher received. */
  absorbedCents: number;
}

/**
 * Shrink BHC's gross application fee by the estimated Stripe fee, floored so
 * the platform never nets below max($1, 2% of the charge) — and never above
 * the original fee (absorption can only help the rancher).
 */
export function absorbStripeFee({
  grossFeeCents,
  totalChargeCents,
}: {
  grossFeeCents: number;
  totalChargeCents: number;
}): AbsorbResult {
  const gross = Math.max(0, Math.round(grossFeeCents));
  const total = Math.max(0, Math.round(totalChargeCents));
  if (gross === 0 || total === 0) return { feeCents: gross, absorbedCents: 0 };

  const est = stripeFeeEstimateCents(total);
  const floor = Math.min(gross, Math.max(100, Math.round(total * 0.02)));
  const feeCents = Math.min(gross, Math.max(floor, gross - est));
  return { feeCents, absorbedCents: gross - feeCents };
}

export interface AbsorptionPreview {
  /** Estimated Stripe processing fee on the full charge (product + shipping). */
  estCents: number;
  /** How much of that estimate BHC's margin actually absorbs at this price. */
  absorbedCents: number;
  /** The card-fee remainder the RANCHER eats when absorption is partial/zero. */
  shortfallCents: number;
}

/**
 * Dashboard preview twin of computeProductCharge's absorption math (qty=1) —
 * pure and client-safe, so the ProductsTab margin preview can tell the truth
 * on floor-bound cheap products. The FLOOR above means a thin-margin item
 * gets PARTIAL (or zero) absorption: "card processing is on us" is only true
 * when shortfallCents === 0. The preview must branch on this — never promise
 * full absorption the checkout math won't deliver (brand rule: never claim
 * "no stripe fees").
 *
 * Math parity: lib/productCheckout.ts computeProductCharge at quantity 1 —
 * gross fee = display − base (product margin only), estimate charged off the
 * FULL total including shipping (shipping is a passthrough, but Stripe's fee
 * applies to the whole charge).
 */
export function absorptionPreview({
  displayCents,
  baseCents,
  shippingCents,
}: {
  displayCents: number;
  baseCents: number;
  shippingCents: number;
}): AbsorptionPreview {
  const display = Math.max(0, Math.round(displayCents));
  const base = Math.max(0, Math.round(baseCents));
  const shipping = Math.max(0, Math.round(shippingCents));
  const total = display + shipping;
  const { absorbedCents } = absorbStripeFee({
    grossFeeCents: display - base,
    totalChargeCents: total,
  });
  const estCents = stripeFeeEstimateCents(total);
  return {
    estCents,
    absorbedCents,
    shortfallCents: Math.max(0, estCents - absorbedCents),
  };
}
