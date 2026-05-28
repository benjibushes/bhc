import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      // Airtable CDN (where user-uploaded images are stored)
      { protocol: 'https', hostname: 'dl.airtable.com' },
      { protocol: 'https', hostname: 'v5.airtableusercontent.com' },
      // Normalized user upload sources (Dropbox, Google Drive)
      { protocol: 'https', hostname: 'drive.google.com' },
      { protocol: 'https', hostname: 'www.dropbox.com' },
    ],
  },
  // Externalize the jsdom / isomorphic-dompurify chain so Turbopack doesn't
  // bundle it into the serverless function. Fixes runtime ERR_REQUIRE_ESM
  // from `html-encoding-sniffer` → `@exodus/bytes` (upstream published an
  // ESM-only version that broke jsdom's require chain). Without this, every
  // API route that transitively imports lib/email.ts (which imports
  // isomorphic-dompurify at module top) 500s on first request post-deploy.
  // Resolved at runtime via Vercel's lambda node_modules.
  serverExternalPackages: ['isomorphic-dompurify', 'jsdom'],
};

export default nextConfig;
