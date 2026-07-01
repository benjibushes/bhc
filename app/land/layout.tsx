import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Land deals — BuyHalfCow',
  description: 'Verified ranch land deals — connect with sellers + buyers across the U.S.',
  openGraph: {
    title: 'Land deals — BuyHalfCow',
    description: 'Verified ranch land deals — connect with sellers + buyers across the U.S.',
    url: 'https://www.buyhalfcow.com/land',
    images: ['/og-image.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Land deals — BuyHalfCow',
    description: 'Verified ranch land deals — connect with sellers + buyers across the U.S.',
    images: ['/og-image.png'],
  },
};

export default function LandLayout({ children }: { children: React.ReactNode }) {
  return children;
}
