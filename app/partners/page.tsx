// /partners — the PUBLIC front door for the creator/ambassador affiliate rail.
//
// Reach-monetization research (2026-07-06): the entire affiliate machine was
// already built — POST /api/affiliates/signup mints codes, lib/affiliates
// attributes, /affiliate is a full clicks/signups/closes dashboard — but the
// ONLY surface that offered it was the /access thank-you state, so only
// people who finished the $2k quiz ever saw it. A commission-only sales
// force, fully coded, switched off. This page is the switch.
//
// Server wrapper for metadata; the form is the client component below.

import type { Metadata } from 'next';
import Container from '../components/Container';
import Divider from '../components/Divider';
import PartnerSignupForm from './PartnerSignupForm';

export const metadata: Metadata = {
  title: 'Partner with BuyHalfCow — earn on every close',
  description:
    'Share real ranch beef with your audience and earn a commission on every buyer you send. Free to join, your own tracked link, a live dashboard.',
  openGraph: {
    title: 'Partner with BuyHalfCow',
    description: 'Share real ranch beef. Earn on every close. Free to join.',
    url: 'https://www.buyhalfcow.com/partners',
    images: ['/og-image.png'],
  },
};

const HOW = [
  {
    n: '1',
    t: 'Grab your link',
    d: 'Sign up below — takes 30 seconds, no approval wait. You get a short tracked link that works for everything: beef, shares, even ranchers you refer.',
  },
  {
    n: '2',
    t: 'Share it your way',
    d: 'Post it, pin it, put it in your bio. Your audience gets real beef from named family ranches — jerky and boxes shipped nationwide, or a half-cow from a ranch near them.',
  },
  {
    n: '3',
    t: 'Earn on every close',
    d: 'Every buyer who comes through your link is attributed to you — quiz signups, product orders, share deposits. Watch it live on your dashboard.',
  },
];

export default function PartnersPage() {
  return (
    <main className="min-h-screen pt-8 pb-16 md:py-24 bg-bone text-charcoal">
      <Container>
        <div className="max-w-3xl mx-auto space-y-10">
          <div className="text-center space-y-5">
            <h1 className="font-serif text-4xl md:text-5xl">partner with buyhalfcow</h1>
            <Divider />
            <p className="text-lg leading-relaxed text-saddle">
              you have an audience that cares about real food. we have the beef — verified
              family ranches, shipped nationwide or picked up local. share it, and earn a
              commission on every buyer you send. free to join, no minimums, no exclusivity.
              &mdash; Ben
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {HOW.map((s) => (
              <div key={s.n} className="border border-dust bg-bone-warm p-5">
                <div className="font-serif text-2xl text-saddle mb-2">{s.n}</div>
                <h2 className="font-serif text-lg mb-1.5">{s.t}</h2>
                <p className="text-[13.5px] text-saddle leading-relaxed m-0">{s.d}</p>
              </div>
            ))}
          </div>

          <PartnerSignupForm />

          <p className="text-center text-xs text-saddle">
            already a partner?{' '}
            <a href="/affiliate/login" className="underline hover:text-charcoal transition-colors">
              open your dashboard &rarr;
            </a>
          </p>
        </div>
      </Container>
    </main>
  );
}
