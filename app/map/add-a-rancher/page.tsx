import type { Metadata } from 'next';
import Container from '../../components/Container';
import Pill from '../../components/Pill';
import AddRancherForm from './AddRancherForm';

// Public submission flow. Two paths funnel into the same endpoint:
//   1. "I am this rancher" — self-submit. Welcome email + drip kicks off.
//   2. "I know this rancher" — community-submit. Light intro email
//      ("[Submitter] told us you'd be a great fit") + Telegram alert.
//
// Both paths drop a yellow pin on /map and tag the record so buyers are
// NOT routed there (existing isRancherOperationalForBuyers gate handles
// that — Verification Status stays "Prospect" until Ben closes them on
// the onboarding call).
//
// This is the marketing-services funnel: every submission is a chance to
// pitch ranchers on direct-to-consumer marketing services. Ben closes on
// the call.

export const metadata: Metadata = {
  title: 'Add a Rancher to the Map',
  description:
    'Direct-to-consumer rancher? Add yourself to the public map. Know one? Add them. We’re building the public hit list of every direct-to-consumer rancher in America.',
  openGraph: {
    title: 'Add a Rancher to the BuyHalfCow Discover Map',
    description:
      'Help us build the public hit list of every direct-to-consumer rancher in America.',
  },
};

export default function AddRancherPage() {
  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <section className="py-16 md:py-20 border-b border-divider/10">
        <Container>
          <div className="max-w-3xl space-y-5">
            <Pill tone="amber">Discover Map · Add a Rancher</Pill>
            <h1 className="font-serif text-4xl md:text-6xl leading-tight">
              Put a rancher on the map
            </h1>
            <p className="text-lg text-charcoal/80 leading-relaxed">
              Direct-to-consumer rancher? Add yourself. Know one? Add them. Every
              submission is one more pin on the public hit list of every D2C rancher in
              America &mdash; and a chance for a real ranch to skip the middleman and
              sell direct to families. We&rsquo;ll reach out within 48 hours.
            </p>
            <p className="text-sm text-saddle leading-relaxed">
              Self-submitted ranchers go on the map immediately as a yellow pin.
              You&rsquo;re not routed customers until you&rsquo;ve had a 15-minute call
              with Ben and signed a partner agreement.
            </p>
          </div>
        </Container>
      </section>

      <section className="py-12 md:py-14">
        <Container>
          <AddRancherForm />
        </Container>
      </section>
    </main>
  );
}
