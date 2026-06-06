import type { Metadata } from 'next';
import Link from 'next/link';
import BHCPromiseBadge from '@/app/components/BHCPromiseBadge';

export const metadata: Metadata = {
  title: 'The BHC Promise — refundable until rancher accepts',
  description:
    'Your deposit is fully refundable until your rancher accepts your slot. Non-refundable after. Cold-chain guarantee and BHC mediation always apply.',
};

export default function PromisePage() {
  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <div className="max-w-3xl mx-auto px-6 py-12 md:py-20">
        <Link
          href="/"
          className="text-sm text-saddle hover:text-charcoal transition-colors"
        >
          ← BuyHalfCow
        </Link>
        <h1 className="font-serif text-4xl md:text-5xl mt-6 mb-4">
          The BHC Promise
        </h1>
        <p className="text-saddle text-lg mb-10 leading-relaxed">
          The terms of every deposit, the protections that apply, and how we
          handle disputes.
        </p>

        <BHCPromiseBadge />

        <section className="mt-12 space-y-8 text-charcoal leading-relaxed">
          <div>
            <h2 className="font-serif text-2xl mb-3">
              Why deposits work this way
            </h2>
            <p>
              When you place a deposit, your rancher does real work that
              can&rsquo;t be undone: they reserve a processing slot at their
              USDA-inspected facility, set aside cuts of meat from a specific
              animal, and lock in pickup or delivery logistics for your share.
              That moment of commitment is when the deposit becomes
              non-refundable.
            </p>
            <p className="mt-3">
              Before that commitment, you can change your mind for any reason
              and get a full refund — no questions, no penalty. Most ranchers
              accept within 24&ndash;48 hours of you placing the deposit.
            </p>
          </div>

          <div>
            <h2 className="font-serif text-2xl mb-3">
              The refundable window
            </h2>
            <ul className="list-disc list-outside ml-6 space-y-2 text-saddle">
              <li>You place a deposit on the rancher you matched with.</li>
              <li>Rancher reviews and confirms they can fulfill your slot.</li>
              <li>
                Until that confirmation, the deposit sits in a refundable state.
                Reply to your match thread or email{' '}
                <a href="mailto:hello@buyhalfcow.com" className="underline">
                  hello@buyhalfcow.com
                </a>{' '}
                and BHC refunds within 1&ndash;2 business days.
              </li>
              <li>
                Once the rancher accepts, you&rsquo;ll get a &ldquo;slot
                locked&rdquo; email confirming the commitment. Deposit becomes
                non-refundable at that moment.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="font-serif text-2xl mb-3">
              Cold-chain guarantee (always applies)
            </h2>
            <p>
              No matter where you are in the process &mdash; before or after
              acceptance &mdash; if your beef arrives thawed, short, or
              mishandled in transit, BHC makes you whole. Photo within 24 hours
              of receipt and we settle it. Cold-chain liability is on us, not
              the buyer.
            </p>
          </div>

          <div>
            <h2 className="font-serif text-2xl mb-3">
              Disputes &amp; mediation
            </h2>
            <p>
              If something goes sideways &mdash; rancher cancels, processing
              date slips beyond what was promised, beef arrives wrong &mdash;
              reply to your match thread or email{' '}
              <a href="mailto:hello@buyhalfcow.com" className="underline">
                hello@buyhalfcow.com
              </a>
              . Ben mediates directly. No script, no support tier &mdash; a
              real person who knows your match.
            </p>
          </div>

          <div>
            <h2 className="font-serif text-2xl mb-3">
              What we don&rsquo;t do
            </h2>
            <p>
              We don&rsquo;t take legal custody of the beef, we don&rsquo;t
              warehouse, we don&rsquo;t manage cold-chain ourselves. The
              rancher fulfills. BHC is the connection layer, the trust floor,
              and the mediator if things go wrong.
            </p>
          </div>

          <div className="border-t border-dust pt-8 mt-12">
            <p className="text-sm text-saddle">
              Questions before you deposit? Email{' '}
              <a href="mailto:hello@buyhalfcow.com" className="underline">
                hello@buyhalfcow.com
              </a>{' '}
              or reply to any email from us. &mdash; Benjamin, BuyHalfCow
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
