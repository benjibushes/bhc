import type { Metadata } from 'next';
import RepresentForm from './RepresentForm';

export const metadata: Metadata = {
  title: 'Let us sell your beef | BuyHalfCow',
  description:
    'We find the buyer, close the sale, and send you the order. No account, no software, no monthly fee. You collect your balance directly from the buyer.',
  robots: { index: false, follow: false },
};

// BROKER RAIL rancher signup — notify-only.
//
// noindex: this is a page Ben sends to a specific rancher he has already
// spoken to, not a public funnel. It also must not compete with /apply (the
// real platform onboarding) in search — a rancher who could be a payable
// Connect rancher should not land here by accident.

export default function RepresentPage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-14">
      <p className="text-sm uppercase tracking-wide text-stone-500">For ranchers</p>
      <h1 className="mt-2 font-serif text-4xl leading-tight">
        We sell your beef. You fulfill and get paid.
      </h1>
      <p className="mt-4 text-lg text-stone-700">
        No account to create, no software to learn, no monthly fee, and nothing to check.
        We find the buyer and close the sale. You get one email with everything you need.
      </p>

      {/* THE MONEY, BEFORE SUBMIT. The rancher funds the commission out of his
          own price, so he must see and accept that math here — never discover
          it when an order lands. Same wording as the confirmation email. */}
      <section className="mt-10 rounded-sm border border-stone-300 bg-stone-50 p-6">
        <h2 className="font-serif text-2xl">How we get paid</h2>
        <p className="mt-3 text-stone-700">
          <strong>You set the full price of a share.</strong> When we sell one, the buyer pays a
          deposit to BuyHalfCow. <strong>That deposit is our commission</strong> — it is the only
          thing we ever charge you, and we never send you an invoice.
        </p>
        <p className="mt-3 text-stone-700">
          <strong>You collect the rest directly from the buyer.</strong> Your net on every share is
          your full price minus that deposit.
        </p>
        <div className="mt-5 rounded-sm border border-stone-300 bg-white p-4 text-sm">
          <p className="font-medium text-stone-900">For example, on a half share priced at $1,800 with a $400 deposit:</p>
          <ul className="mt-2 space-y-1 text-stone-700">
            <li>The buyer pays $1,800 in total — the same as buying from you direct.</li>
            <li>BuyHalfCow collects the $400 deposit and keeps it as our commission.</li>
            <li>You collect $1,400 from the buyer, and <strong>you net $1,400</strong>.</li>
          </ul>
        </div>
        <p className="mt-4 text-sm text-stone-600">
          You choose your prices and your deposit, so you always control your net. Want a different
          number? Tell us and we&apos;ll set it.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="font-serif text-2xl">What you actually do</h2>
        <ol className="mt-3 space-y-2 text-stone-700">
          <li>
            <strong>1.</strong> Tell us what you sell and what you charge.
          </li>
          <li>
            <strong>2.</strong> When a share sells, we email you the buyer&apos;s name, phone, email,
            what they bought, the exact amount to collect, and your net.
          </li>
          <li>
            <strong>3.</strong> You contact them, fulfill, and collect your balance. That&apos;s it.
          </li>
        </ol>
      </section>

      <RepresentForm />
    </main>
  );
}
