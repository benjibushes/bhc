'use client';

import { trackEvent } from '@/lib/analytics';

export default function MerchCTA() {
  return (
    <a
      href="https://www.buyhalfcow.com/shop"
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => trackEvent('shop_click', { surface: 'matched' })}
      className="block mt-12 border border-dust p-6 bg-bone hover:bg-divider transition"
    >
      <div className="font-serif text-xl text-charcoal mb-2">rep the rebuild</div>
      <p className="text-saddle text-sm mb-3">
        while you wait for the call from your rancher — bhc patches, hats, and shirts ship same-day. small batch. real merch from a real rebuild.
      </p>
      <span className="text-charcoal font-semibold uppercase tracking-wider text-sm underline">
        shop bhc merch →
      </span>
    </a>
  );
}
