import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'FAQ — BuyHalfCow',
  description: 'Common questions about BuyHalfCow — how matching works, who pays, what verification means.',
  openGraph: {
    title: 'FAQ — BuyHalfCow',
    description: 'Common questions about BuyHalfCow — how matching works, who pays, what verification means.',
    url: 'https://www.buyhalfcow.com/faq',
    images: ['/og-image.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FAQ — BuyHalfCow',
    description: 'Common questions about BuyHalfCow — how matching works, who pays, what verification means.',
    images: ['/og-image.png'],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
