// LowTicketRail — the sectioned, MARKETED low-ticket next step on the funnel
// reveal (Phase 8). Every buyer who isn't ready for a whole-or-bulk order
// still leaves /access with a real, priced thing they can buy today — actual
// products with photos and one-tap checkout, not a text-link whisper.
//
// Two variants, placed by intent temperature:
//   full    — waitlist / nurture reveals (no share in motion): a merchandised
//             3-product section. This buyer has NOTHING else to buy — sell.
//   compact — matched / call reveals (share in motion): one quiet bordered
//             line. Never competes with the share; the share is the anchor.
//   (The deposit-capable reveal gets NO rail at all — peak money moment.)
//
// Products arrive as props (loaded server-side on /access via
// pickFunnelProducts) — no client fetch, no layout pop-in. Renders nothing if
// the list is empty, so a thin catalog can never produce a broken section.

import Link from 'next/link';
import ProductImage from '../../shop/ProductImage';
import type { MarketplaceProduct } from '@/lib/marketplaceProducts';

export default function LowTicketRail({
  picks,
  variant,
  eyebrow,
  title,
}: {
  picks: MarketplaceProduct[];
  variant: 'full' | 'compact';
  eyebrow?: string;
  title?: string;
}) {
  if (!picks || picks.length === 0) return null;

  if (variant === 'compact') {
    // True price floor across ALL picks (picks[0] is only the cheapest of the
    // first group), and never quote a deposit-style deposit as a full price.
    const floor = Math.min(...picks.map((p) => p.price));
    const floorIsDeposit = picks.find((p) => p.price === floor)?.depositStyle === true;
    return (
      <div className="border-t border-dust pt-4 mt-2">
        <p className="text-center text-sm text-saddle">
          want a taste while it comes together? jerky &amp; boxes from ${floor.toFixed(2)}
          {floorIsDeposit ? ' down' : ''}, shipped —{' '}
          <Link href="/shop" className="underline hover:text-charcoal transition-colors">
            shop small &rarr;
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-dust bg-white p-5 text-left space-y-4">
      <div>
        <p className="text-xs uppercase tracking-widest text-saddle">
          {eyebrow || 'or start smaller — today'}
        </p>
        <h3 className="mt-1 font-serif text-xl text-charcoal">
          {title || 'real beef from these same ranches, shipped this week'}
        </h3>
      </div>

      <div className="space-y-2.5">
        {picks.map((p) => (
          <div key={p.id} className="flex items-center gap-3 border border-dust bg-bone p-2.5">
            <Link
              href={`/shop/${p.id}`}
              className="block w-14 h-14 shrink-0 overflow-hidden bg-bone-deep"
            >
              <ProductImage src={p.image} alt={p.name} className="w-full h-full object-cover block" />
            </Link>
            <div className="flex-1 min-w-0">
              <Link href={`/shop/${p.id}`} className="font-serif text-[15px] leading-tight text-charcoal line-clamp-1">
                {p.name}
              </Link>
              <div className="text-xs text-saddle line-clamp-1">
                {p.depositStyle
                  ? <>from {p.priceRange || `$${p.price.toFixed(0)}`} · ${p.price.toFixed(0)} deposit</>
                  : <>${p.price.toFixed(2)}{p.weight ? ` · ${p.weight}` : ''} · {p.shippingCost > 0 ? `+ $${p.shippingCost.toFixed(2)} shipping` : 'shipping included'}</>}
              </div>
            </div>
            <Link
              href={`/shop/checkout/${p.id}`}
              className="shrink-0 px-3.5 py-2 bg-charcoal text-bone text-xs font-medium uppercase tracking-wider hover:bg-saddle transition-colors whitespace-nowrap"
            >
              {p.depositStyle ? 'reserve' : 'buy'} &rarr;
            </Link>
          </div>
        ))}
      </div>

      <p className="text-xs text-saddle">
        shipped frozen or shelf-stable, straight from the ranch ·{' '}
        <Link href="/shop" className="underline hover:text-charcoal transition-colors">
          see the whole shop &rarr;
        </Link>
      </p>
    </div>
  );
}
