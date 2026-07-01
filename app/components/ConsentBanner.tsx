'use client';

import { useEffect, useState } from 'react';
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

  useEffect(() => {
    if (hasGlobalPrivacyControl()) {
      persistConsent('denied');
      return;
    }
    if (readConsent() === null) setVisible(true);
  }, []);

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
      role="region"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-0 z-[70] border-t border-divider/20 bg-charcoal text-bone"
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
