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
};

export default nextConfig;
