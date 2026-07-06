// app/order/success/page.tsx
//
// Post-payment landing for a low-ticket product purchase (Stripe success_url).
// The buyer just paid — reassure them, and (research: the post-purchase moment
// is the ladder-up) softly point them at a full share + the gear to cook it.
// Static + server-rendered; the receipt email carries the order detail.
//
// Styled on the brand system (Phase 3 migration) — matches the deposit
// success page so a $20 jerky buy and an $1,800 deposit read as one company.

import Card from '../../components/Card';
import Button from '../../components/Button';

export const metadata = { title: "you're set — BuyHalfCow" };

export default function OrderSuccessPage() {
  return (
    <main className="min-h-[70vh] flex items-center justify-center px-5 py-10 bg-bone text-charcoal">
      <Card padding="lg" className="max-w-[520px] w-full text-center">
        <h1 className="font-serif text-3xl mb-2 lowercase">you&rsquo;re set.</h1>
        <p className="text-charcoal text-base leading-relaxed mb-5">
          your order&rsquo;s in — the ranch is packing it up and shipping it direct to you. a receipt
          is on its way to your inbox, and you&rsquo;ll get tracking as soon as it ships.
        </p>
        <p className="text-xs text-saddle leading-relaxed -mt-3 mb-5">
          reserved with a deposit? the rancher reaches out first to confirm your size + the balance
          — your deposit counts toward it.
        </p>
        <div className="border-t border-dust pt-5 mt-1 space-y-3">
          <p className="text-sm text-saddle">
            liked what you tasted? a half or whole share is the same beef by the freezer-full.
          </p>
          <Button href="/map">explore full shares &rarr;</Button>
          <p className="text-xs text-saddle">
            and the tools to cook it right —{' '}
            <a href="/gear" className="underline hover:text-charcoal transition-colors">
              the gear ben uses &rarr;
            </a>
          </p>
        </div>
        <p className="text-xs text-dust mt-6">&mdash; Ben, BuyHalfCow</p>
      </Card>
    </main>
  );
}
