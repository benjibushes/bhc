'use client';

// Inline Cal.com booker for the operator (Ben) sales call. Renders the
// cal.com Booker in an iframe directly on the page so a qualified buyer picks
// a time WITHOUT ever leaving the site.
//
// Uses the vanilla Cal embed (their official loader snippet, inlined) rather
// than @calcom/atoms — the atoms flavor needs the Cal OAuth client wired, and
// for a plain public-event booking the lightweight embed is more robust and
// has zero auth dependency.
//
// The Cal webhook (app/api/webhooks/cal, buyer-sales-call branch) matches the
// booking back to the buyer's referral by the attendee email + stamps Sales
// Call Booked At and fires the pre-call brief to the operator. Prefilling the
// buyer's name + email makes that link bulletproof; metadata[referralId] is
// passed too as a belt-and-suspenders tie-back.

import { useEffect, useRef } from 'react';

// Operator sales-call event. Override via env without a redeploy if the slug
// ever changes. Matches lib/emailMinimal.ts BHC_OPERATOR_CAL_URL default.
const CAL_LINK =
  process.env.NEXT_PUBLIC_BHC_OPERATOR_CAL_LINK || 'ben-beauchman-1itnsg/sales';
const NS = 'salescall';
const MOUNT_ID = 'bhc-cal-inline-booker';

interface Props {
  name?: string;
  email?: string;
  referralId?: string | null;
  onBooked?: () => void;
}

export default function CalInlineBooker({ name, email, referralId, onBooked }: Props) {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    // Official Cal embed loader, inlined (loads https://app.cal.com/embed/embed.js once).
    (function (C: any, A: string, L: string) {
      const p = function (a: any, ar: any) { a.q.push(ar); };
      const d = C.document;
      C.Cal = C.Cal || function () {
        const cal = C.Cal;
        // eslint-disable-next-line prefer-rest-params
        const ar = arguments as any;
        if (!cal.loaded) {
          cal.ns = {};
          cal.q = cal.q || [];
          d.head.appendChild(d.createElement('script')).src = A;
          cal.loaded = true;
        }
        if (ar[0] === L) {
          const api: any = function () { p(api, arguments); };
          const namespace = ar[1];
          api.q = api.q || [];
          if (typeof namespace === 'string') {
            cal.ns[namespace] = cal.ns[namespace] || api;
            p(cal.ns[namespace], ar);
            p(cal, ['initNamespace', namespace]);
          } else {
            p(cal, ar);
          }
          return;
        }
        p(cal, ar);
      };
    })(window, 'https://app.cal.com/embed/embed.js', 'init');

    const Cal = (window as any).Cal;
    if (!Cal) return;

    Cal('init', NS, { origin: 'https://cal.com' });

    const config: Record<string, string> = { layout: 'month_view', theme: 'light' };
    if (name) config.name = name;
    if (email) config.email = email;
    if (referralId) config['metadata[referralId]'] = referralId;

    Cal.ns[NS]('inline', {
      elementOrSelector: `#${MOUNT_ID}`,
      calLink: CAL_LINK,
      layout: 'month_view',
      config,
    });

    Cal.ns[NS]('ui', {
      hideEventTypeDetails: false,
      layout: 'month_view',
      cssVarsPerTheme: { light: { 'cal-brand': '#0E0E0E' } },
    });

    if (onBooked) {
      Cal.ns[NS]('on', {
        action: 'bookingSuccessful',
        callback: () => onBooked(),
      });
    }
  }, [name, email, referralId, onBooked]);

  return (
    <div
      id={MOUNT_ID}
      style={{ minHeight: 600, width: '100%', overflow: 'auto' }}
      className="border border-dust bg-white"
    />
  );
}
