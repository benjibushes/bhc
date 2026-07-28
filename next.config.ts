import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build tourniquet (runtime audit 2026-07-28). /ranchers/[slug] prerenders
  // hit Airtable during `next build`; parallel export workers stacked on the
  // base's 5 req/s ceiling made ~1-in-3 builds die on a transient prerender
  // timeout. Serialize static generation, triple each page's budget, and
  // retry a failed page before failing the whole build.
  // Option names verified against the installed Next 16.1.4 types
  // (node_modules/next/dist/server/config-shared.d.ts):
  //   staticPageGenerationTimeout — top-level, seconds (default 60).
  //   staticGenerationRetryCount / staticGenerationMaxConcurrency — these two
  //   live under `experimental` in Next 16 (there are no top-level variants).
  staticPageGenerationTimeout: 180,
  experimental: {
    staticGenerationRetryCount: 3,
    staticGenerationMaxConcurrency: 1,
  },
  images: {
    // Rancher logos + gallery photos are pasted from wherever the ranch
    // already hosts them (Squarespace, Wix, Shopify, their own domain...).
    // A hostname outside this list crashes the whole page for buyers, so
    // allow any https host rather than maintain a forever-growing whitelist.
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
    // D2 — mobile ad traffic was downloading desktop-size ranch photos as
    // PNG/JPG. Serve modern formats + cache optimized variants longer so a
    // cold /ranchers/[slug] hero isn't a multi-hundred-KB LCP on a phone.
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 86400,
  },
};

export default nextConfig;
