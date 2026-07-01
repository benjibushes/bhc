import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Get matched with a verified rancher',
  description: '90-second match. Pick your state, answer 4 questions, talk direct to a verified rancher. No marketplace markup. No middleman.',
  openGraph: {
    title: 'Get matched with a verified rancher',
    description: '90 seconds. Direct ranch beef. No middleman.',
    url: 'https://www.buyhalfcow.com/access',
    images: ['/og-image.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Get matched with a verified rancher',
    description: '90 seconds. Direct ranch beef. No middleman.',
    images: ['/og-image.png'],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
