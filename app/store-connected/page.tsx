// /store-connected — the landing page after a distributor's one-click
// Shopify install (success AND failure states). This is the last thing a
// non-technical store owner sees in the flow: plain words, no jargon, and a
// human path (reply to Ben) when something went wrong.

import Link from 'next/link';

export const dynamic = 'force-dynamic';

const FAIL_COPY: Record<string, string> = {
  'expired-link': 'This install link has expired. Text Ben and he’ll send a fresh one — takes him a minute.',
  'bad-link': 'This install link doesn’t look right. Text Ben for a fresh one.',
  'not-staged': 'This store isn’t staged for install yet. Text Ben and he’ll set it up.',
  'unknown-rancher': 'We couldn’t match this link to an account. Text Ben for a fresh link.',
  'too-many-attempts': 'Too many attempts in a row. Wait a few minutes and click the link again.',
  'bad-state': 'The install session expired (links are good for an hour once opened). Click your install link again.',
  'bad-nonce': 'The install session expired. Click your install link again.',
  'bad-shop': 'The store address didn’t check out. Text Ben.',
  'shop-mismatch': 'This install came from a different store than expected. Text Ben.',
  'bad-hmac': 'The install couldn’t be verified. Click your install link again; if it repeats, text Ben.',
  'missing-code': 'Shopify didn’t send an authorization code. Click your install link again.',
  'token-exchange': 'Shopify didn’t accept the install handshake. Click your install link again; if it repeats, text Ben.',
  'secret-unavailable': 'A configuration problem on our side. Text Ben — nothing is wrong with your store.',
  'store-validation': 'The app installed on your store, but we couldn’t finish the hookup on our side. Text Ben — he already got the details and can finish it without you redoing anything.',
};

// Failures BEFORE Shopify issued a token — for these, "nothing changed on
// your store" is literally true. Post-approval failures (token-exchange,
// store-validation) may have installed the app, so we don't claim otherwise.
const PRE_INSTALL_REASONS = new Set([
  'expired-link', 'bad-link', 'not-staged', 'unknown-rancher',
  'too-many-attempts', 'bad-state', 'bad-nonce', 'bad-shop',
  'shop-mismatch', 'bad-hmac', 'missing-code', 'secret-unavailable', 'bad-request',
]);

const NEXT_STEPS: { title: string; body: string }[] = [
  { title: 'Orders appear', body: 'Paid BuyHalfCow orders show up in your Shopify like any other order.' },
  { title: 'You ship like normal', body: 'Same pick, pack, and label flow you already run. Nothing new to learn.' },
  { title: 'Money lands itself', body: 'Your cut arrives in your account the moment a customer pays. No invoices.' },
];

// Signed-in rancher variant (one-click install from the dashboard card):
// no instant-payout promise (that depends on their Stripe setup, which this
// page can't see) and — sync mode — the curation-gate truth, so "connected
// but nothing on /shop yet" doesn't read as broken.
const RANCHER_NEXT_STEPS = (sync: boolean): { title: string; body: string }[] => [
  ...(sync
    ? [{ title: 'Products imported', body: 'Your catalog synced over. BuyHalfCow approves each product before it displays on the marketplace — nothing shows until then.' }]
    : [{ title: 'Products match by SKU', body: 'List products from your Products tab and we match them to your store by SKU.' }]),
  { title: 'Orders appear', body: 'Paid BuyHalfCow orders show up in your Shopify like any other order.' },
  { title: 'Getting paid', body: 'Your cut pays out through the Stripe setup in your dashboard’s Money tab — finish that and sales go live.' },
];

export default async function StoreConnectedPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; why?: string; already?: string; rancher?: string; sync?: string }>;
}) {
  const params = await searchParams;
  const ok = params.ok === '1';
  const why = String(params.why || '');
  const already = params.already === '1';
  const rancher = params.rancher === '1';
  const steps = rancher ? RANCHER_NEXT_STEPS(params.sync === '1') : NEXT_STEPS;

  return (
    <main className="min-h-[70vh] flex items-center justify-center px-6 py-20 bg-bone">
      <div className="max-w-2xl w-full">
        <div className="border border-divider/20 bg-bone-warm px-8 py-12 sm:px-14 text-center">
          <p className="text-[11px] uppercase tracking-[0.25em] text-dust mb-8">
            BuyHalfCow · Store Connection
          </p>

          <span
            aria-hidden
            className={`inline-flex items-center justify-center w-14 h-14 rounded-full border text-2xl font-serif mb-6 ${
              ok ? 'border-sage/50 text-sage' : 'border-weathered/50 text-weathered'
            }`}
          >
            {ok ? '✓' : '✕'}
          </span>

          {ok ? (
            <>
              <h1 className="font-serif text-3xl sm:text-4xl text-charcoal">
                {already ? 'Your store is already connected' : 'Your store is connected'}
              </h1>
              <p className="text-sm text-saddle mt-4 max-w-md mx-auto leading-relaxed">
                That’s everything — there is nothing else to set up. You can close this page.
              </p>

              <div className="grid sm:grid-cols-3 gap-6 sm:gap-0 mt-10 sm:divide-x sm:divide-divider/15 text-left sm:text-center">
                {steps.map((s) => (
                  <div key={s.title} className="sm:px-5">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-charcoal font-medium">
                      {s.title}
                    </p>
                    <p className="text-xs text-saddle mt-2 leading-relaxed">{s.body}</p>
                  </div>
                ))}
              </div>

              <p className="text-xs text-dust mt-10">
                Questions? Reply to any email from Ben, or text him — a real person answers.
              </p>
            </>
          ) : (
            <>
              <h1 className="font-serif text-3xl sm:text-4xl text-charcoal">That didn’t go through</h1>
              <p className="text-sm text-saddle mt-4 max-w-md mx-auto leading-relaxed">
                {FAIL_COPY[why] || 'Something unexpected happened. Text Ben — he can see exactly what.'}
              </p>
              {PRE_INSTALL_REASONS.has(why) && (
                <p className="text-xs text-dust mt-6">Nothing was changed on your store.</p>
              )}
            </>
          )}
        </div>

        <p className="text-center mt-6">
          <Link
            href={rancher ? '/rancher' : '/'}
            className="text-[11px] uppercase tracking-[0.2em] text-saddle underline underline-offset-4 hover:text-charcoal transition-colors"
          >
            {rancher ? 'Back to your dashboard' : 'buyhalfcow.com'}
          </Link>
        </p>
      </div>
    </main>
  );
}
