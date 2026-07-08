// app/order/success/page.tsx
//
// Post-payment landing for a low-ticket product purchase (Stripe success_url +
// Payment Element return_url). The buyer just paid — reassure them, and softly
// point them at a full share + the gear to cook it.
//
// PAYMENT ELEMENT (spec R3): bank-redirect / 3DS returns land here with
// ?redirect_status=. 'failed' must NEVER render "you're set" — it renders an
// honest retry state with a one-tap path back into that product's checkout
// (?pid= rides the return_url for exactly this).
//
// Styled on the brand system — matches the deposit success page so a $20
// jerky buy and an $1,800 deposit read as one company.

import Card from '../../components/Card';
import Button from '../../components/Button';

export const metadata = { title: "you're set — BuyHalfCow" };

export default async function OrderSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_status?: string; pid?: string }>;
}) {
  const sp = await searchParams;
  const failed = String(sp?.redirect_status || '') === 'failed';
  const pid = String(sp?.pid || '');
  const retryHref = /^rec[A-Za-z0-9]{14}$/.test(pid) ? `/shop/checkout/${pid}` : '/shop';

  if (failed) {
    return (
      <main className="min-h-[70vh] flex items-center justify-center px-5 py-10 bg-bone text-charcoal">
        <Card padding="lg" className="max-w-[520px] w-full text-center">
          <h1 className="font-serif text-2xl mb-2 lowercase">that payment didn&rsquo;t go through.</h1>
          <p className="text-charcoal text-base leading-relaxed mb-5">
            your bank declined or cancelled the authorization — <strong>nothing was charged</strong>,
            and your order isn&rsquo;t placed yet.
          </p>
          <Button href={retryHref} fullWidth>try again &rarr;</Button>
          <p className="text-sm text-saddle mt-4">
            keeps happening?{' '}
            <a href="/support" className="underline hover:text-charcoal transition-colors">
              a real person can help
            </a>
            .
          </p>
          <p className="text-xs text-dust mt-6">&mdash; Ben, BuyHalfCow</p>
        </Card>
      </main>
    );
  }

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
