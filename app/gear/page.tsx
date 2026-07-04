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
import { getGearCatalog, type GearProduct, type GearCategory } from '@/lib/gear';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Gear We Trust',
  description:
    'The freezers, vacuum sealers, cast iron, knives and rubs we’d put in our own kitchen. Curated by BuyHalfCow.',
  openGraph: {
    title: 'Gear We Trust',
    description:
      'The freezers, vacuum sealers, cast iron, knives and rubs we’d put in our own kitchen. Curated by BuyHalfCow.',
    url: 'https://www.buyhalfcow.com/gear',
    images: ['/og-image.png'],
  },
  twitter: {
    card: 'summary_large_image' as const,
    title: 'Gear We Trust',
    description: 'The gear we’d put in our own freezer. Curated by BuyHalfCow.',
    images: ['/og-image.png'],
  },
};

// Human labels + display order for the category buckets.
const CATEGORY_LABELS: Record<string, string> = {
  freezer: 'freezers',
  'vacuum-sealer': 'vacuum sealers',
  'cast-iron': 'cast iron',
  'rub-salt': 'rubs & salt',
  knives: 'knives',
  supplements: 'supplements',
  cooler: 'coolers',
  other: 'more gear',
};
const CATEGORY_ORDER: GearCategory[] = [
  'freezer',
  'vacuum-sealer',
  'cast-iron',
  'knives',
  'rub-salt',
  'supplements',
  'cooler',
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
    <main className="min-h-screen py-16 md:py-24 bg-bone text-charcoal">
      <Container>
        <div className="max-w-3xl mx-auto space-y-10">
          <div className="text-center space-y-5">
            <h1 className="font-serif text-4xl md:text-5xl">gear we trust</h1>
            <Divider />
            <p className="text-lg leading-relaxed text-saddle">
              the freezers, sealers, cast iron and knives we&rsquo;d put in our
              own kitchen. no fluff &mdash; just what makes a half a cow easier
              to store, cut, and cook.
            </p>
            <AffiliateDisclosure className="max-w-xl mx-auto" />
          </div>

          {groups.length === 0 ? (
            <div className="p-8 border border-dust text-center bg-white">
              <p className="text-saddle">
                we&rsquo;re still curating our list &mdash; check back soon.
              </p>
            </div>
          ) : (
            <div className="space-y-12">
              {groups.map(([cat, list]) => (
                <section key={cat} className="space-y-4">
                  <h2 className="font-serif text-2xl">
                    {CATEGORY_LABELS[cat] || cat}
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {list.map((p) => (
                      <div key={p.id} className="flex gap-4 border border-dust bg-white p-4">
                        {p['Image URL'] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={p['Image URL']}
                            alt={p.Name}
                            loading="lazy"
                            className="w-20 h-20 object-cover border border-dust flex-shrink-0 bg-bone"
                          />
                        ) : null}
                        <div className="min-w-0 flex flex-col">
                          <p className="font-medium text-charcoal">{p.Name}</p>
                          {p.Blurb ? (
                            <p className="text-sm text-saddle mt-1">{p.Blurb}</p>
                          ) : null}
                          <a
                            href={`/go/product/${p.id}?surface=gear`}
                            target="_blank"
                            rel="nofollow sponsored noopener noreferrer"
                            className="mt-auto pt-2 text-xs uppercase tracking-wider text-charcoal hover:text-saddle font-medium"
                          >
                            shop &rarr;
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </Container>
    </main>
  );
}
