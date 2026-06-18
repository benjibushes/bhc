import type { MetadataRoute } from 'next';
import { getActiveRancherPages, getAllRecords, TABLES } from '@/lib/airtable';
import { US_STATES } from '@/lib/states';

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

  // Programmatic state landing pages — one /access/{state} per US state + DC.
  // SSG'd by `app/access/[state]/page.tsx` and serves state-localized organic
  // SEO traffic ("buy half cow texas", "grass-fed beef montana", etc).
  const stateRoutes: MetadataRoute.Sitemap = US_STATES.map((s) => ({
    url: `${baseUrl}/access/${s.code.toLowerCase()}`,
    lastModified: new Date(),
    changeFrequency: 'weekly' as const,
    priority: 0.7,
  }));

  return [...staticRoutes, ...stateRoutes, ...rancherRoutes, ...newsRoutes];
}
