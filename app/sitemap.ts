import type { MetadataRoute } from 'next';
import { getActiveRancherPages } from '@/lib/airtable';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = 'https://buyhalfcow.com';

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: baseUrl, lastModified: new Date(), changeFrequency: 'weekly', priority: 1 },
    { url: `${baseUrl}/access`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.9 },
    { url: `${baseUrl}/partner`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.8 },
    { url: `${baseUrl}/about`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${baseUrl}/faq`, lastModified: new Date(), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${baseUrl}/ranchers`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.8 },
    { url: `${baseUrl}/news`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.6 },
    { url: `${baseUrl}/privacy`, lastModified: new Date(), changeFrequency: 'yearly', priority: 0.3 },
    { url: `${baseUrl}/terms`, lastModified: new Date(), changeFrequency: 'yearly', priority: 0.3 },
  ];

  let rancherRoutes: MetadataRoute.Sitemap = [];
  try {
    const ranchers = await getActiveRancherPages();
    rancherRoutes = ranchers
      .filter((r: any) => r['Slug'])
      .map((r: any) => ({
        url: `${baseUrl}/ranchers/${r['Slug']}`,
        lastModified: new Date(),
        changeFrequency: 'weekly' as const,
        priority: 0.7,
      }));
  } catch {
    // Don't fail the entire sitemap if Airtable is unavailable
  }

  return [...staticRoutes, ...rancherRoutes];
}
