import type { Metadata, Viewport } from 'next';

// PWA (2026-07-08): the manifest makes /rancher installable ("Add to Home
// Screen") — scoped HERE, not the root layout, so buyers never get install
// prompts. The service worker + push registration live in PushSetupCard.
export const viewport: Viewport = {
  themeColor: '#0E0E0E',
};

export const metadata: Metadata = {
  title: 'Rancher dashboard — BuyHalfCow',
  description: 'Rancher dashboard — manage your listing, capacity, leads, and payouts.',
  manifest: '/rancher.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'BHC Ranch',
  },
  openGraph: {
    title: 'Rancher dashboard — BuyHalfCow',
    description: 'Rancher dashboard — manage your listing, capacity, leads, and payouts.',
    url: 'https://www.buyhalfcow.com/rancher',
    images: ['/og-image.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Rancher dashboard — BuyHalfCow',
    description: 'Rancher dashboard — manage your listing, capacity, leads, and payouts.',
    images: ['/og-image.png'],
  },
};

export default function RancherLayout({ children }: { children: React.ReactNode }) {
  return children;
}
