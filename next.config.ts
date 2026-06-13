import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Rancher logos + gallery photos are pasted from wherever the ranch
    // already hosts them (Squarespace, Wix, Shopify, their own domain...).
    // A hostname outside this list crashes the whole page for buyers, so
    // allow any https host rather than maintain a forever-growing whitelist.
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
};

export default nextConfig;
