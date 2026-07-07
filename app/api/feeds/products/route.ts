// GET /api/feeds/products — THE beef product feed (omnichannel unlock).
//
// One endpoint, four channels: Google Merchant Center and Meta Commerce
// Manager both ingest Google-format TSV on a scheduled fetch; YouTube
// Shopping and Pinterest reuse the same GMC feed later. Every tag/click
// lands on OUR PDP → OUR checkout (post-2025 link-out commerce), so the
// Stripe Connect rail underneath is invisible to the channel.
//
// Catalog rules (omnichannel research 2026-07-06):
// - Sellable products only (isSellableRow — active, shippable, in stock).
// - DEPOSIT-STYLE rows EXCLUDED: the charged price ($95) ≠ the total
//   ($95–355); feeds require the literal transaction price and a mismatch
//   risks account health. Range products stay on-domain surfaces.
// - Shares/deposits NEVER appear in any shopping catalog (intangible SKU
//   risks whole-shop rejection) — this feed only reads the product rail,
//   which can't contain them.
// - availability flows from live stock; the feed re-fetches hourly
//   (s-maxage) so a sellout drops from channels on the next crawl.
//
// TSV over XML: simplest format both ingesters accept; fields sanitized
// (tabs/newlines stripped) so a description can never break a row.

import { loadMarketplaceProducts } from '@/lib/marketplaceProducts';

export const runtime = 'nodejs';
// Revalidated hourly via Cache-Control; route itself computes fresh on miss.
export const dynamic = 'force-dynamic';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com';

const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ').trim();

export async function GET() {
  const products = await loadMarketplaceProducts();

  const header = [
    'id',
    'title',
    'description',
    'link',
    'image_link',
    'availability',
    'price',
    'brand',
    'condition',
    'identifier_exists',
  ].join('\t');

  const rows = products
    // Deposit-style excluded — charged price ≠ total price (see header note).
    .filter((p) => !p.depositStyle)
    // Google requires an image; photo-less rows wait until one lands.
    .filter((p) => p.image)
    .map((p) => {
      const title = clean(`${p.name} — ${p.rancher}`).slice(0, 150);
      const desc = clean(
        [
          p.description,
          p.whatsIncluded ? `What you get: ${p.whatsIncluded}` : '',
          p.shelfStable
            ? 'Shelf-stable, ships free nationwide.'
            : 'Ships frozen, direct from the ranch — shipping included.',
        ]
          .filter(Boolean)
          .join(' '),
      ).slice(0, 4900);
      return [
        p.id,
        title,
        desc,
        `${SITE_URL}/shop/${p.id}?utm_source=feed&utm_medium=shopping&utm_campaign=product-feed`,
        p.image,
        'in_stock', // isSellableRow already excluded sold-out rows
        `${p.price.toFixed(2)} USD`,
        clean(p.rancher || 'BuyHalfCow'),
        'new',
        'false', // ranch goods have no GTIN/MPN
      ].join('\t');
    });

  return new Response([header, ...rows].join('\n'), {
    headers: {
      'Content-Type': 'text/tab-separated-values; charset=utf-8',
      // Channels crawl on schedules; an hour of edge cache keeps Airtable
      // reads negligible while sellouts still drop within the hour.
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
    },
  });
}
