// app/order/cancelled/page.tsx
//
// Buyer bailed out of the Stripe Checkout for a low-ticket product (cancel_url).
// No charge. Reassure + leave the door open — no pressure, honest brand voice.
//
// Styled on the brand system (Phase 3 migration).

import Card from '../../components/Card';
import Button from '../../components/Button';

export const metadata = { title: 'no charge — BuyHalfCow' };

export default function OrderCancelledPage() {
  return (
    <main className="min-h-[70vh] flex items-center justify-center px-5 py-10 bg-bone text-charcoal">
      <Card padding="lg" className="max-w-[520px] w-full text-center">
        <h1 className="font-serif text-2xl mb-2 lowercase">no charge.</h1>
        {/* Copy fix (audit D-4): a cold /shop buyer has no "link/text/email"
            to go back to — that framing was written for operator-texted links.
            Neutral copy that's true for both entry paths. */}
        <p className="text-charcoal text-base leading-relaxed mb-5">
          you closed out before finishing &mdash; nothing was charged, and there&rsquo;s no rush.
        </p>
        <p className="text-sm text-saddle mb-4">
          questions about the cuts or shipping?{' '}
          <a href="/support" className="underline hover:text-charcoal transition-colors">
            ask a real person
          </a>{' '}
          &mdash; we answer.
        </p>
        <Button href="/shop">back to the shop &rarr;</Button>
        <p className="text-xs text-dust mt-6">&mdash; Ben, BuyHalfCow</p>
      </Card>
    </main>
  );
}
