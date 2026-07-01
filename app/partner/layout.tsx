import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Partner with BuyHalfCow',
  description: 'Partner with BuyHalfCow as a brand or affiliate. Direct ranch beef network - verified ranchers, real buying families.',
  openGraph: {
    title: 'Partner with BuyHalfCow',
    description: 'Partner with BuyHalfCow as a brand or affiliate. Direct ranch beef network - verified ranchers, real buying families.',
    url: 'https://www.buyhalfcow.com/partner',
    images: ['/og-image.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Partner with BuyHalfCow',
    description: 'Partner with BuyHalfCow as a brand or affiliate. Direct ranch beef network - verified ranchers, real buying families.',
    images: ['/og-image.png'],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
