// lib/productRecovery.ts
//
// PHASE 3 — owned-side product remarketing. Pure selectors + renderers for the
// product-recovery cron. POST-PURCHASE ONLY, by design: the self-serve product
// checkout captures no email before payment, so anonymous PDP/checkout
// abandoners are unreachable on the owned side — they're Meta's job (the Phase-2
// ViewContent/InitiateCheckout pixel events feed those retargeting audiences).
// What the owned side CAN do is talk to people whose email we already have — the
// product BUYERS — so this module drives two once-ever nudges off a PRODUCT_BUYER
// Consumer:
//
//   CROSS-SELL (earlier, ~10d): "you tasted it — the freezer fill is next." The
//     ladder-up to a share (the anchor). → /map.  Stamp: Share Cross-Sell Sent At.
//   REPEAT     (later, ~35d):   "running low? restock." Recurring revenue on the
//     same product. → /shop.     Stamp: Product Repeat Nudged At.
//
// PURE: every function is dependency-free decision/format logic over plain
// Airtable-shaped Consumer rows (mirrors lib/reserveRecovery + lib/replenishment)
// so it unit-tests with zero network. The cron (app/api/cron/product-recovery)
// does the read, the claim-before-send stamp, and the send.

const DAY = 86_400_000;

// ── Tunable windows (cron overrides via env) ─────────────────────────────────
export const DEFAULT_CROSSSELL_MIN_DAYS = 10;      // wait after a buy before pitching the share
export const DEFAULT_CROSSSELL_LATE_CAP_DAYS = 90;  // don't pitch buyers older than this
export const DEFAULT_REPEAT_DAYS = 35;              // reorder window after last buy
export const DEFAULT_REPEAT_LATE_CAP_DAYS = 120;    // go-live guard: don't blast ancient buyers

export const PRODUCT_BUYER_STAGE = 'PRODUCT_BUYER';

// Airtable field names the cron stamps (idempotency) + reads. Ben adds these to
// the Consumers table (see the cron header). One-nudge-ever per stamp.
export const PRODUCT_REPEAT_FIELD = 'Product Repeat Nudged At';
export const PRODUCT_CROSSSELL_FIELD = 'Share Cross-Sell Sent At';

// Template names (for the Email Sends log; NOT frequency-whitelisted — these are
// marketing, so they correctly respect the 3/week cap like the replenishment nudge).
export const REPEAT_TEMPLATE = 'productRepeatNudge';
export const CROSSSELL_TEMPLATE = 'productShareCrossSell';

const SUPPRESSED_STATUSES: ReadonlySet<string> = new Set([
  'Unsubscribed',
  'Bounced',
  'Complained',
  'Spam',
]);

export interface ProductBuyerLike {
  id?: string;
  Email?: unknown;
  'Full Name'?: unknown;
  Status?: unknown;
  'Buyer Stage'?: unknown;
  'Last Product Bought'?: unknown;
  'Last Product Bought At'?: unknown;
  'Product Buyer Rancher'?: unknown;
  'Product Repeat Nudged At'?: unknown;
  'Share Cross-Sell Sent At'?: unknown;
}

export interface ProductRecoveryOptions {
  crossSellMinDays?: number;
  crossSellLateCapDays?: number;
  repeatDays?: number;
  repeatLateCapDays?: number;
  now?: number;
}

function toMs(v: unknown): number {
  if (!v) return 0;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Reachable by email + not a suppressed contact. */
export function isContactable(c: ProductBuyerLike): boolean {
  const email = String(c.Email || '').trim();
  if (!email || !email.includes('@')) return false;
  if (SUPPRESSED_STATUSES.has(String(c.Status || '').trim())) return false;
  return true;
}

function isProductBuyer(c: ProductBuyerLike): boolean {
  return String(c['Buyer Stage'] || '').trim() === PRODUCT_BUYER_STAGE;
}

/** Days since this buyer's last product purchase (0 if unknown). */
export function daysSinceLastBuy(c: ProductBuyerLike, now: number = Date.now()): number {
  const t = toMs(c['Last Product Bought At']);
  if (!t) return 0;
  return Math.floor((now - t) / DAY);
}

/**
 * CROSS-SELL eligibility: a PRODUCT_BUYER, contactable, never share-pitched,
 * whose purchase is in the [min, cap] day window. The share is the anchor — a
 * few days after a first taste is the moment to pitch the freezer-fill.
 */
export function isCrossSellEligible(c: ProductBuyerLike, opts: ProductRecoveryOptions = {}): boolean {
  if (!isProductBuyer(c) || !isContactable(c)) return false;
  if (c['Share Cross-Sell Sent At']) return false; // one ever
  const boughtAt = toMs(c['Last Product Bought At']);
  if (!boughtAt) return false;
  const now = opts.now ?? Date.now();
  const days = (now - boughtAt) / DAY;
  const min = opts.crossSellMinDays ?? DEFAULT_CROSSSELL_MIN_DAYS;
  const cap = opts.crossSellLateCapDays ?? DEFAULT_CROSSSELL_LATE_CAP_DAYS;
  return days >= min && days <= cap;
}

/**
 * REPEAT eligibility: a PRODUCT_BUYER, contactable, never repeat-nudged, whose
 * purchase is old enough to be running low ([repeatDays, lateCap] window).
 */
export function isRepeatEligible(c: ProductBuyerLike, opts: ProductRecoveryOptions = {}): boolean {
  if (!isProductBuyer(c) || !isContactable(c)) return false;
  if (c['Product Repeat Nudged At']) return false; // one ever
  const boughtAt = toMs(c['Last Product Bought At']);
  if (!boughtAt) return false;
  const now = opts.now ?? Date.now();
  const days = (now - boughtAt) / DAY;
  const win = opts.repeatDays ?? DEFAULT_REPEAT_DAYS;
  const cap = opts.repeatLateCapDays ?? DEFAULT_REPEAT_LATE_CAP_DAYS;
  return days >= win && days <= cap;
}

export type ProductNudge = 'crosssell' | 'repeat' | null;

/**
 * The single next nudge for a buyer (cross-sell takes precedence — the share is
 * the higher-value ladder-up, and it fires in an earlier window). null = nothing
 * to do now. One send per buyer per run; the stamps make each a once-ever touch,
 * so a buyer can get cross-sell now and repeat weeks later without collision.
 */
export function nextProductNudge(c: ProductBuyerLike, opts: ProductRecoveryOptions = {}): ProductNudge {
  if (isCrossSellEligible(c, opts)) return 'crosssell';
  if (isRepeatEligible(c, opts)) return 'repeat';
  return null;
}

/** Filter to buyers needing a cross-sell / repeat. Pure. */
export function selectCrossSell<T extends ProductBuyerLike>(cs: T[], opts: ProductRecoveryOptions = {}): T[] {
  return (cs || []).filter((c) => isCrossSellEligible(c, opts));
}
export function selectRepeat<T extends ProductBuyerLike>(cs: T[], opts: ProductRecoveryOptions = {}): T[] {
  return (cs || []).filter((c) => isRepeatEligible(c, opts));
}

// ─────────────────────────────────────────────────────────────────────
// COPY (on-brand: lowercase, honest, no fake scarcity, "— Ben")
// ─────────────────────────────────────────────────────────────────────

export interface NudgeCtx {
  firstName: string;
  product: string; // the product they bought
  rancher: string; // the ranch they bought from
  url: string; // destination (/map for cross-sell, /shop for repeat)
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function wrap(bodyHtml: string, ctaLabel: string, url: string): string {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#17130E;">
${bodyHtml}
<p style="margin:22px 0;"><a href="${esc(url)}" style="display:inline-block;padding:12px 24px;background:#17130E;color:#F4F1EC;text-decoration:none;font-weight:600;font-size:14px;">${esc(ctaLabel)}</a></p>
<p style="font-size:12px;color:#A7A29A;">— Ben<br>BuyHalfCow</p>
</div>`;
}

/** Cross-sell to a share (the ladder-up). Pure. */
// Campaign-rewrite (2026-08-18): "the best price per pound you'll find" was a
// sell-on-savings superlative (D2C beef is often MORE per pound than grocery,
// and the claim is unverifiable as written). The honest version is relative to
// the SAME beef: per pound, a share is the cheapest way to buy this ranch's
// beef. Hyphens dropped from the outbound copy per the Ben rule.
export function renderCrossSellEmail(ctx: NudgeCtx): RenderedEmail {
  const first = esc(ctx.firstName || 'there');
  const product = esc(ctx.product || 'your order');
  const rancher = esc(ctx.rancher || 'the ranch');
  const subject = `you tasted it, ${ctx.firstName || 'there'} — the freezer fill is next`;
  const html = wrap(
    `<p style="margin:14px 0;font-size:15px;line-height:1.6;">hey ${first},</p>
<p style="margin:14px 0;font-size:15px;line-height:1.6;">you tried the <strong>${product}</strong> from <strong>${rancher}</strong>. if it earned a spot in the rotation, the honest next step is a share — the same beef by the freezer full, and per pound a share is the lowest this beef ever costs.</p>
<p style="margin:14px 0;font-size:15px;line-height:1.6;">one animal, one ranch, months of dinners. no rush — the box is always here if you'd rather keep it small.</p>`,
    'find a ranch →',
    ctx.url,
  );
  return { subject, html };
}

/** Repeat / reorder the same product. Pure. */
export function renderRepeatEmail(ctx: NudgeCtx): RenderedEmail {
  const first = esc(ctx.firstName || 'there');
  const product = esc(ctx.product || 'your last order');
  const rancher = esc(ctx.rancher || 'the ranch');
  const subject = `running low, ${ctx.firstName || 'there'}?`;
  const html = wrap(
    `<p style="margin:14px 0;font-size:15px;line-height:1.6;">hey ${first},</p>
<p style="margin:14px 0;font-size:15px;line-height:1.6;">you grabbed the <strong>${product}</strong> from <strong>${rancher}</strong> a few weeks back. if the freezer's getting low, it's an easy restock — same beef, shipped to your door.</p>`,
    'reorder →',
    ctx.url,
  );
  return { subject, html };
}
