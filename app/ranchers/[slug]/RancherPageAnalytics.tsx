'use client';

// Audit 6 P1 — paid-scale tracking gap.
//
// /ranchers/[slug] is a server component (revalidate=600 SSG) — can't fire
// analytics events from it directly. This zero-render client island fires
// rancher_page_view on mount + exposes a pricing-click handler the server
// page can wire into the "See pricing" anchor.
//
// Why: PixelTracker fires a generic PageView for every page, but Meta
// optimization needs per-rancher segmentation (custom_data: rancherSlug +
// rancherState) so paid creative attribution attributes back to the rancher
// landing page the buyer actually saw.
//
// Events:
//   - rancher_page_view  → Meta ViewContent + GA page_view
//   - rancher_pricing_click → Meta AddToCart + GA select_item (intent signal)

import { useEffect } from 'react';
import { trackEvent } from '@/lib/analytics';

interface Props {
  rancherId: string;
  rancherSlug: string;
  rancherState: string;
}

export default function RancherPageAnalytics({
  rancherId,
  rancherSlug,
  rancherState,
}: Props) {
  useEffect(() => {
    trackEvent('rancher_page_view', {
      rancherId,
      rancherSlug,
      rancherState,
    });
  }, [rancherId, rancherSlug, rancherState]);

  return null;
}

interface PricingCTAProps {
  href: string;
  rancherSlug: string;
  rancherState: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * Wraps the "See pricing" anchor with rancher_pricing_click fire. Stays a
 * native <a> so server-rendered HTML still works without JS (SEO + no-JS
 * fallback). On click fires the intent event before the anchor scrolls.
 */
export function RancherPricingCTA({
  href,
  rancherSlug,
  rancherState,
  className,
  children,
}: PricingCTAProps) {
  return (
    <a
      href={href}
      className={className}
      onClick={() => {
        try {
          trackEvent('rancher_pricing_click', { rancherSlug, rancherState });
        } catch {}
      }}
    >
      {children}
    </a>
  );
}
