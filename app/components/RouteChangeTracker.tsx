'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    fbq?: (...args: any[]) => void;
    gtag?: (...args: any[]) => void;
  }
}

/**
 * Fires Meta Pixel + GA4 page_view on Next.js App Router client-side route
 * changes. The initial PageView is fired by PixelTracker's inline script
 * (fbq('init') → fbq('track','PageView')); this island only fires on
 * subsequent SPA navigations to close the attribution gap.
 *
 * Previously, /  → /access → /founders SPA hops were invisible to Pixel —
 * every paid-ad lander click counted as one PageView regardless of how
 * many pages the user actually visited. This was the largest single
 * attribution gap on the platform.
 */
export default function RouteChangeTracker() {
  const pathname = usePathname();
  const isFirstMount = useRef(true);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Skip the initial mount — PixelTracker already fires that PageView
    // on initial layout render. Fire only on subsequent route changes.
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    if (window.fbq) window.fbq('track', 'PageView');
    if (window.gtag) window.gtag('event', 'page_view', { page_path: pathname });
  }, [pathname]);

  return null;
}
