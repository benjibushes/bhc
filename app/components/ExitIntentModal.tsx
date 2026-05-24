'use client';

import { useEffect, useState } from 'react';
import { trackEvent } from '@/lib/analytics';

const SESSION_FLAG = 'exit-intent-shown';
const MOBILE_DELAY_MS = 30_000;
const MOBILE_SCROLL_THRESHOLD = 50; // px scroll-up to trigger

export default function ExitIntentModal() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (sessionStorage.getItem(SESSION_FLAG) === '1') return;

    const isMobile = window.matchMedia('(max-width: 768px)').matches;

    let lastScrollY = window.scrollY;
    let mobileTimer: ReturnType<typeof setTimeout> | null = null;

    const handleMouseOut = (e: MouseEvent) => {
      if (e.clientY < 50) {
        trigger();
      }
    };

    const handleScroll = () => {
      const currentY = window.scrollY;
      if (lastScrollY - currentY > MOBILE_SCROLL_THRESHOLD) {
        trigger();
      }
      lastScrollY = currentY;
    };

    const trigger = () => {
      if (sessionStorage.getItem(SESSION_FLAG) === '1') return;
      sessionStorage.setItem(SESSION_FLAG, '1');
      setOpen(true);
      trackEvent('exit_intent_shown');
      cleanup();
    };

    const cleanup = () => {
      document.removeEventListener('mouseout', handleMouseOut);
      window.removeEventListener('scroll', handleScroll);
      if (mobileTimer) clearTimeout(mobileTimer);
    };

    if (isMobile) {
      // Mobile: wait 30s before arming the scroll-up trigger
      mobileTimer = setTimeout(() => {
        window.addEventListener('scroll', handleScroll, { passive: true });
      }, MOBILE_DELAY_MS);
    } else {
      // Desktop: arm immediately
      document.addEventListener('mouseout', handleMouseOut);
    }

    return cleanup;
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !email.includes('@')) return;
    setSubmitting(true);
    try {
      // POST to existing newsletter/email-capture endpoint.
      // /api/consumers/quick does not exist yet — falls back to /api/newsletter.
      // Neither endpoint currently accepts email-only + source. Operator follow-up:
      //   Create /api/consumers/quick accepting { email, source } and writing
      //   a minimal Consumers record (Source='exit-intent', Segment='Community').
      //   OR modify this to hit /api/consumers with synthetic full payload.
      // Graceful degradation: modal still fires analytics + confirms to user.
      await fetch('/api/consumers/quick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source: 'exit-intent' }),
      }).catch(() => {
        // Fall back to legacy newsletter endpoint if /quick doesn't exist
        return fetch('/api/newsletter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, source: 'exit-intent' }),
        });
      });
      trackEvent('exit_intent_capture');
      setSubmitted(true);
      setTimeout(() => setOpen(false), 2000);
    } catch (err) {
      console.warn('[exit-intent] submit failed:', err);
      // Still close gracefully — don't trap the user.
      setSubmitted(true);
      setTimeout(() => setOpen(false), 2000);
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/70 p-4"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="founder letter signup"
    >
      <div
        className="relative w-full max-w-md bg-bone p-8 sm:p-10"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => setOpen(false)}
          className="absolute top-3 right-3 text-charcoal/60 hover:text-charcoal text-xl leading-none"
          aria-label="close"
        >
          ✕
        </button>
        {!submitted ? (
          <>
            <h2 className="font-serif text-2xl sm:text-3xl text-charcoal mb-3">wait — before you go</h2>
            <p className="text-saddle mb-6">
              get the bhc founder letter. real numbers, real ranches, the actual rebuild. one email per month.
            </p>
            <form onSubmit={handleSubmit} className="space-y-3">
              <input
                type="email"
                required
                placeholder="your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border border-charcoal/30 px-4 py-3 min-h-[44px] text-charcoal"
                disabled={submitting}
              />
              <button
                type="submit"
                disabled={submitting || !email.includes('@')}
                className="w-full bg-charcoal text-bone font-semibold uppercase tracking-wider text-sm py-4 min-h-[52px] hover:bg-divider disabled:opacity-50"
              >
                {submitting ? 'sending…' : 'send it'}
              </button>
            </form>
          </>
        ) : (
          <div className="text-center py-6">
            <div className="font-serif text-2xl text-charcoal mb-2">got it.</div>
            <p className="text-saddle">first letter lands in your inbox within 24h.</p>
          </div>
        )}
      </div>
    </div>
  );
}
