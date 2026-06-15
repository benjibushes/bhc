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

// INCIDENT (2026-06-14): this component used to default to a hardcoded operator
// slug ('ben-beauchman-1itnsg/sales'). That Cal event was deleted, so the embed
// rendered a dead 404 booker. There is NO safe hardcoded fallback — a client
// component can't call the server resolver (lib/calBooking.ts reads CAL_API_KEY).
// Instead the operator slug is resolved server-side in /api/qualify and passed
// down as `operatorCalLink` ('username/slug', embed-ready). If neither a rancher
// `calLink` nor a resolved `operatorCalLink` is available, we render an
// "unavailable" message rather than embedding a guessed dead slug.
const NS = 'salescall';
const MOUNT_ID = 'bhc-cal-inline-booker';

interface Props {
  // Cal event to embed, e.g. 'some-rancher/30min'. The dual-funnel branch
  // passes the matched LEGACY rancher's own event here so funnel-1 buyers book
  // the rancher, not the operator.
  calLink?: string;
  // Operator's resolved Cal slug ('username/slug') for the tier_v2 funnel where
  // Ben runs the call. Resolved server-side via getOperatorBookingUrl() and
  // passed in. Empty/undefined when no live Cal event exists.
  operatorCalLink?: string;
  name?: string;
  email?: string;
  referralId?: string | null;
  onBooked?: () => void;
}

export default function CalInlineBooker({ calLink, operatorCalLink, name, email, referralId, onBooked }: Props) {
  // Prefer an explicit rancher calLink, else the resolved operator link. No
  // hardcoded slug fallback — a missing link means "no live event" and we
  // render a message instead of a dead embed.
  const resolvedCalLink = (calLink || operatorCalLink || '').trim();
  const initialized = useRef(false);

  useEffect(() => {
    // No live booking link → nothing to embed (the JSX renders the
    // "unavailable" message instead).
    if (!resolvedCalLink) return;
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
      calLink: resolvedCalLink,
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
  }, [resolvedCalLink, name, email, referralId, onBooked]);

  // No live booking link — show a graceful fallback instead of a dead embed.
  if (!resolvedCalLink) {
    return (
      <div className="border border-dust bg-white p-6 text-center">
        <p className="text-sm text-saddle leading-relaxed">
          Booking is temporarily unavailable. Email{' '}
          <a href="mailto:ben@buyhalfcow.com" className="underline text-charcoal">
            ben@buyhalfcow.com
          </a>{' '}
          and we&apos;ll get you scheduled right away.
        </p>
      </div>
    );
  }

  return (
    <div
      id={MOUNT_ID}
      style={{ minHeight: 600, width: '100%', overflow: 'auto' }}
      className="border border-dust bg-white"
    />
  );
}
