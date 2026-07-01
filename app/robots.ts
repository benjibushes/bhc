import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin', '/api/', '/checkout/', '/member/', '/rancher/', '/_next/'],
      },
    ],
    sitemap: 'https://www.buyhalfcow.com/sitemap.xml',
    host: 'https://www.buyhalfcow.com',
  };
}
