'use client';

import { useEffect, useState } from 'react';

// Sticky top promo bar driving traffic to the hat collection.
// - Dismissible (localStorage flag) so power users aren't annoyed.
// - UTM tags so Shopify Analytics shows the source.
// - Hidden on /admin and /api so it doesn't crash internal tools.

const STORAGE_KEY = 'bhc-promo-bar-dismissed-v1';
const HAT_URL =
  'https://merch.buyhalfcow.com/collections/hats?utm_source=buyhalfcow&utm_medium=hero-bar&utm_campaign=hat-launch';

export default function PromoBar() {
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    try {
      if (typeof window === 'undefined') return;
      // ALLOWLIST (mobile QA 2026-07-08, shares-first): the hat bar was the
      // FIRST PIXEL on /shop, every PDP, rancher pages, and the homepage —
      // a $20-hat ad above the $13–$6,800 beef. Inverted from a blocklist so
      // money surfaces are clean BY CONSTRUCTION: the bar renders only on
      // content/browse surfaces, and any future page defaults to no-bar.
      const p = window.location.pathname;
      const CONTENT_SURFACES = ['/gear', '/wins', '/map', '/faq', '/about'];
      if (!CONTENT_SURFACES.some((s) => p === s || p.startsWith(s + '/'))) return;
      const dismissed = localStorage.getItem(STORAGE_KEY);
      if (!dismissed) setHidden(false);
    } catch {
      // localStorage blocked — stay hidden (fail toward a clean page)
    }
  }, []);

  if (hidden) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {}
    setHidden(true);
  };

  return (
    <div
      className="w-full bg-charcoal text-bone text-center text-sm font-medium tracking-wide relative"
      role="banner"
    >
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
        className="absolute right-2 top-1/2 -translate-y-1/2 text-bone/70 hover:text-bone px-2 py-1 text-lg leading-none"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
