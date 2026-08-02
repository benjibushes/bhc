'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

// Sticky top promo bar driving traffic to the hat collection.
// - Dismissible (localStorage flag) so power users aren't annoyed.
// - UTM tags so Shopify Analytics shows the source.
// - Hidden on /admin and /api so it doesn't crash internal tools.
//
// CLS FIX (Wave 2 buyer UI 2026-08-01): the bar used to render null on the
// server and flip visible in useEffect — a ~42px layout shift on every
// allowlisted route for every non-dismissed visitor. The ROUTE decision is
// deterministic (usePathname works during SSR), so the bar now server-renders
// on content surfaces and first paint is stable. Only the localStorage
// "dismissed" flag is client-only: previously-dismissed visitors (the rare
// case, and one who chose to remove the bar) see it collapse at hydration.

const STORAGE_KEY = 'bhc-promo-bar-dismissed-v1';
const HAT_URL =
  'https://merch.buyhalfcow.com/collections/hats?utm_source=buyhalfcow&utm_medium=hero-bar&utm_campaign=hat-launch';

// ALLOWLIST (mobile QA 2026-07-08, shares-first): the hat bar was the
// FIRST PIXEL on /shop, every PDP, rancher pages, and the homepage —
// a $20-hat ad above the $13–$6,800 beef. Inverted from a blocklist so
// money surfaces are clean BY CONSTRUCTION: the bar renders only on
// content/browse surfaces, and any future page defaults to no-bar.
// '/news' removed 2026-08-02 — the news rail was deleted (cut list).
const CONTENT_SURFACES = ['/gear', '/wins', '/map', '/faq', '/about'];

export default function PromoBar() {
  const pathname = usePathname() || '';
  const onContentSurface = CONTENT_SURFACES.some(
    (s) => pathname === s || pathname.startsWith(s + '/'),
  );

  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY)) setDismissed(true);
    } catch {
      // localStorage blocked — keep showing (the route decision already ran)
    }
  }, []);

  if (!onContentSurface || dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {}
    setDismissed(true);
  };

  return (
    // No role="banner": the page header is the banner landmark; a second one
    // here made screen readers announce two.
    <div className="w-full bg-charcoal text-bone text-center text-sm font-medium tracking-wide relative">
      <a
        href={HAT_URL}
        className="block px-12 py-2.5 hover:bg-saddle transition-colors"
        target="_blank"
        rel="noopener noreferrer"
      >
        NEW DROP — Rep the Herd · Free shipping over $35 →
      </a>
      <button
        onClick={dismiss}
        className="absolute right-0 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center text-bone/70 hover:text-bone text-lg leading-none"
        aria-label="Dismiss promotion"
      >
        ×
      </button>
    </div>
  );
}
