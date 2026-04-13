import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Join The HERD',
  description: 'Apply to join BuyHalfCow — a private, approval-only network for sourcing ranch beef direct from verified American ranchers.',
  openGraph: {
    title: 'Join The HERD — BuyHalfCow',
    description: 'Apply to join BuyHalfCow — source ranch beef direct from verified American ranchers.',
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
