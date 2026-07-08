// lib/productBuyGates.ts
//
// THE shared purchase gate (Payment Element migration, PR A — spec:
// docs/CHECKOUT-PAYMENT-ELEMENT-SPEC.md §3). Both product charge mints —
// the Checkout Session route (/api/checkout/product/buy) and the raw
// PaymentIntent route (/api/checkout/product/intent) — resolve a purchase
// through this ONE function, so their gates can never drift.
//
// Gate order (byte-parity with the original buy route):
//   product id shape → product exists + Active → Ships Nationwide not
//   explicitly false → in stock → price/base sane (0 < base <= display) →
//   quantity clamped 1-5 (deposit-style forced 1) + qty <= Orders Left →
//   rancher exists + Connect status 'active' + account id present.
//
// Returns a discriminated union — routes map {status,error} straight into
// NextResponse.json. Buyer-facing error strings live HERE so both routes
// speak identically.

import { getRecordById, TABLES } from '@/lib/airtable';
import { hasStock } from '@/lib/marketplaceProducts';

export interface ResolvedProductPurchase {
  ok: true;
  product: any;
  rancher: any;
  connectAccountId: string;
  productName: string;
  rancherId: string;
  rancherName: string;
  displayCents: number;
  baseCents: number;
  shippingCents: number;
  quantity: number;
  depositStyle: boolean;
  /** Pickup-at-the-ranch product (Ships Nationwide explicitly false). */
  localOnly: boolean;
  /** display×qty + shipping — what the buyer's card is charged. */
  totalCents: number;
}

export interface RejectedProductPurchase {
  ok: false;
  status: number;
  error: string;
}

export async function resolveProductPurchase(input: {
  productId: string;
  quantity?: number;
}): Promise<ResolvedProductPurchase | RejectedProductPurchase> {
  const productId = String(input.productId || '').trim();
  if (!/^rec[A-Za-z0-9]{14}$/.test(productId)) {
    return { ok: false, status: 400, error: 'Invalid product' };
  }

  const product: any = await getRecordById(TABLES.RANCHER_PRODUCTS, productId).catch(() => null);
  if (!product || !product['Active']) {
    return { ok: false, status: 404, error: 'That product is unavailable.' };
  }
  // LOCAL PICKUP (2026-07-07): Ships Nationwide=false is a sellable pickup
  // product (Active is the delist switch). It charges with pickup semantics —
  // NO shipping fee, and every downstream surface (metadata → settlement →
  // emails) says pickup instead of ship. Zero-mismatch: the flag rides the
  // whole rail from this one read.
  const localOnly = product['Ships Nationwide'] === false;
  if (!hasStock(product)) {
    return { ok: false, status: 409, error: 'That one just sold out — more coming.' };
  }

  const displayCents = Math.round(Number(product['Display Price'] || 0) * 100);
  const baseCents = Math.round(Number(product['Rancher Base'] || 0) * 100);
  if (!displayCents || !baseCents || baseCents > displayCents) {
    return { ok: false, status: 409, error: 'That product is not ready to sell yet.' };
  }

  const depositStyle = product['Deposit Style'] === true;
  // Shipping passthrough: buyer pays it, rancher keeps 100%. Deposit-style
  // always 0 (shipping settles with the balance); LOCAL PICKUP always 0 —
  // charging a shipping fee on a pickup product is exactly the mismatch this
  // rail exists to make impossible.
  const shippingCents = depositStyle || localOnly
    ? 0
    : Math.max(0, Math.round(Number(product['Shipping Cost'] || 0) * 100));

  // Quantity: clamped, never trusted raw; checked against real stock.
  const rawQty = Number(input.quantity || 1);
  let quantity = Number.isInteger(rawQty) ? Math.min(5, Math.max(1, rawQty)) : 1;
  if (depositStyle) quantity = 1;
  const leftRaw = product['Orders Left'];
  if (leftRaw !== undefined && leftRaw !== null && leftRaw !== '' && quantity > Number(leftRaw)) {
    return { ok: false, status: 409, error: `only ${Number(leftRaw)} left from this batch — lower the quantity.` };
  }

  const rancherId = String(product['Rancher Record ID'] || '').trim();
  const rancher: any = rancherId
    ? await getRecordById(TABLES.RANCHERS, rancherId).catch(() => null)
    : null;
  if (!rancher || String(rancher['Stripe Connect Status'] || '') !== 'active') {
    return { ok: false, status: 409, error: "That ranch can't take orders right now." };
  }
  const connectAccountId = String(rancher['Stripe Connect Account Id'] || '').trim();
  if (!connectAccountId) {
    return { ok: false, status: 409, error: "That ranch can't take orders right now." };
  }

  return {
    ok: true,
    product,
    rancher,
    connectAccountId,
    productName: String(product['Product Name'] || 'Product'),
    rancherId,
    rancherName: String(product['Rancher Name'] || rancher['Ranch Name'] || 'the ranch'),
    displayCents,
    baseCents,
    shippingCents,
    quantity,
    depositStyle,
    localOnly,
    totalCents: displayCents * quantity + shippingCents,
  };
}
