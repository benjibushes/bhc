// lib/productSettlementNet.ts
//
// Pure selection logic for the product settlement safety-net cron
// (app/api/cron/product-settlement-net). Split out so the "which paid PIs are
// missing an order row" decision is unit-testable without Stripe/Airtable.
//
// WHY THE NET EXISTS (checkout audit 2026-07-14, critical #1): the Rancher
// Orders row is born INSIDE the connect webhook's settlement handler. If that
// webhook never lands (endpoint unregistered, secret drift past Stripe's
// ~3-day retry) or settlement dies permanently (malformed metadata), the
// buyer's card is charged and the funds split into the rancher's account with
// NO order row, NO receipt, NO rancher ship-to email, and NO inventory
// decrement — permanently invisible. The deposit rail has a reaper; the
// product rail had none. This net re-derives orders from Stripe truth.

export interface SettlementCandidatePi {
  id: string;
  status?: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * From a batch of PaymentIntents listed off a connected account, pick the ones
 * the net must (re)settle: succeeded product purchases whose PI id is NOT
 * already recorded on a Rancher Orders row.
 *
 * existingPiIds: PI ids that already have an order row (looked up by the
 * caller). Comparison is exact-id; blank/malformed PIs are skipped rather
 * than settled (settleProductPurchase would throw PermanentSettlementError
 * on them anyway — the cron reports those separately).
 */
export function productPisNeedingSettlement(
  pis: SettlementCandidatePi[],
  existingPiIds: ReadonlySet<string>,
): SettlementCandidatePi[] {
  return (pis || []).filter((pi) => {
    if (!pi || typeof pi.id !== 'string' || pi.id.trim() === '') return false;
    if (pi.status !== 'succeeded') return false;
    const metaType = String(pi.metadata?.type ?? '');
    if (metaType !== 'product_purchase') return false;
    return !existingPiIds.has(pi.id);
  });
}
