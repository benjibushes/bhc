import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Partner with BuyHalfCow',
  description: 'Partner with BuyHalfCow as a brand or affiliate. Direct ranch beef network, premium audience.',
  openGraph: {
    title: 'Partner with BuyHalfCow',
    description: 'Partner with BuyHalfCow as a brand or affiliate. Direct ranch beef network, premium audience.',
    url: 'https://buyhalfcow.com/partner',
    images: ['/og-image.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Partner with BuyHalfCow',
    description: 'Partner with BuyHalfCow as a brand or affiliate. Direct ranch beef network, premium audience.',
    images: ['/og-image.png'],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
