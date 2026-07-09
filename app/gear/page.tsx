// app/gear/page.tsx
//
// "Gear we trust" — the standalone, public, SEO-friendly catalog page for the
// AFFILIATE-PRODUCTS LAYER (Move 1). Renders every Active product grouped by
// category, each linking through /go/product/<id>?surface=gear (click-logged +
// attributed), with the FTC disclosure. Server component so it's crawlable.
//
// Empty catalog (today's reality — Ben adds products later) → an honest, clean
// "curating our list" state, never a dead grid.

import Container from '../components/Container';
import Divider from '../components/Divider';
import AffiliateDisclosure from '../components/AffiliateDisclosure';
import ProductImage from '../shop/ProductImage';
import { getGearCatalog, type GearProduct } from '@/lib/gear';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: "Ben's Gear",
  description:
    'The freezers, grills, cast iron, knives and coolers Ben actually uses to store, cut, and cook a half a cow. Curated by BuyHalfCow.',
  openGraph: {
    title: "Ben's Gear",
    description:
      'The freezers, grills, cast iron, knives and coolers Ben actually uses to store, cut, and cook a half a cow.',
    url: 'https://www.buyhalfcow.com/gear',
    images: ['/og-image.png'],
  },
  twitter: {
    card: 'summary_large_image' as const,
    title: "Ben's Gear",
    description: 'The gear Ben actually uses to store, cut, and cook real beef.',
    images: ['/og-image.png'],
  },
};

// Human labels + display order for the category buckets (Ben's taxonomy).
const CATEGORY_LABELS: Record<string, string> = {
  freezer: '❄️ freezers',
  grills: '🔥 grills & outdoor cooking',
  cooking: '🍳 cooking essentials',
  'kitchen-prep': '🔪 kitchen prep',
  seasonings: '🌶️ seasonings',
  'grill-accessories': '🧰 grilling accessories',
  coolers: '🧊 coolers & adventure',
  other: 'more gear',
};
const CATEGORY_ORDER: string[] = [
  'freezer',
  'grills',
  'cooking',
  'kitchen-prep',
  'seasonings',
  'grill-accessories',
  'coolers',
  'other',
];

function groupByCategory(products: GearProduct[]): Array<[string, GearProduct[]]> {
  const buckets = new Map<string, GearProduct[]>();
  for (const p of products) {
    const cat = String(p.Category || 'other');
    if (!buckets.has(cat)) buckets.set(cat, []);
    buckets.get(cat)!.push(p);
  }
  // Sort within a bucket by Sort Order (curator's hand-order), then Name.
  for (const list of buckets.values()) {
    list.sort((a, b) => {
      const ao = Number.isFinite(Number(a['Sort Order'])) ? Number(a['Sort Order']) : Number.POSITIVE_INFINITY;
      const bo = Number.isFinite(Number(b['Sort Order'])) ? Number(b['Sort Order']) : Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      return String(a.Name || '').localeCompare(String(b.Name || ''));
    });
  }
  // Known categories first (in CATEGORY_ORDER), then any unknown ones.
  const ordered: Array<[string, GearProduct[]]> = [];
  for (const cat of CATEGORY_ORDER) {
    if (buckets.has(cat)) {
      ordered.push([cat, buckets.get(cat)!]);
      buckets.delete(cat);
    }
  }
  for (const [cat, list] of buckets) ordered.push([cat, list]);
  return ordered;
}

export default async function GearPage() {
  const catalog = await getGearCatalog();
  const groups = groupByCategory(catalog);

  return (
    <main className="min-h-screen pt-8 pb-16 md:py-24 bg-bone text-charcoal">
      <Container>
        <div className="max-w-3xl mx-auto text-center space-y-5 mb-12">
          <h1 className="font-serif text-4xl md:text-5xl">ben&rsquo;s gear</h1>
          <Divider />
          <p className="text-lg leading-relaxed text-saddle">
            the stuff i actually use to store, cut, and cook a half a cow
            &mdash; freezers, grills, cast iron, knives, coolers. no fluff,
            just what earns a spot in my kitchen. &mdash; Ben
          </p>
          <AffiliateDisclosure className="max-w-xl mx-auto" />
        </div>

        {groups.length === 0 ? (
          <div className="p-8 border border-dust text-center bg-bone-warm max-w-3xl mx-auto">
            <p className="text-saddle">
              we&rsquo;re still curating our list &mdash; check back soon.
            </p>
          </div>
        ) : (
          <>
            {/* Category quick-nav — same structural spine as /shop, so the two
                browse surfaces read as siblings. Anchors, no JS. */}
            {groups.length > 1 && (
              <nav aria-label="gear sections" className="flex flex-wrap gap-2 mb-10 justify-center">
                {groups.map(([cat, list]) => (
                  <a
                    key={cat}
                    href={`#gear-${cat}`}
                    className="px-3.5 py-2 border border-dust text-[13px] text-charcoal hover:bg-charcoal hover:text-bone transition-base"
                  >
                    {CATEGORY_LABELS[cat] || cat} <span className="text-dust">·</span>{' '}
                    <span className="tabular-nums">{list.length}</span>
                  </a>
                ))}
              </nav>
            )}

            <div className="space-y-14">
              {groups.map(([cat, list]) => (
                <section key={cat} id={`gear-${cat}`} className="scroll-mt-24">
                  <div className="flex items-baseline justify-between gap-3 border-b border-dust pb-2 mb-5">
                    <h2 className="font-serif text-2xl">{CATEGORY_LABELS[cat] || cat}</h2>
                    <span className="text-xs text-dust tabular-nums shrink-0">
                      {list.length} {list.length === 1 ? 'pick' : 'picks'}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {list.map((p) => (
                      <div
                        key={p.id}
                        className="bg-bone border border-dust flex flex-col transition-base hover:border-charcoal"
                      >
                        {/* Image-forward card — the photo slot renders the
                            branded placeholder until Ben adds an Image URL, so
                            the grid never looks broken while photos land. */}
                        <a
                          href={`/go/product/${p.id}?surface=gear`}
                          target="_blank"
                          rel="nofollow sponsored noopener noreferrer"
                          className="block aspect-[4/3] overflow-hidden bg-bone-deep"
                        >
                          <ProductImage
                            src={String(p['Image URL'] || '')}
                            alt={p.Name}
                            className="w-full h-full object-cover block"
                          />
                        </a>
                        <div className="p-4 flex flex-col gap-2 flex-1">
                          <p className="font-serif text-lg leading-tight text-charcoal line-clamp-2">
                            {p.Name}
                          </p>
                          {p.Blurb ? (
                            <p className="text-[13px] text-saddle leading-snug line-clamp-2">{p.Blurb}</p>
                          ) : null}
                          <div className="mt-auto pt-2">
                            <a
                              href={`/go/product/${p.id}?surface=gear`}
                              target="_blank"
                              rel="nofollow sponsored noopener noreferrer"
                              className="inline-flex w-full items-center justify-center px-4 py-2.5 border border-charcoal text-xs font-medium uppercase tracking-wide text-charcoal hover:bg-charcoal hover:text-bone transition-base"
                            >
                              see it on amazon &rarr;
                            </a>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>

            {/* Cross-link back to the beef — gear is the sidecar, never the
                destination. */}
            <p className="text-[13.5px] text-saddle mt-12 text-center">
              here for the beef?{' '}
              <a href="/shop" className="underline hover:text-charcoal transition-colors">
                jerky &amp; boxes, shipped &rarr;
              </a>{' '}
              · or{' '}
              <a href="/access" className="underline hover:text-charcoal transition-colors">
                reserve your share — deposit refundable &rarr;
              </a>
            </p>
          </>
        )}
      </Container>
    </main>
  );
}
