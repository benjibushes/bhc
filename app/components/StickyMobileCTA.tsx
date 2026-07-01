'use client';

// Sticky mobile bottom CTA — fixed bar at the bottom of the viewport on
// mobile screens only. Auto-hides on scroll-up after first scroll-down so it
// doesn't cover content the user is reading. Companion to a 14px spacer the
// caller renders to prevent footer overlap.
//
// Pattern lifted from /founders mobile sticky CTA but extracted as a
// reusable primitive — drop on /map, /access, /wins, /brand-partners.

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface StickyMobileCTAProps {
  href: string;
  label: string;
  subLabel?: string;
}

export default function StickyMobileCTA({ href, label, subLabel }: StickyMobileCTAProps) {
  const [visible, setVisible] = useState(true);
  const [lastY, setLastY] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      // Hide on scroll-down past 200px, re-show on scroll-up.
      if (y < 200) setVisible(true);
      else if (y > lastY) setVisible(false);
      else setVisible(true);
      setLastY(y);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [lastY]);

  return (
    <>
      <div
        // bottom offsets by --consent-h (set on <html> by ConsentBanner while
        // it's visible) so the CTA rides ABOVE the consent bar instead of
        // being covered by it on a first ad-click visit. Falls back to 0 when
        // the banner is gone. The hidden slide-down state tucks behind the
        // banner (banner z-45 > this z-40), so no sliver shows.
        className={`md:hidden fixed inset-x-0 bg-charcoal text-bone z-40 border-t border-saddle transition-base ${
          visible ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ bottom: 'var(--consent-h, 0px)' }}
      >
        <Link href={href} className="block text-center py-4 px-4">
          <span className="text-sm font-bold tracking-widest uppercase">{label}</span>
          {subLabel && (
            <span className="block text-[11px] text-bone/70 mt-0.5">{subLabel}</span>
          )}
        </Link>
      </div>
      {/* Spacer so the bar doesn't cover footer content on mobile */}
      <div className="md:hidden h-16" aria-hidden="true" />
    </>
  );
}
