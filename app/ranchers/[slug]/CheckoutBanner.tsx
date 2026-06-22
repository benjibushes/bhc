'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

// Post-pay return banner for the public ranch page. Commerce checkout sends the
// buyer back to /ranchers/[slug]?checkout=success&order=<id> (paid) or
// ?checkout=cancelled (abandoned). This leaf reads that query param CLIENT-SIDE
// (useSearchParams) and renders a dismissible banner.
//
// ISR PRESERVATION: the ranch page is statically generated with ISR
// (`export const revalidate = 600`). This component is `'use client'` and reads
// the query string in the browser only — the server never needs the request's
// search params to render the page shell, so the page stays static and ISR is
// untouched. useSearchParams() must sit under a Suspense boundary or Next opts
// the whole route into dynamic rendering (and throws at static-export time);
// the inner reader below is wrapped in <Suspense> to keep the page static.
//
// Brand: matte/flat — charcoal border, bone/saddle fills, no rounded corners,
// no shadow, no gradient. Mobile-first.

function CheckoutBannerInner({ rancherName }: { rancherName: string }) {
  const params = useSearchParams();
  const checkout = params.get('checkout');
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;
  if (checkout !== 'success' && checkout !== 'cancelled') return null;

  const isSuccess = checkout === 'success';

  return (
    <div
      role="status"
      className={`border-b ${
        isSuccess
          ? 'border-charcoal bg-saddle text-bone'
          : 'border-dust bg-bone-warm text-charcoal'
      }`}
    >
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <div className="flex items-start justify-between gap-4 py-3 md:py-4">
          <p className="text-sm md:text-base leading-relaxed">
            {isSuccess ? (
              <>
                <span aria-hidden className="mr-1">✓</span>
                Reserved! Your deposit is in — {rancherName} will be in touch about
                pickup.
              </>
            ) : (
              <>Checkout cancelled — your share is still available.</>
            )}
          </p>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss"
            className={`shrink-0 text-lg leading-none transition-base ${
              isSuccess ? 'text-bone/70 hover:text-bone' : 'text-dust hover:text-charcoal'
            }`}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CheckoutBanner({ rancherName }: { rancherName: string }) {
  // Suspense boundary keeps useSearchParams from forcing dynamic rendering, so
  // the ranch page's ISR stays intact. Fallback is null — nothing flashes before
  // the param resolves on the client.
  return (
    <Suspense fallback={null}>
      <CheckoutBannerInner rancherName={rancherName} />
    </Suspense>
  );
}
