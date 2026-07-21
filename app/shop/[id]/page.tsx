// app/shop/[id]/page.tsx
//
// Product detail page (PDP). One product, the full story: hero photo, what's in
// the box, price, ships note, Buy. Jobs:
//   1. Give every product a shareable URL (/shop/<id>) an ad can point straight at.
//   2. Show the photo + "what's in the box" — the #1 low-ticket buy-driver.
//   3. Carry the trust the brand owns (verified ranch, real person, shipping
//      included) onto the exact page ads point at.
//   4. Emit Product JSON-LD (with free-shipping shippingDetails) for rich results.
// The Buy path stays one tap; the detail is the lift.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { jsonLdSafe } from '@/lib/jsonLdSafe';
import { getRecordById, getAllRecords, TABLES } from '@/lib/airtable';

import BuyButton from '../BuyButton';
import QtyBuy from '../QtyBuy';
import ProductImage from '../ProductImage';
import ProductViewTracker from './ProductViewTracker';
import Container from '../../components/Container';
import Card from '../../components/Card';
import Button from '../../components/Button';
import PriceTag from '../../components/PriceTag';
import ProductCard from '../../components/ProductCard';
import { loadProductsForRancher } from '@/lib/marketplaceProducts';

export const revalidate = 300;

const SITE_URL = 'https://www.buyhalfcow.com';

interface Prod {
  id: string;
  name: string;
  rancher: string;
  rancherId: string; // Ranchers record id ('' when unlinked)
  rancherSlug: string; // '' unless the ranch has a live public page
  rancherState: string;
  category: string;
  price: number;
  base: number;
  weight: string;
  shelfStable: boolean;
  image: string;
  description: string;
  // Deposit-style (price-range) product: price above is the DEPOSIT charged;
  // the rancher confirms size/details + the balance before shipping.
  depositStyle: boolean;
  priceRange: string;
  // Sold out (Orders Left = 0) — the page stays ALIVE for ad clicks with an
  // honest sold-out state instead of a 404 that wastes spend.
  soldOut: boolean;
  ordersLeft: number | null;
  // Product info (Phase 12) — what the buyer GETS + how the process works.
  whatsIncluded: string;
  shipsInDays: number | null;
  packaging: string;
  feeds: string;
  // Per-order shipping in dollars (0 = shipping included in the price).
  shippingCost: number;
  // Pickup-at-the-ranch product (Ships Nationwide explicitly false).
  localOnly: boolean;
}

const sel = (v: any) => (v && typeof v === 'object' ? v.name : v) || '';

// Only a SELLABLE product gets a page — same rule as the marketplace grid:
// Active + Ships Nationwide + priced with a non-negative margin. Anything else
// returns null → notFound().
async function loadProduct(id: string): Promise<Prod | null> {
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) return null;
  let r: any;
  try {
    r = await getRecordById(TABLES.RANCHER_PRODUCTS, id);
  } catch {
    return null;
  }
  if (!r) return null;
  const price = Number(r['Display Price'] || 0);
  const base = Number(r['Rancher Base'] || 0);
  // Same rule as isSellableRow EXCEPT stock: a sold-out (Orders Left = 0)
  // product keeps its page (ads point here — render "sold out", never 404);
  // anything else unsellable is a real 404.
  const sellableExceptStock =
    r['Active'] === true &&
    r['Ships Nationwide'] !== false &&
    price > 0 &&
    base > 0 &&
    base <= price;
  if (!sellableExceptStock) return null;
  const leftRaw = r['Orders Left'];
  const ordersLeft =
    leftRaw === undefined || leftRaw === null || leftRaw === '' ? null : Number(leftRaw);
  // Fail-closed like hasStock: junk/NaN counts as sold out (never renders a
  // buyable page whose checkout then rejects).
  const soldOut = ordersLeft !== null && !(ordersLeft > 0);

  // Best-effort: resolve the rancher's public page slug + state for the verified
  // trust link. Only link when the ranch has a LIVE page (never a dead link).
  let rancherSlug = '';
  let rancherState = '';
  const rancherRecId = String(r['Rancher Record ID'] || '').trim();
  if (rancherRecId) {
    try {
      const rr: any = await getRecordById(TABLES.RANCHERS, rancherRecId);
      if (rr) {
        rancherState = String(rr['State'] || '');
        if (rr['Page Live'] && !rr['Public Map Hidden']) rancherSlug = String(rr['Slug'] || '');
      }
    } catch { /* non-fatal — fall back to plain text */ }
  }

  return {
    id: r.id,
    name: String(r['Product Name'] || ''),
    rancher: String(r['Rancher Name'] || ''),
    rancherId: rancherRecId,
    rancherSlug,
    rancherState,
    category: String(sel(r['Category']) || ''),
    price,
    base,
    weight: String(r['Weight / Size'] || ''),
    shelfStable: !!r['Shelf Stable'],
    image: String(r['Image URL'] || ''),
    description: String(r['Description'] || ''),
    depositStyle: r['Deposit Style'] === true,
    priceRange: String(r['Price Range'] || ''),
    soldOut,
    ordersLeft,
    whatsIncluded: String(r["What's Included"] || ''),
    shipsInDays: Number(r['Ships In Days']) > 0 ? Number(r['Ships In Days']) : null,
    packaging: String(r['Packaging'] || ''),
    feeds: String(r['Feeds'] || ''),
    shippingCost: Math.max(0, Number(r['Shipping Cost'] || 0)),
    localOnly: r['Ships Nationwide'] === false,
  };
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const p = await loadProduct(id);
  if (!p) return { title: 'Shop real ranch beef, shipped nationwide' };
  // Title has no "| BuyHalfCow" — the layout template appends " — BuyHalfCow".
  const title = `${p.name} — ${p.rancher}`;
  const description =
    p.description ||
    (p.shippingCost > 0
      ? 'Real beef, shipped to your door from a family ranch.'
      : 'Real beef, shipped to your door from a family ranch. Shipping included.');
  const images = p.image ? [{ url: p.image }] : [];
  return {
    title,
    description,
    alternates: { canonical: `/shop/${p.id}` },
    openGraph: { title: `${title} | BuyHalfCow`, description, url: `/shop/${p.id}`, images },
    twitter: { card: 'summary_large_image', title: `${title} | BuyHalfCow`, description, images: p.image ? [p.image] : [] },
  };
}

// Verified-purchase reviews for this product (trust flywheel, 2026-07-06).
// Reads Rancher Orders rows the review-ask cron + tokened submit filled in.
// First name + state privacy rule matches the share-side testimonial wall.
async function loadProductReviews(
  productId: string,
): Promise<{ rating: number; text: string; who: string }[]> {
  try {
    const rows = (await getAllRecords(
      TABLES.RANCHER_ORDERS,
      `AND({Product Record ID}="${productId}", NOT({Review Submitted At}=""))`,
    )) as any[];
    return rows
      .filter((r) => Number(r['Buyer Rating']) >= 1)
      .map((r) => ({
        rating: Math.min(5, Math.max(1, Number(r['Buyer Rating']))),
        text: String(r['Buyer Review'] || '').trim(),
        who: String(r['Buyer Name'] || '').trim().split(/\s+/)[0] || 'verified buyer',
      }))
      .sort((a, b) => b.rating - a.rating);
  } catch {
    return []; // reviews are additive — a read blip never breaks the PDP
  }
}

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await loadProduct(id);
  if (!p) notFound();
  const reviews = await loadProductReviews(id);
  const avgRating = reviews.length
    ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
    : 0;

  // Cross-sell: the same ranch's other live products (audit fix — the PDP had
  // no onward path to them, including on the sold-out state ads land on).
  let moreFromRanch: Awaited<ReturnType<typeof loadProductsForRancher>> = [];
  if (p.rancherId) {
    try {
      moreFromRanch = (await loadProductsForRancher(p.rancherId))
        .filter((x) => x.id !== p.id)
        .slice(0, 3);
    } catch { /* section just doesn't render */ }
  }

  // Product JSON-LD — only when an image + price exist (Google requires image).
  // shippingDetails declares FREE US shipping (price is genuinely all-in).
  // Deposit-style (price-range) products emit an honest AggregateOffer with
  // low/high parsed from the Price Range — never a flat price that undersells
  // what the buyer ultimately pays.
  const rangeMatch = p.depositStyle
    ? p.priceRange.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/)
    : null;
  // Audit fix (D-3/C-1.2): a deposit-style product with a missing/unparseable
  // Price Range must NEVER fall back to a flat Offer at the deposit price —
  // that would tell Google a $95-355 product costs $95. Omit offers entirely
  // instead (Product markup without offers is valid; a lie is not).
  const offers = p.depositStyle
    ? rangeMatch
      ? {
          '@type': 'AggregateOffer',
          lowPrice: Number(rangeMatch[1]).toFixed(2),
          highPrice: Number(rangeMatch[2]).toFixed(2),
          priceCurrency: 'USD',
          availability: p.soldOut ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
          url: `${SITE_URL}/shop/${p.id}`,
        }
      : null
    : {
        '@type': 'Offer',
        price: p.price.toFixed(2),
        priceCurrency: 'USD',
        availability: p.soldOut ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
        url: `${SITE_URL}/shop/${p.id}`,
        // LOCAL PICKUP products assert NO shipping details — telling Google a
        // pickup product ships would be exactly the mismatch we're killing.
        ...(p.localOnly
          ? {}
          : {
        shippingDetails: {
          '@type': 'OfferShippingDetails',
          // Real rate: 0 = shipping included; a priced-shipping product must
          // never assert free shipping to Google.
          shippingRate: { '@type': 'MonetaryAmount', value: p.shippingCost.toFixed(2), currency: 'USD' },
          shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US' },
        },
            }),
      };
  const jsonLd =
    p.image && p.price > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'Product',
          name: p.name,
          image: [p.image],
          ...(p.description ? { description: p.description } : {}),
          ...(p.category ? { category: p.category } : {}),
          brand: { '@type': 'Brand', name: p.rancher },
          ...(offers ? { offers } : {}),
          // REAL ratings only — from verified-purchase reviews on this exact
          // product. Never fabricated (brand rule + FTC Fake Reviews Rule).
          ...(reviews.length > 0
            ? {
                aggregateRating: {
                  '@type': 'AggregateRating',
                  ratingValue: avgRating.toFixed(1),
                  reviewCount: reviews.length,
                },
              }
            : {}),
        }
      : null;

  return (
    <main className="min-h-screen bg-bone text-charcoal pt-8 pb-14">
      {jsonLd ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdSafe(jsonLd) }} />
      ) : null}
      <ProductViewTracker productId={p.id} name={p.name} price={p.price} />

      <Container>
        <div className="max-w-[860px] mx-auto">
          <Link href="/shop" className="text-[13.5px] text-saddle hover:text-charcoal transition-colors">
            &larr; all products
          </Link>

          <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-7 mt-4 items-start">
            {/* Photo — locked to a square frame on a bone-deep placeholder so
                uneven rancher uploads still present cleanly. */}
            <div className="bg-bone-deep border border-dust aspect-square overflow-hidden">
              <ProductImage src={p.image} alt={p.name} className="w-full h-full object-cover block" />
            </div>

            {/* Story + Buy */}
            <div className="flex flex-col gap-3.5">
              <div>
                <h1 className="font-serif text-[clamp(26px,5vw,34px)] leading-tight mb-1">{p.name}</h1>
                <div className="text-sm text-saddle">
                  {p.rancherSlug ? (
                    <Link href={`/ranchers/${p.rancherSlug}`} className="underline hover:text-charcoal transition-colors">
                      {p.rancher}
                    </Link>
                  ) : (
                    p.rancher
                  )}
                  <span className="text-sage"> · verified ranch{p.rancherState ? ` · ${p.rancherState}` : ''}</span>
                  {p.weight ? ` · ${p.weight}` : ''}
                </div>
              </div>

              {p.depositStyle ? (
                <div>
                  <div className="font-serif text-3xl text-charcoal">
                    from {p.priceRange || `$${p.price.toFixed(0)}`}
                  </div>
                  <p className="text-[13px] text-saddle mt-1.5 leading-relaxed">
                    sizes vary, so this one works like a share: put down a{' '}
                    <strong>${p.price.toFixed(0)} deposit</strong> today, and{' '}
                    {p.rancher || 'your rancher'} reaches out to confirm the size you want + the
                    balance before anything ships.
                  </p>
                </div>
              ) : (
                <PriceTag amount={p.price} size="lg" />
              )}

              {p.description ? (
                <p className="text-[15.5px] text-charcoal/85 leading-relaxed m-0">{p.description}</p>
              ) : null}

              {/* WHAT YOU GET (Phase 12) — the information gap killer. A buyer
                  must be able to answer "what exactly shows up at my door"
                  without leaving this screen. */}
              {p.whatsIncluded ? (
                <div className="border border-dust bg-bone-warm p-4">
                  <p className="text-xs uppercase tracking-widest text-saddle mb-2">what you get</p>
                  <ul className="m-0 pl-4 space-y-1">
                    {p.whatsIncluded.split('\n').filter(Boolean).map((line, i) => (
                      <li key={i} className="text-[14px] text-charcoal leading-snug">{line}</li>
                    ))}
                  </ul>
                  {p.feeds ? (
                    <p className="text-[12.5px] text-saddle mt-2.5 mb-0">{p.feeds}</p>
                  ) : null}
                </div>
              ) : p.feeds ? (
                <p className="text-[13px] text-saddle m-0">{p.feeds}</p>
              ) : null}

              {/* HOW IT WORKS — the process, in order, no mystery. Deposit-style
                  gets the 4-step confirm-first version; fixed-price the 3-step.
                  Honest fallbacks when a field is blank. */}
              <div className="border-t border-dust pt-3">
                <p className="text-xs uppercase tracking-widest text-saddle mb-2">how it works</p>
                <ol className="m-0 pl-4 space-y-1.5">
                  {p.depositStyle ? (
                    <>
                      <li className="text-[13.5px] text-charcoal/85 leading-snug">
                        reserve with a ${p.price.toFixed(0)} deposit — it counts toward your total
                      </li>
                      <li className="text-[13.5px] text-charcoal/85 leading-snug">
                        {p.rancher || 'your rancher'} reaches out to confirm the size you want + the balance
                      </li>
                      <li className="text-[13.5px] text-charcoal/85 leading-snug">
                        {p.packaging || 'packed and shipped frozen, direct from the ranch'}
                        {p.shipsInDays ? ` — ships within ~${p.shipsInDays} days of confirming` : ' once you’ve confirmed'}
                      </li>
                      <li className="text-[13.5px] text-charcoal/85 leading-snug">
                        tracking lands in your inbox the moment it ships
                      </li>
                    </>
                  ) : (
                    <>
                      <li className="text-[13.5px] text-charcoal/85 leading-snug">
                        order now — {p.rancher || 'the ranch'} gets it immediately
                      </li>
                      <li className="text-[13.5px] text-charcoal/85 leading-snug">
                        {p.packaging || 'packed and shipped direct from the ranch'}
                        {p.shipsInDays ? ` — ships within ~${p.shipsInDays} days` : ''}
                      </li>
                      <li className="text-[13.5px] text-charcoal/85 leading-snug">
                        tracking lands in your inbox the moment it ships
                      </li>
                    </>
                  )}
                </ol>
              </div>

              <div className={`text-[13px] ${p.localOnly ? 'text-saddle font-medium' : 'text-sage'}`}>
                {p.localOnly
                  ? `local pickup only — at the ranch${p.rancherState ? ` in ${p.rancherState}` : ''} · no shipping`
                  : p.category === 'Merch'
                    ? `printed to order · ships to your door${p.shippingCost > 0 ? ` · + $${p.shippingCost.toFixed(2)} shipping` : ' · shipping included'}, nationwide`
                    : p.depositStyle
                      ? 'deposit today · rancher confirms size + balance · ships frozen, nationwide'
                      : p.shippingCost > 0
                        ? `${p.shelfStable ? 'shelf-stable' : 'ships frozen, direct from the ranch'} · + $${p.shippingCost.toFixed(2)} shipping, nationwide`
                        : p.shelfStable
                          ? 'shelf-stable · ships free, no freezer needed'
                          : 'ships frozen, direct from the ranch · shipping included, nationwide'}
              </div>

              {/* Real scarcity only — shown because it's literally true. */}
              {!p.soldOut && p.ordersLeft !== null && p.ordersLeft <= 10 && (
                <div className="text-[12px] text-saddle">
                  {p.ordersLeft} {p.ordersLeft === 1 ? 'order' : 'orders'} left from this batch
                </div>
              )}

              <div className="mt-1">
                {p.soldOut ? (
                  <div className="border border-dust bg-bone-warm p-4 text-center">
                    <div className="font-serif text-lg mb-1">sold out</div>
                    <p className="text-[13px] text-saddle mb-3">
                      this batch is spoken for — the ranch restocks as the next animals come through.
                    </p>
                    <Button href="/shop" variant="secondary" size="sm">
                      see what&rsquo;s available now &rarr;
                    </Button>
                  </div>
                ) : p.depositStyle ? (
                  <BuyButton
                    productId={p.id}
                    price={p.price}
                    label={`reserve — $${p.price.toFixed(0)} deposit`}
                  />
                ) : (
                  // Qty picker (audit fix: buyers couldn't buy 2 of anything).
                  // Cap at real stock; unlimited-stock rows cap at 5.
                  <QtyBuy
                    productId={p.id}
                    price={p.price}
                    maxQty={p.ordersLeft == null ? 5 : p.ordersLeft}
                  />
                )}
              </div>

              {/* Risk-reversal above the fold, right at the buy decision —
                  operational certainty, not "contact support" (Phase 4). */}
              <p className="text-[12.5px] text-saddle leading-relaxed mt-0.5">
                {p.localOnly
                  ? 'local pickup — you pay online and the ranch confirms your pickup time; no shipping is ever charged. '
                  : p.depositStyle
                    ? 'your deposit counts toward the total — the balance is only settled after you and the rancher confirm the details. '
                    : p.shippingCost > 0
                      ? `$${p.price.toFixed(2)} + $${p.shippingCost.toFixed(2)} shipping — that's the whole total, no surprises at checkout. `
                      : 'the price you see is the price you pay — shipping included. '}
                if {p.category === 'Merch' ? 'anything shows up wrong or damaged' : 'a cut ever shows up wrong or freezer-burned'}, we make it right — no forms, no
                runaround. checkout secured by Stripe. questions? reply to your receipt — a real
                person answers. &mdash; Ben
              </p>

              {/* WHAT BUYERS SAY — verified-purchase reviews only (the ask
                  cron + tokened submit fill these; first names only). Renders
                  nothing until real reviews exist — never fabricated. */}
              {reviews.length > 0 && (
                <div className="border-t border-dust pt-3">
                  <p className="text-xs uppercase tracking-widest text-saddle mb-2">
                    what buyers say · {avgRating.toFixed(1)}★ ({reviews.length})
                  </p>
                  <div className="space-y-2.5">
                    {reviews.slice(0, 3).map((r, i) => (
                      <blockquote key={i} className="m-0 border-l-2 border-sage pl-3">
                        <span className="text-[13px] text-sage" aria-label={`${r.rating} out of 5 stars`}>
                          {'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}
                        </span>
                        {r.text && (
                          <p className="text-[13.5px] text-charcoal/85 leading-snug mt-0.5 mb-0.5">
                            &ldquo;{r.text}&rdquo;
                          </p>
                        )}
                        <footer className="text-[11.5px] text-saddle not-italic">
                          — {r.who}, verified buyer
                        </footer>
                      </blockquote>
                    ))}
                  </div>
                </div>
              )}

              {/* Capture-leak patch: the PDP bouncer leaves with nothing —
                  offer the guide as the zero-risk exit ramp. */}
              <p className="text-[12px] text-saddle">
                not today?{' '}
                <a href="/guide" className="underline hover:text-charcoal transition-colors">
                  grab the free half-cow cost guide instead &rarr;
                </a>
              </p>
            </div>
          </div>

          {/* Anchor on the share — below the fold, a rung UP, de-emphasized CTA. */}
          <Card
            variant="warm"
            padding="sm"
            className="border-l-2 border-l-sage mt-9 flex items-center gap-4 flex-wrap"
          >
            <div className="flex-1 min-w-[220px]">
              <div className="font-serif text-[17px]">ready for a freezer-fill?</div>
              <div className="text-[13px] text-charcoal/80">
                a half or whole share is the best price per pound — one animal, one ranch, all year.
              </div>
            </div>
            <Button href="/map" variant="secondary" size="sm">
              find a ranch &rarr;
            </Button>
          </Card>

          {/* MORE FROM THIS RANCH — cross-sell (audit fix). Renders on the
              sold-out state too, exactly where a dead ad click needs somewhere
              buyable to go. */}
          {moreFromRanch.length > 0 && (
            <div className="mt-10">
              <h2 className="font-serif text-2xl mb-4">more from {p.rancher || 'this ranch'}</h2>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {moreFromRanch.map((mp) => (
                  <ProductCard key={mp.id} p={mp} />
                ))}
              </div>
            </div>
          )}
        </div>
      </Container>
    </main>
  );
}
