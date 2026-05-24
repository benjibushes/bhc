'use client';

import { useEffect } from 'react';
import { trackEvent } from '@/lib/analytics';

// Page-view tracker — rendered once inside the Server Component shell.
export function BrandPartnersViewTracker() {
  useEffect(() => {
    trackEvent('brand_partners_view');
  }, []);
  return null;
}

// CTA button for each tier. Fires tier-click event before navigating.
export default function BrandTierCTA({
  tier,
  href,
  label,
  className,
}: {
  tier: 'spotlight' | 'featured' | 'founding';
  href: string;
  label: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => trackEvent('brand_partners_tier_click', { tier })}
      className={
        className ??
        'block w-full bg-charcoal text-bone font-semibold uppercase tracking-wider text-sm py-4 px-6 text-center min-h-[52px] flex items-center justify-center hover:bg-divider transition-base'
      }
    >
      {label}
    </a>
  );
}
