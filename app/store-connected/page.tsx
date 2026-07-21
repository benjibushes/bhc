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

export default async function StoreConnectedPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; why?: string; already?: string }>;
}) {
  const params = await searchParams;
  const ok = params.ok === '1';
  const why = String(params.why || '');
  const already = params.already === '1';

  return (
    <main className="min-h-[70vh] flex items-center justify-center px-6 py-16 bg-bone">
      <div className="max-w-lg w-full border border-dust bg-bone-warm p-8 text-center space-y-4">
        {ok ? (
          <>
            <p className="text-4xl">🤝</p>
            <h1 className="font-serif text-2xl">
              {already ? 'Your store is already connected' : 'Your store is connected'}
            </h1>
            <p className="text-sm text-saddle">
              When a BuyHalfCow customer buys one of your products, the paid order shows up in
              your Shopify like any other order — pack it and ship it exactly how you already do.
              Your money lands automatically. Nothing else to set up.
            </p>
            <p className="text-xs text-charcoal/60">
              You can close this page. Questions? Reply to any email from Ben, or text him.
            </p>
          </>
        ) : (
          <>
            <p className="text-4xl">🪵</p>
            <h1 className="font-serif text-2xl">That didn’t go through</h1>
            <p className="text-sm text-saddle">
              {FAIL_COPY[why] || 'Something unexpected happened. Text Ben — he can see exactly what.'}
            </p>
            {PRE_INSTALL_REASONS.has(why) && (
              <p className="text-xs text-charcoal/60">Nothing was changed on your store.</p>
            )}
          </>
        )}
        <p className="pt-2">
          <Link href="/" className="text-xs text-saddle underline underline-offset-4">
            buyhalfcow.com
          </Link>
        </p>
      </div>
    </main>
  );
}
