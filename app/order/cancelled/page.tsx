// app/order/cancelled/page.tsx
//
// Buyer bailed out of the Stripe Checkout for a low-ticket product (cancel_url).
// No charge. Reassure + leave the door open — no pressure, honest brand voice.
//
// RECOVERY (checkout teardown 2026-07-07): the cancel_url now carries ?pid=
// <productId>, so instead of dumping an interested buyer at the generic shop
// door we hand back the exact product they almost bought — one tap to resume.
// Falls back to /shop when pid is absent/garbage (old links, operator texts).
//
// Styled on the brand system (Phase 3 migration).

import Card from '../../components/Card';
import Button from '../../components/Button';

export const metadata = { title: 'no charge — BuyHalfCow' };

export default async function OrderCancelledPage({
  searchParams,
}: {
  searchParams: Promise<{ pid?: string }>;
}) {
  const sp = await searchParams;
  const pid = String(sp?.pid || '');
  const resumeHref = /^rec[A-Za-z0-9]{14}$/.test(pid) ? `/shop/checkout/${pid}` : '';

  return (
    <main className="min-h-[70vh] flex items-center justify-center px-5 py-10 bg-bone text-charcoal">
      <Card padding="lg" className="max-w-[520px] w-full text-center">
        <h1 className="font-serif text-2xl mb-2 lowercase">no charge.</h1>
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
        {resumeHref ? (
          <div className="space-y-3">
            <Button href={resumeHref} fullWidth>pick up where you left off &rarr;</Button>
            <p className="text-sm">
              <a href="/shop" className="text-saddle underline hover:text-charcoal transition-colors">
                or back to the shop
              </a>
            </p>
          </div>
        ) : (
          <Button href="/shop">back to the shop &rarr;</Button>
        )}
        <p className="text-xs text-dust mt-6">&mdash; Ben, BuyHalfCow</p>
      </Card>
    </main>
  );
}
