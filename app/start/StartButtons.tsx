'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { trackEvent } from '@/lib/analytics';

// Audience self-select grid. 4 equal-weight cards — one per audience
// (buyer / rancher / backer / brand). Each card carries its own proof
// point + price/value anchor + CTA. Visual differentiation via bg color
// helps visitors spot their card instantly.
//
// Mobile: 1-col stack. Desktop: 2x2 grid.

export function PageViewTracker() {
  useEffect(() => {
    trackEvent('start_view');
  }, []);
  return null;
}

interface AudienceCardProps {
  href: string;
  label: string; // BUYERS / RANCHERS / etc
  meta?: string; // proof / scarcity / price (right-aligned with label)
  headline: string; // main value prop
  proofLine1?: string; // first proof bullet
  proofLine2?: string; // second proof bullet
  body: string; // descriptive copy
  ctaLabel: string; // button text
  route: 'buyer' | 'rancher' | 'founder' | 'brand';
  // Visual variant — bone-warm (buyer, home/warm), bone (rancher, neutral),
  // charcoal (backer, aspirational dark), bone-deep (brand, institutional)
  variant: 'warm' | 'neutral' | 'dark' | 'deep';
}

const variantClasses: Record<AudienceCardProps['variant'], string> = {
  warm: 'bg-bone-warm border-2 border-charcoal hover:bg-bone-deep text-charcoal',
  neutral: 'bg-bone border-2 border-charcoal hover:bg-bone-warm text-charcoal',
  dark: 'bg-charcoal border-2 border-charcoal hover:bg-divider text-bone',
  deep: 'bg-bone-deep border-2 border-charcoal hover:bg-bone-warm text-charcoal',
};

export function AudienceCard({
  href,
  label,
  meta,
  headline,
  proofLine1,
  proofLine2,
  body,
  ctaLabel,
  route,
  variant,
}: AudienceCardProps) {
  const isDark = variant === 'dark';
  return (
    <Link
      href={href}
      onClick={() => trackEvent('start_button_click', { route })}
      className={`group block transition-base p-5 sm:p-6 flex flex-col ${variantClasses[variant]}`}
    >
      {/* Header: label + meta */}
      <div className="flex items-baseline justify-between mb-3">
        <span
          className={`text-xs uppercase tracking-wider font-semibold ${
            isDark ? 'text-bone/70' : 'text-saddle'
          }`}
        >
          {label}
        </span>
        {meta && (
          <span
            className={`text-xs font-semibold ${
              isDark ? 'text-bone' : 'text-charcoal'
            }`}
          >
            {meta}
          </span>
        )}
      </div>

      {/* Headline */}
      <div
        className={`font-serif text-xl sm:text-2xl leading-tight mb-3 ${
          isDark ? 'text-bone' : 'text-charcoal'
        }`}
      >
        {headline}
      </div>

      {/* Proof lines */}
      {(proofLine1 || proofLine2) && (
        <ul className={`text-sm mb-3 space-y-1 ${isDark ? 'text-bone/80' : 'text-saddle'}`}>
          {proofLine1 && <li>· {proofLine1}</li>}
          {proofLine2 && <li>· {proofLine2}</li>}
        </ul>
      )}

      {/* Body */}
      <p className={`text-sm mb-5 ${isDark ? 'text-bone/80' : 'text-saddle'}`}>
        {body}
      </p>

      {/* CTA — pushed to bottom of card */}
      <div className="mt-auto flex items-center justify-between">
        <span
          className={`text-sm uppercase tracking-wider font-semibold ${
            isDark ? 'text-bone' : 'text-charcoal'
          }`}
        >
          {ctaLabel}
        </span>
        <span
          aria-hidden="true"
          className={`text-xl transition-transform group-hover:translate-x-1 ${
            isDark ? 'text-bone' : 'text-charcoal'
          }`}
        >
          →
        </span>
      </div>
    </Link>
  );
}
