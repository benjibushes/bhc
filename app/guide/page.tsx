// /guide — "The Real Cost of a Half Cow" — the quiz-free lead magnet
// (reach lever #2, 2026-07-06).
//
// Before this page, every list-capture surface sat BEHIND the $2k quiz. This
// is the email-only door: the page GIVES the honest math up front (value
// first — brand rule), then trades the full guide + drop alerts for an email
// (+ optional SMS). Contacts land in the same Consumers pipeline every flow
// already reads. This is the link-in-bio capture rung and the IG
// comment-to-DM destination.

import type { Metadata } from 'next';
import Container from '../components/Container';
import Divider from '../components/Divider';
import GuideCaptureForm from './GuideCaptureForm';

export const metadata: Metadata = {
  title: 'The Real Cost of a Half Cow — the honest math',
  description:
    'What a half beef actually costs, how many pounds you really get, how much freezer you need, and the honest math against grocery prices — from BuyHalfCow.',
  openGraph: {
    title: 'The Real Cost of a Half Cow',
    description: 'The honest math nobody selling you one will give you.',
    url: 'https://www.buyhalfcow.com/guide',
    images: ['/og-image.png'],
  },
};

// Numbers retuned 2026-07-15 (funnel truth PR) to live supply: halves
// $3,299–3,650 — the old $1,800–3,500 / $5.50–9.50/lb understated real
// prices 40–50% and set up sticker shock on the rancher call.
const MATH = [
  { k: 'all-in price (animal + processing)', v: '$3,000–3,700' },
  { k: 'packaged beef in your freezer', v: '180–220 lbs' },
  { k: 'what ranchers quote (hanging weight)', v: '$8–11/lb' },
  { k: 'blended take-home price per pound', v: '$14–20/lb' },
  { k: 'same grass-fed cuts à la carte', v: '$9–35/lb' },
];

export default function GuidePage() {
  return (
    <main className="min-h-screen pt-8 pb-16 md:py-24 bg-bone text-charcoal">
      <Container>
        <div className="max-w-2xl mx-auto space-y-10">
          <div className="text-center space-y-5">
            <h1 className="font-serif text-4xl md:text-5xl">the real cost of a half cow</h1>
            <Divider />
            <p className="text-lg leading-relaxed text-saddle">
              the honest math nobody selling you one will give you — what it costs, what you
              actually get, and whether it&rsquo;s worth it for your family. &mdash; Ben
            </p>
          </div>

          {/* Value FIRST — the core math lives on the page, ungated. */}
          <div className="border border-dust bg-bone-warm">
            {MATH.map((row) => (
              <div
                key={row.k}
                className="flex justify-between gap-4 items-baseline px-5 py-3.5 border-b border-dust last:border-b-0"
              >
                <span className="text-[14.5px] text-saddle">{row.k}</span>
                <span className="font-serif text-lg text-charcoal whitespace-nowrap">{row.v}</span>
              </div>
            ))}
          </div>

          <div className="space-y-4 text-[15.5px] leading-relaxed">
            <p>
              <strong>the honest part:</strong> roughly 40&ndash;50% of a half beef arrives as
              ground and stew meat. you&rsquo;re stocking a freezer with a year of real dinners
              — not buying a box of ribeyes. the value isn&rsquo;t a discount on ground beef:
              it&rsquo;s that every pound costs the same blended price, ribeye to chuck. plan on
              ~8&ndash;10 cubic feet of freezer space (a $200&ndash;300 chest freezer pays for
              itself in the first fill).
            </p>
            <p>
              <strong>how it works here:</strong> a small refundable deposit reserves your share
              with a named, verified family ranch. you pay the balance at final weight. no
              warehouse, no middleman markup.
            </p>
          </div>

          <GuideCaptureForm />

          <p className="text-center text-[13.5px] text-saddle">
            not ready for a freezer full?{' '}
            <a href="/shop" className="underline hover:text-charcoal transition-colors">
              start with jerky &amp; boxes, shipped &rarr;
            </a>{' '}
            · or{' '}
            <a href="/access" className="underline hover:text-charcoal transition-colors">
              take the 90-second quiz &rarr;
            </a>{' '}
            · or{' '}
            <a href="/half-a-cow" className="underline hover:text-charcoal transition-colors">
              find half a cow near you &rarr;
            </a>
          </p>
        </div>
      </Container>
    </main>
  );
}
