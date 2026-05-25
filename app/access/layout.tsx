import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Get Access',
  description: 'Apply for access to BuyHalfCow — source ranch beef direct from a verified rancher in your state.',
  openGraph: {
    title: 'Get Access — BuyHalfCow',
    description: 'Apply for access to BuyHalfCow — source ranch beef direct from a verified rancher in your state.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Get Access — BuyHalfCow',
    description: 'Apply for access. Source ranch beef direct from a verified rancher in your state.',
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
