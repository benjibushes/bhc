'use client';

// CallbackRequest — the one human affordance, defined once and reused.
//
// Renders on exactly two surfaces (see lib/callbackRail.ts for the rule):
//   • the deposit checkout page, under the pay button; and
//   • the member dashboard of a buyer with a live, paid deal.
// Never on a cold or browse surface. If you are about to mount this somewhere
// else, read the header of lib/callbackRail.ts first.
//
// DARK BY DEFAULT. Everything below is driven by GET /api/callback-request,
// which 404s while CALLBACK_RAIL_ENABLED is off — so this component renders
// NOTHING until Ben flips the flag, and no buyer can see it before he has
// walked the funnel himself.
//
// The call/text links and the "have Ben call me" request are INDEPENDENT. The
// links appear only when CALLBACK_PHONE is configured; the request form needs
// no number at all and works on its own. With the flag on and no number set,
// this component is just the request form — which is a deliberate, supported
// state, not a degraded one. There is no placeholder number and no
// "coming soon" copy anywhere in this file.
//
// Quiet by construction: plain text and underlined links, never a second
// button competing with the pay CTA. Mobile-first — the whole thing is two
// lines until tapped.

import { useCallback, useEffect, useState } from 'react';

interface CallbackConfig {
  enabled: boolean;
  phone: { display: string; tel: string; sms: string } | null;
  alreadyOpen: boolean;
  hasPhoneOnFile: boolean;
}

export type CallbackVariant = 'checkout' | 'member' | 'member-stalled';

const LEAD_IN: Record<CallbackVariant, string> = {
  checkout: 'Questions before you reserve?',
  member: 'Questions about your order?',
  'member-stalled': "Hasn't moved in a while?",
};

const ASK_LABEL: Record<CallbackVariant, string> = {
  checkout: 'or have ben call me',
  member: 'or have ben call me',
  'member-stalled': 'or have ben chase this for me',
};

const PLACEHOLDER: Record<CallbackVariant, string> = {
  checkout: "what's holding you up? (optional)",
  member: 'what can we help with? (optional)',
  'member-stalled': "what's outstanding? (optional)",
};

export default function CallbackRequest({
  refId,
  variant = 'checkout',
  className = '',
}: {
  /** Referral in context. Lets a campaign 1-tap buyer authorize on the deposit grant. */
  refId?: string;
  variant?: CallbackVariant;
  className?: string;
}) {
  const [config, setConfig] = useState<CallbackConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    const qs = refId ? `?refId=${encodeURIComponent(refId)}` : '';
    fetch(`/api/callback-request${qs}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!live) return;
        // 404 (rail dark) and 401 (no credential) both land here as null —
        // one "render nothing" branch, no error state shown to a buyer.
        if (j?.enabled) setConfig(j as CallbackConfig);
      })
      .catch(() => {
        /* silent — a config failure must never break a checkout page */
      });
    return () => {
      live = false;
    };
  }, [refId]);

  const submit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/callback-request', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(refId ? { refId } : {}),
          note,
          ...(phone.trim() ? { phone: phone.trim() } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        setDone(String(j.message || "got it — ben will call you."));
        setOpen(false);
      } else {
        setError(String(j?.message || "that didn't send — try once more?"));
      }
    } catch {
      setError("that didn't send — check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }, [note, phone, refId, submitting]);

  // Rail dark, no credential, or config never arrived → nothing at all.
  if (!config?.enabled) return null;

  if (done) {
    return (
      <p className={`text-center text-sm text-sage-dark ${className}`} role="status">
        ✓ {done}
      </p>
    );
  }

  // They already have an open request — say so instead of offering to stack a
  // second one. Same truth the endpoint tells us.
  if (config.alreadyOpen && !open) {
    return (
      <p className={`text-center text-sm text-saddle ${className}`}>
        ✓ we&apos;ve got you — ben will call.
      </p>
    );
  }

  const needsPhone = !config.hasPhoneOnFile;

  return (
    <div className={`text-center ${className}`}>
      {/* Call/text links — ONLY when a line is configured. No placeholder. */}
      {config.phone && (
        <p className="text-saddle text-sm leading-relaxed">
          {LEAD_IN[variant]}{' '}
          <a href={config.phone.tel} className="underline hover:text-charcoal whitespace-nowrap">
            call
          </a>{' '}
          or{' '}
          <a href={config.phone.sms} className="underline hover:text-charcoal whitespace-nowrap">
            text
          </a>{' '}
          ben at{' '}
          <a href={config.phone.tel} className="underline hover:text-charcoal whitespace-nowrap">
            {config.phone.display}
          </a>
        </p>
      )}

      {!open && (
        <p className={config.phone ? 'mt-1' : ''}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-saddle text-sm underline hover:text-charcoal"
          >
            {/* With no number configured this is the ONLY affordance, so it
                carries the lead-in itself rather than reading as an aside. */}
            {config.phone ? ASK_LABEL[variant] : `${LEAD_IN[variant]} have ben call you`}
          </button>
        </p>
      )}

      {open && (
        <div className="mt-2 text-left border border-dust bg-white p-3">
          <label htmlFor="callback-note" className="sr-only">
            What should Ben know before he calls?
          </label>
          <textarea
            id="callback-note"
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 500))}
            rows={2}
            placeholder={PLACEHOLDER[variant]}
            className="w-full border border-dust p-2 text-sm text-charcoal bg-bone focus:outline-none focus:border-saddle"
          />

          {/* Only asked for when we have no way to reach them — a callback
              request with no number is a dead letter. */}
          {needsPhone && (
            <>
              <label htmlFor="callback-phone" className="sr-only">
                Your phone number
              </label>
              <input
                id="callback-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="your number, so ben can reach you"
                className="mt-2 w-full border border-dust p-2 text-sm text-charcoal bg-bone focus:outline-none focus:border-saddle"
              />
            </>
          )}

          {error && <p className="text-red-700 text-sm mt-2">{error}</p>}

          <div className="flex items-center gap-3 mt-2">
            <button
              type="button"
              onClick={submit}
              disabled={submitting || (needsPhone && !phone.trim())}
              className="px-4 py-2 min-h-[44px] bg-charcoal text-bone text-xs uppercase tracking-widest hover:bg-saddle transition disabled:opacity-50"
            >
              {submitting ? 'sending…' : 'ask ben to call'}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setError('');
              }}
              className="text-saddle text-sm underline hover:text-charcoal"
            >
              never mind
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
