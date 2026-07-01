import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'News + updates — BuyHalfCow',
  description: 'Latest from BuyHalfCow — partner spotlights, deal closes, ranch profiles, founder updates.',
  openGraph: {
    title: 'News + updates — BuyHalfCow',
    description: 'Latest from BuyHalfCow — partner spotlights, deal closes, ranch profiles, founder updates.',
    url: 'https://www.buyhalfcow.com/news',
    images: ['/og-image.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'News + updates — BuyHalfCow',
    description: 'Latest from BuyHalfCow — partner spotlights, deal closes, ranch profiles, founder updates.',
    images: ['/og-image.png'],
  },
};

export default function NewsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
