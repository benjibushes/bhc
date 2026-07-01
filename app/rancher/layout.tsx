import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Rancher dashboard — BuyHalfCow',
  description: 'Rancher dashboard — manage your listing, capacity, leads, and payouts.',
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
