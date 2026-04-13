import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Partner With Us',
  description: 'Apply as a rancher, brand, or land seller. BuyHalfCow connects verified operations with qualified buyers through a private, trust-first network.',
  openGraph: {
    title: 'Partner With BuyHalfCow',
    description: 'Join the BuyHalfCow network as a rancher, brand, or land seller.',
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
