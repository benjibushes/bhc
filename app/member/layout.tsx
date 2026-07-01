import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Member dashboard — BuyHalfCow',
  description: 'Your member dashboard — track matches, message your rancher, manage your account.',
  openGraph: {
    title: 'Member dashboard — BuyHalfCow',
    description: 'Your member dashboard — track matches, message your rancher, manage your account.',
    url: 'https://www.buyhalfcow.com/member',
    images: ['/og-image.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Member dashboard — BuyHalfCow',
    description: 'Your member dashboard — track matches, message your rancher, manage your account.',
    images: ['/og-image.png'],
  },
};

export default function MemberLayout({ children }: { children: React.ReactNode }) {
  return children;
}
