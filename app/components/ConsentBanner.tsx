'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CONSENT_GRANTED_EVENT,
  hasGlobalPrivacyControl,
  persistConsent,
  readConsent,
} from '@/lib/consent';

/**
 * First-visit tracking-consent banner (F3 — CCPA/GPC posture).
 *
 * Small fixed-bottom bar with two choices: "OK" (accept) or "Opt out"
 * (decline non-essential tracking). The choice persists to localStorage +
 * a 1-year cookie via lib/consent and the banner never re-shows after a
 * choice is made. PixelTracker loads NO third-party scripts until 'granted'.
 *
 * Global Privacy Control browsers are treated as opted out SILENTLY — the
 * banner never renders and the denial is persisted (required handling in
 * CO/CT; GPC also overrides any previously stored grant).
 */
export default function ConsentBanner() {
  const [visible, setVisible] = useState(false);
  const bannerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (hasGlobalPrivacyControl()) {
      persistConsent('denied');
      return;
    }
    if (readConsent() === null) setVisible(true);
  }, []);

  // Layout coordination — while the banner is on screen, publish its measured
  // height (incl. safe-area padding) as --consent-h on <html> so other
  // bottom-anchored UI (StickyMobileCTA, the deposit page's sticky pay block)
  // can offset above it instead of being covered on mobile. The var is
  // removed the moment a choice is made (banner unmounts) or on unmount, so
  // everything snaps back to bottom: 0. Pure layout — no consent behavior.
  useEffect(() => {
    if (!visible) return;
    const el = bannerRef.current;
    if (!el) return;
    const root = document.documentElement;
    const update = () =>
      root.style.setProperty('--consent-h', `${el.offsetHeight}px`);
    update();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update);
      ro.observe(el);
    }
    return () => {
      ro?.disconnect();
      root.style.removeProperty('--consent-h');
    };
  }, [visible]);

  if (!visible) return null;

  const choose = (value: 'granted' | 'denied') => {
    persistConsent(value);
    setVisible(false);
    if (value === 'granted') {
      // Wake PixelTracker immediately — tracking starts without a reload.
      window.dispatchEvent(new Event(CONSENT_GRANTED_EVENT));
    }
  };

  return (
    <div
      ref={bannerRef}
      role="region"
      aria-label="Cookie consent"
      // z-[45]: above StickyMobileCTA (z-40) so the CTA's slide-down hidden
      // state tucks behind the banner, but BELOW modals/header (z-50) so a
      // dialog is never partially covered by the consent bar. Safe-area
      // padding keeps the OK/Opt-out buttons clear of the iOS home indicator;
      // offsetHeight above measures it automatically.
      className="fixed inset-x-0 bottom-0 z-[45] border-t border-divider/20 bg-charcoal text-bone"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-relaxed text-bone/90">
          We use cookies to measure our ads and improve the site.{' '}
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-bone"
          >
            Privacy Policy
          </a>
        </p>
        <div className="flex flex-shrink-0 items-center gap-4">
          <button
            type="button"
            onClick={() => choose('denied')}
            className="text-xs text-bone/70 underline underline-offset-2 transition-colors hover:text-bone"
          >
            Opt out
          </button>
          <button
            type="button"
            onClick={() => choose('granted')}
            className="bg-bone px-5 py-2 text-xs font-medium uppercase tracking-wide text-charcoal transition-colors hover:bg-dust"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
