import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Unsubscribe — BuyHalfCow',
  description: 'Manage your BuyHalfCow email preferences.',
  openGraph: {
    title: 'Unsubscribe — BuyHalfCow',
    description: 'Manage your BuyHalfCow email preferences.',
    url: 'https://www.buyhalfcow.com/unsubscribe',
    images: ['/og-image.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Unsubscribe — BuyHalfCow',
    description: 'Manage your BuyHalfCow email preferences.',
    images: ['/og-image.png'],
  },
};

export default function UnsubscribeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
