// app/contact/page.tsx
//
// The always-200 fallback page for the operator booking-link resolver
// (lib/calBooking.ts FALLBACK_URL = `${SITE_URL}/contact`). Before this page
// existed, any time the Cal API couldn't confirm a live event the resolver
// handed out a /contact URL that 404'd — so a dead booking link still shipped
// to ranchers + buyers. This gives that fallback a real, on-brand landing
// spot. Server component, no client JS needed.

import Link from 'next/link';
import Container from '../components/Container';

export const metadata = {
  title: 'Contact — BuyHalfCow',
  description: 'Get in touch with the BuyHalfCow team.',
};

export default function ContactPage() {
  return (
    <main className="min-h-screen bg-bone text-charcoal flex items-center justify-center py-24">
      <Container>
        <div className="max-w-xl mx-auto text-center space-y-6">
          <h1 className="font-serif text-4xl md:text-5xl">Get in touch</h1>
          <p className="text-saddle text-base sm:text-lg leading-relaxed">
            Questions about your order, a ranch, or booking a call? Email us and
            we&apos;ll get right back to you.
          </p>
          <p className="text-lg">
            <a
              href="mailto:ben@buyhalfcow.com"
              className="font-semibold text-charcoal underline underline-offset-4 hover:text-saddle transition-colors"
            >
              ben@buyhalfcow.com
            </a>
          </p>
          <div className="pt-4">
            <Link
              href="/"
              className="inline-block px-6 py-3 border border-charcoal hover:bg-charcoal hover:text-bone transition-colors uppercase font-semibold tracking-wider text-sm"
            >
              Back to home
            </Link>
          </div>
        </div>
      </Container>
    </main>
  );
}
