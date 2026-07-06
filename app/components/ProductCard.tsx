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
}

export default function ProductCard({ p }: { p: ProductCardProduct }) {
  const href = `/shop/${p.id}`;
  const deposit = !!p.depositStyle;
  return (
    <div className="bg-bone border border-dust flex flex-col transition-base hover:border-charcoal">
      <Link href={href} className="block aspect-[4/3] overflow-hidden bg-bone-deep">
        <ProductImage src={p.image || ''} alt={p.name} className="w-full h-full object-cover block" />
      </Link>
      <div className="p-4 flex flex-col gap-2 flex-1">
        <div className="min-h-[3.6rem]">
          <Link href={href} className="font-serif text-lg leading-tight text-charcoal line-clamp-2">
            {p.name}
          </Link>
          <div className="text-xs text-saddle mt-0.5 line-clamp-1">
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

        {p.description ? (
          <p className="text-[13px] text-charcoal/80 leading-snug m-0 line-clamp-2">{p.description}</p>
        ) : null}

        <div className="text-xs text-sage line-clamp-1">
          {deposit
            ? 'your rancher confirms size + the balance before it ships'
            : p.shelfStable
              ? 'shelf-stable · ships free, no freezer needed'
              : 'ships frozen · shipping included'}
        </div>

        <div className="mt-auto pt-1">
          <BuyButton
            productId={p.id}
            price={p.price}
            label={deposit ? `reserve — $${p.price.toFixed(0)} deposit` : undefined}
          />
        </div>
      </div>
    </div>
  );
}
