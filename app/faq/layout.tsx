import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'FAQ',
  description: 'Frequently asked questions about BuyHalfCow — how the network works, pricing, sourcing ranch beef, rancher applications, and more.',
  openGraph: {
    title: 'FAQ — BuyHalfCow',
    description: 'Common questions about sourcing ranch beef through BuyHalfCow.',
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
