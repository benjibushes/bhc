'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { trackEvent } from '@/lib/analytics';

// 4-audience self-select. Each card = audience-specific proof + risk
// reversal microcopy + time-anchored CTA. Voice: direct relationships
// + food integrity + freezer-fill abundance. Not price/discount framing.

export function PageViewTracker() {
  useEffect(() => {
    trackEvent('start_view');
  }, []);
  return null;
}

interface AudienceCardProps {
  href: string;
  label: string;
  meta?: string;
  headline: string;
  proofLine1?: string;
  proofLine2?: string;
  body: string;
  ctaLabel: string;
  riskReversal: string; // microcopy under CTA — "free · no card" style
  route: 'buyer' | 'rancher' | 'founder' | 'brand';
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
  riskReversal,
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

      <div
        className={`font-serif text-xl sm:text-2xl leading-tight mb-3 ${
          isDark ? 'text-bone' : 'text-charcoal'
        }`}
      >
        {headline}
      </div>

      {(proofLine1 || proofLine2) && (
        <ul className={`text-sm mb-3 space-y-1 ${isDark ? 'text-bone/80' : 'text-saddle'}`}>
          {proofLine1 && <li>· {proofLine1}</li>}
          {proofLine2 && <li>· {proofLine2}</li>}
        </ul>
      )}

      <p className={`text-sm mb-5 ${isDark ? 'text-bone/80' : 'text-saddle'}`}>
        {body}
      </p>

      <div className="mt-auto">
        <div className="flex items-center justify-between mb-2">
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
        {/* Risk-reversal microcopy directly under CTA — Joanna Wiebe
            pattern: explicit "what you don't have to do" reduces
            hesitation at decision point. */}
        <p
          className={`text-xs ${
            isDark ? 'text-bone/60' : 'text-saddle/80'
          }`}
        >
          {riskReversal}
        </p>
      </div>
    </Link>
  );
}

// ── Mobile sticky CTA ─────────────────────────────────────────────────
// Visible only on mobile + only after the audience grid scrolls out
// of view. Keeps buyer CTA reachable (highest-$-per-click action) when
// visitor is reading farther-down sections. /access has the same
// pattern already.

export function StickyMobileCTA({ targetSelector }: { targetSelector: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (!isMobile) return;

    const target = document.querySelector(targetSelector);
    if (!target) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Show sticky CTA when audience grid leaves viewport
        const [entry] = entries;
        setVisible(!entry.isIntersecting);
      },
      { threshold: 0, rootMargin: '0px 0px -50% 0px' },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [targetSelector]);

  if (!visible) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 sm:hidden bg-bone border-t-2 border-charcoal p-3 shadow-lg">
      <Link
        href="/access"
        onClick={() =>
          trackEvent('start_button_click', { route: 'buyer-sticky' as any })
        }
        className="block w-full bg-charcoal text-bone py-3 px-4 text-center font-semibold uppercase tracking-wider text-sm"
      >
        get matched in 90 seconds →
      </Link>
    </div>
  );
}

// ── Inline FAQ ───────────────────────────────────────────────────────
// 3 top objections per Baymard research. Collapsible <details>. Native
// HTML disclosure — no JS state, accessible by default, mobile-friendly.

interface FaqItem {
  q: string;
  a: string;
}

export function InlineFAQ({ items }: { items: FaqItem[] }) {
  return (
    <section className="mt-14 max-w-2xl">
      <h2 className="text-xs uppercase tracking-wider text-saddle font-semibold mb-4">
        quick answers
      </h2>
      <div className="space-y-2">
        {items.map((item, i) => (
          <details
            key={i}
            className="group border-b border-dust py-3 cursor-pointer"
            onToggle={(e) => {
              if ((e.currentTarget as HTMLDetailsElement).open) {
                trackEvent('faq_open' as any, { question: item.q });
              }
            }}
          >
            <summary className="flex items-baseline justify-between gap-3 text-charcoal font-medium text-sm sm:text-base list-none">
              <span>{item.q}</span>
              <span
                aria-hidden="true"
                className="text-saddle group-open:rotate-45 transition-transform text-xl flex-shrink-0"
              >
                +
              </span>
            </summary>
            <p className="mt-3 text-sm text-saddle leading-relaxed">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
