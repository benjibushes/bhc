import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
