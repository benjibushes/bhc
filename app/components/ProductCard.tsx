// ProductCard — THE product card. One card for the /shop marketplace grid and
// any future product ladder (rancher pages, dashboard previews), so a product
// renders identically everywhere it appears.
//
// Design-system rules (Phase 3): brand tokens only (bone/charcoal/saddle/dust/
// sage via classes), serif name + PriceTag, image locked to aspect-[4/3] on a
// bone-deep placeholder so uneven rancher uploads still grid cleanly, square
// corners, border elevation (Western paper, not Material — no drop shadows).

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
}

export default function ProductCard({ p }: { p: ProductCardProduct }) {
  const href = `/shop/${p.id}`;
  return (
    <div className="bg-bone border border-dust flex flex-col transition-base hover:border-charcoal">
      <Link href={href} className="block aspect-[4/3] overflow-hidden bg-bone-deep">
        <ProductImage src={p.image || ''} alt={p.name} className="w-full h-full object-cover block" />
      </Link>
      <div className="p-4 flex flex-col gap-2 flex-1">
        <div>
          <Link href={href} className="font-serif text-lg leading-tight text-charcoal">
            {p.name}
          </Link>
          <div className="text-xs text-saddle mt-0.5">
            {p.rancher}
            {p.weight ? ` · ${p.weight}` : ''}
          </div>
        </div>
        {/* Standalone, scannable price at name level (not only inside the CTA). */}
        <PriceTag amount={p.price} size="sm" />
        {p.description ? (
          <p className="text-[13px] text-charcoal/80 leading-snug m-0">{p.description}</p>
        ) : null}
        <div className="text-xs text-sage">
          {p.shelfStable
            ? 'shelf-stable · ships free, no freezer needed'
            : 'ships frozen · shipping included'}
        </div>
        <div className="mt-auto pt-1">
          <BuyButton productId={p.id} price={p.price} />
        </div>
      </div>
    </div>
  );
}
