// ProductCard — THE product card. One card for the /shop marketplace grid and
// any future product ladder (rancher pages, dashboard previews), so a product
// renders identically everywhere it appears.
//
// Design-system rules (Phase 3): brand tokens only (bone/charcoal/saddle/dust/
// sage via classes), serif name + PriceTag, image locked to aspect-[4/3] on a
// bone-deep placeholder so uneven rancher uploads still grid cleanly, square
// corners, border elevation (Western paper, not Material — no drop shadows).
//
// ALIGNMENT (Phase 7 "real structure"): every text zone is height-stable —
// name clamps to 2 lines with a 2-line reserve, rancher line clamps to 1,
// description clamps to 2 — so the price row and buy button land at the same
// y-position on every card in a row. No more ragged grids.
//
// DEPOSIT-STYLE products (price-range, e.g. the $95–355 ground box): the
// price row reads "from $95–355", the sub-line explains the deposit mechanic,
// and the CTA says "reserve — $X deposit". Checkout charges Display Price
// exactly as a fixed product — presentation only.

import Link from 'next/link';
import ProductImage from '../shop/ProductImage';
import BuyButton from '../shop/BuyButton';
import PriceTag from './PriceTag';
import { operationTypeFor } from '@/lib/operationType';

export interface ProductCardProduct {
  id: string;
  name: string;
  price: number;
  rancher?: string;
  weight?: string;
  description?: string;
  image?: string;
  shelfStable?: boolean;
  depositStyle?: boolean;
  priceRange?: string;
  ordersLeft?: number | null;
  /** Per-order shipping in dollars; 0/undefined = shipping included in price. */
  shippingCost?: number;
  /** Pickup-at-the-ranch product — renders only on the rancher's own page. */
  localOnly?: boolean;
  /** Airtable Category (MarketplaceProduct rows) — feeds the operation-type
   *  label so merch never claims "ships frozen". */
  category?: string;
  /** Browse-group key (StandProduct rows) — same job as category. */
  group?: string;
  /** BYOC (2026-07-08): when set (rancher-page surfaces only), the buy action
   *  links out to the rancher's own store via /go/[id] instead of BHC
   *  checkout. /shop never passes this. */
  externalHref?: string;
  /** When set (and no externalHref), replaces the buy button with a quiet
   *  note — used when the ranch can't take an online charge yet (Connect
   *  not active) so a buyer is never sent into a checkout that 409s. */
  buyNote?: string;
}

export default function ProductCard({ p, compact = false }: { p: ProductCardProduct; compact?: boolean }) {
  const href = `/shop/${p.id}`;
  const deposit = !!p.depositStyle;
  // Operation-type label (P4, marketing-revamp principle 4): which KIND of
  // outfit is this? Null for pickup rows (their own copy already labels them)
  // — the caption simply doesn't render.
  const opType = operationTypeFor({
    type: 'product',
    localOnly: p.localOnly,
    shelfStable: p.shelfStable,
    depositStyle: p.depositStyle,
    category: p.category,
    group: p.group,
  });
  // compact = marketplace-grid variant (2-up mobile): square image, tighter
  // type/padding, description hidden. Full variant unchanged for the rancher
  // page + funnel rails.
  return (
    <div className="bg-bone rounded-2xl overflow-hidden flex flex-col elev-hover transition-base hover:-translate-y-1">
      <Link href={href} className={`block ${compact ? 'aspect-square' : 'aspect-[4/3]'} overflow-hidden bg-bone-deep`}>
        <ProductImage src={p.image || ''} alt={p.name} className="w-full h-full object-cover block" />
      </Link>
      <div className={`${compact ? 'p-2.5 gap-1.5' : 'p-4 gap-2'} flex flex-col flex-1`}>
        <div className={compact ? 'min-h-[2.6rem]' : 'min-h-[3.6rem]'}>
          <Link href={href} className={`font-serif ${compact ? 'text-[15px]' : 'text-lg'} leading-tight text-charcoal line-clamp-2`}>
            {p.name}
          </Link>
          <div className={`${compact ? 'text-[11px]' : 'text-xs'} text-saddle mt-0.5 line-clamp-1`}>
            {p.rancher}
            {p.weight ? ` · ${p.weight}` : ''}
          </div>
        </div>

        {/* Price row — height-stable across fixed + deposit-style cards. */}
        {deposit ? (
          <div className="leading-tight">
            <span className="font-serif text-lg text-charcoal">from {p.priceRange || `$${p.price.toFixed(0)}`}</span>
            <span className="block text-[11px] text-saddle mt-0.5">
              reserve with a ${p.price.toFixed(0)} deposit
            </span>
          </div>
        ) : (
          <PriceTag amount={p.price} size="sm" />
        )}

        {!compact && p.description ? (
          <p className="text-[13px] text-charcoal/80 leading-snug m-0 line-clamp-2">{p.description}</p>
        ) : null}

        {/* Operation-type label (P4): the KIND of outfit, stated before the
            shipping mechanics. Renders nothing when classification is
            uncertain (and for pickup rows, whose line below already says it). */}
        {opType ? (
          <div className={`${compact ? 'text-[11px]' : 'text-[13px]'} text-saddle line-clamp-1`}>
            {opType.label}
          </div>
        ) : null}

        <div className={`${compact ? 'text-[11px]' : 'text-xs'} line-clamp-1 ${p.localOnly ? 'text-saddle font-medium' : 'text-sage'}`}>
          {p.localOnly
            ? 'local pickup at the ranch — no shipping'
            : deposit
              ? compact
                ? 'size + balance confirmed before shipping'
                : 'your rancher confirms size + the balance before it ships'
              : p.shippingCost && p.shippingCost > 0
                ? `${p.shelfStable ? 'shelf-stable' : 'ships frozen'} · + $${p.shippingCost.toFixed(2)} shipping`
                : p.shelfStable
                  ? compact ? 'shelf-stable · ships free' : 'shelf-stable · ships free, no freezer needed'
                  : 'ships frozen · shipping included'}
        </div>

        {/* Real scarcity only — the grid never shows sold-out rows, so any
            count here is a true remaining-batch number ('Orders Left' in
            Airtable; blank = unlimited and renders NOTHING). At ≤5 it earns
            the louder farmers-market chip; 6–10 keeps the quiet line. A
            <span>, not an <a>/<button> — the globals.css pill-rule only
            targets interactive elements, but rounded-sm is set anyway. */}
        {p.ordersLeft != null && p.ordersLeft > 0 && p.ordersLeft <= 5 ? (
          <div>
            <span className="inline-block text-[11px] font-medium text-amber-dark bg-amber/15 border border-amber/40 rounded-sm px-1.5 py-0.5">
              only {p.ordersLeft} left this cycle
            </span>
          </div>
        ) : p.ordersLeft != null && p.ordersLeft > 0 && p.ordersLeft <= 10 ? (
          <div className="text-[11px] text-saddle">
            {p.ordersLeft} orders left from this batch
          </div>
        ) : null}

        <div className="mt-auto pt-1">
          {p.externalHref ? (
            <a
              href={p.externalHref}
              className="block w-full text-center bg-charcoal text-bone py-2.5 rounded-full text-sm transition-base hover:bg-charcoal/85"
            >
              buy on their store &rarr;
            </a>
          ) : p.buyNote ? (
            <div className="text-[12.5px] text-saddle text-center border border-dust rounded-full py-2.5 px-2">
              {p.buyNote}
            </div>
          ) : (
            <BuyButton
              productId={p.id}
              price={p.price}
              label={deposit ? `reserve — $${p.price.toFixed(0)} deposit` : undefined}
            />
          )}
        </div>
      </div>
    </div>
  );
}
