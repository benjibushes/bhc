import type { MetadataRoute } from 'next';
import { getActiveRancherPages, getAllRecords, TABLES } from '@/lib/airtable';
import { loadMarketplaceProducts } from '@/lib/marketplaceProducts';
import { US_STATES } from '@/lib/states';
import { SEO_STATES } from '@/lib/stateSeo';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Canonical = www. (non-www 307s to www). Sitemap must use canonical
  // host so search engines + AI bots index the same URLs that show in
  // address bars + share links.
  const baseUrl = 'https://www.buyhalfcow.com';

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: baseUrl, lastModified: new Date(), changeFrequency: 'weekly', priority: 1 },
    // High-priority revenue + traffic routes (paid ad landings, audience grid, case studies)
    { url: `${baseUrl}/start`, lastModified: new Date(), changeFrequency: 'daily', priority: 1 },
    { url: `${baseUrl}/access`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.9 },
    { url: `${baseUrl}/sell`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.9 },
    { url: `${baseUrl}/apply`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.9 },
    { url: `${baseUrl}/founders`, lastModified: new Date(), changeFrequency: 'daily', priority: 0.9 },
    { url: `${baseUrl}/brand-partners`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.9 },
    { url: `${baseUrl}/wins`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.85 },
    { url: `${baseUrl}/wholesale`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.85 },
    // Supporting / secondary
    { url: `${baseUrl}/partner`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.8 },
    { url: `${baseUrl}/about`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${baseUrl}/faq`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${baseUrl}/ranchers`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.8 },
    { url: `${baseUrl}/shop`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.9 },
    { url: `${baseUrl}/map`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.8 },
    { url: `${baseUrl}/map/add-a-rancher`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${baseUrl}/land`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.7 },
    { url: `${baseUrl}/news`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.6 },
    { url: `${baseUrl}/privacy`, lastModified: new Date(), changeFrequency: 'yearly', priority: 0.3 },
    { url: `${baseUrl}/terms`, lastModified: new Date(), changeFrequency: 'yearly', priority: 0.3 },
  ];

  let rancherRoutes: MetadataRoute.Sitemap = [];
  try {
    const ranchers = await getActiveRancherPages();
    rancherRoutes = ranchers
      .filter((r: any) => r['Slug'])
      .filter((r: any) => !r['Public Map Hidden']) // honor opt-out
      .map((r: any) => ({
        url: `${baseUrl}/ranchers/${r['Slug']}`,
        lastModified: new Date(),
        changeFrequency: 'weekly' as const,
        priority: 0.7,
      }));
  } catch {
    // Don't fail the entire sitemap if Airtable is unavailable
  }

  let newsRoutes: MetadataRoute.Sitemap = [];
  try {
    const posts = await getAllRecords(TABLES.NEWS_POSTS, `{Status} = "published"`) as any[];
    newsRoutes = posts
      .filter((p: any) => p['Slug'])
      .map((p: any) => ({
        url: `${baseUrl}/news/${p['Slug']}`,
        lastModified: p['Published Date'] ? new Date(p['Published Date']) : new Date(),
        changeFrequency: 'monthly' as const,
        priority: 0.5,
      }));
  } catch {
    // Don't fail if news fetch fails
  }

  // Nationwide-shippable products — one /shop/{id} per sellable product.
  let productRoutes: MetadataRoute.Sitemap = [];
  try {
    const products = await loadMarketplaceProducts(); // already filters to sellable + catches errors
    productRoutes = products.map((p) => ({
      url: `${baseUrl}/shop/${p.id}`,
      lastModified: new Date(),
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    }));
  } catch {
    // Don't fail the sitemap if products can't load
  }

  // Programmatic state landing pages — one /access/{state} per US state + DC.
  // SSG'd by `app/access/[state]/page.tsx` and serves state-localized organic
  // SEO traffic ("buy half cow texas", "grass-fed beef montana", etc).
  const stateRoutes: MetadataRoute.Sitemap = US_STATES.map((s) => ({
    url: `${baseUrl}/access/${s.code.toLowerCase()}`,
    lastModified: new Date(),
    changeFrequency: 'weekly' as const,
    priority: 0.7,
  }));

  // "half a cow [state]" keyword pages — /half-a-cow hub + one full-name-slug
  // page per state (competitive-report gap #1). Static list, no fetch.
  const halfACowRoutes: MetadataRoute.Sitemap = [
    {
      url: `${baseUrl}/half-a-cow`,
      lastModified: new Date(),
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    },
    ...SEO_STATES.map((s) => ({
      url: `${baseUrl}/half-a-cow/${s.slug}`,
      lastModified: new Date(),
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
  ];

  return [...staticRoutes, ...stateRoutes, ...halfACowRoutes, ...rancherRoutes, ...newsRoutes, ...productRoutes];
}
