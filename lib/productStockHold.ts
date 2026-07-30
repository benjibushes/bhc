// lib/productStockHold.ts
//
// OVERSELL PREVENTION for the product rail (middle-journey audit 2026-07-29).
//
// THE RACE: the stock gate runs at session-mint (lib/productBuyGates) and the
// inventory decrement at settlement (lib/productSettlement) — minutes apart.
// Two simultaneous buyers of the LAST unit both pass the gate, both get a
// payable session, both charge; the settlement clamp then fires the OVERSOLD
// operator alert AFTER the money moved. Detection, not prevention.
//
// THE FIX: a short-TTL Redis hold taken at mint. One counter per product
// (`bhc:product-hold:<id>`), INCRBY'd by the quantity being minted, 15-minute
// TTL (a Stripe Checkout session is either paid or abandoned well inside
// that). The gate's available stock becomes `Orders Left − active holds`, so
// the second simultaneous buyer of the last unit is refused a session instead
// of a refund. Settlement releases the hold as it decrements Orders Left.
//
// DEGRADE OPEN (same posture as claimOnce, and deliberately opposite of
// claimSyncLock): no Redis env, or Redis erroring → holds are skipped and the
// gate behaves exactly as before this module existed (alert-only oversell).
// A Redis outage must never block a sale — an occasional oversell alert is
// strictly cheaper than a dead checkout.
//
// APPROXIMATION, BY DESIGN: the counter TTL is refreshed on every acquire and
// a settle-side release can slightly under-count if a hold already expired
// (clamped at zero, key deleted). Worst case the system briefly reverts to
// today's alert-only behavior — never blocks a legitimate sale for long, and
// never double-ships on its own (the settlement clamp + OVERSOLD alert stay).

import { Redis } from '@upstash/redis';

/** How long a mint's hold shadows the stock before self-expiring. */
export const STOCK_HOLD_TTL_SEC = 15 * 60;

// ── Pure decision logic (unit-tested) ───────────────────────────────────────

/** Does this product track stock at all? Mirrors the gate's Orders Left read. */
export function stockIsTracked(leftRaw: unknown): boolean {
  return leftRaw !== undefined && leftRaw !== null && leftRaw !== '';
}

/**
 * Sellable units once active holds are subtracted. Holds can transiently
 * exceed Orders Left (expired-but-not-yet-cleared, admin restock down) —
 * clamp at zero, never negative.
 */
export function availableAfterHolds(ordersLeft: number, activeHolds: number): number {
  const left = Number(ordersLeft);
  const holds = Math.max(0, Number(activeHolds) || 0);
  if (!Number.isFinite(left)) return 0;
  return Math.max(0, Math.floor(left) - Math.floor(holds));
}

/**
 * The atomic-acquire decision: after INCRBY(quantity), the counter holds
 * `totalHoldsAfterIncr` (OUR quantity included). The acquire stands only if
 * every held unit — ours included — fits inside Orders Left. Two simultaneous
 * last-unit buyers both INCR; exactly one sees total <= ordersLeft.
 */
export function holdFits(ordersLeft: number, totalHoldsAfterIncr: number): boolean {
  const left = Number(ordersLeft);
  const total = Number(totalHoldsAfterIncr);
  if (!Number.isFinite(left) || !Number.isFinite(total)) return false;
  return total <= left;
}

// ── Redis wiring (mirrors lib/rancherCapacity's lazy client) ────────────────

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

function holdKey(productId: string): string {
  return `bhc:product-hold:${productId}`;
}

export type StockHoldResult =
  | { ok: true }
  | { ok: false; available: number };

/**
 * Take a mint-time hold of `quantity` units against the product's counter.
 * Atomic under burst: INCRBY first, then judge the post-increment total — the
 * loser of a last-unit race rolls its own increment back and is refused.
 *
 * `ordersLeft` is the Airtable truth the caller already read (the gate has the
 * product row in hand — no extra read here).
 *
 * Degrades OPEN: missing Redis env or any Redis error → { ok: true }.
 */
export async function acquireStockHold(
  productId: string,
  quantity: number,
  ordersLeft: number,
): Promise<StockHoldResult> {
  const redis = getRedis();
  if (!redis) return { ok: true };
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));
  try {
    const key = holdKey(productId);
    const total = await redis.incrby(key, qty);
    // Refresh the TTL on every acquire — the counter only needs to outlive
    // the newest in-flight checkout, and an un-TTL'd key would pin phantom
    // holds forever after a crash between INCRBY and EXPIRE elsewhere.
    await redis.expire(key, STOCK_HOLD_TTL_SEC);
    if (holdFits(ordersLeft, total)) return { ok: true };
    // Lost the race (or stock is thinner than the holds) — put our units
    // back so a refused mint never consumes phantom stock, then report what
    // IS available so the route can speak precisely.
    await redis.decrby(key, qty).catch?.(() => {});
    return { ok: false, available: availableAfterHolds(ordersLeft, total - qty) };
  } catch (e: any) {
    console.error('[acquireStockHold] Redis failed (allowing — degrade open):', e?.message);
    return { ok: true };
  }
}

/**
 * Release `quantity` held units — called from settlement as Orders Left is
 * decremented (the hold's job is done: the units now live in the Airtable
 * truth). Clamps at zero and deletes the key so an expired-hold release can
 * never wedge the counter negative. Best-effort: errors are logged, never
 * thrown — the TTL is the backstop.
 */
export async function releaseStockHold(productId: string, quantity: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));
  try {
    const key = holdKey(productId);
    const n = await redis.decrby(key, qty);
    if (n <= 0) await redis.del(key);
  } catch (e: any) {
    console.error('[releaseStockHold] Redis failed (TTL will expire the hold):', e?.message);
  }
}
