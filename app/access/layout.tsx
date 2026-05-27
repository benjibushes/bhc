import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Get matched with a verified rancher',
  description: '90-second quiz. We connect you with a verified American rancher in your state for direct, transparent beef buying. No marketplace markup. No middlemen.',
  openGraph: {
    title: 'Get matched with a verified rancher',
    description: '90 seconds. Direct ranch beef. No middlemen.',
    url: 'https://buyhalfcow.com/access',
    images: ['/og-image.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Get matched with a verified rancher',
    description: '90 seconds. Direct ranch beef. No middlemen.',
    images: ['/og-image.png'],
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
