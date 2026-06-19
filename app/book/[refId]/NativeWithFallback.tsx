'use client';

// NativeWithFallback.tsx
//
// Client component that renders <BookerNative> (atoms) and automatically
// switches to <CalInlineBooker> (iframe) if atoms throw or fail.
//
// The switch is one-way and permanent for the session:
//   1. BookerNative mounts → BookerErrorBoundary is armed.
//   2. If atoms throw during render/hydration, the boundary calls onError.
//   3. onError sets useFallback=true → we unmount atoms and mount the iframe.
//   4. Booking ALWAYS works — the iframe is the battle-tested path.

import { useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import CalInlineBooker from '@/app/qualify/[consumerId]/CalInlineBooker';

// Lazy-load BookerNative: atoms pull @tanstack/react-query, cal CSS, and heavy
// deps. Dynamic import keeps them out of the initial JS bundle for /book pages
// unless the feature flag is on. Loading state is a skeleton that matches the
// iframe placeholder height so there's no layout shift.
const BookerNative = dynamic(() => import('./BookerNative'), {
  ssr: false,
  loading: () => (
    <div
      className="border border-dust bg-white animate-pulse"
      style={{ minHeight: 600, width: '100%' }}
    />
  ),
});

interface Props {
  // Native booker props
  buyerFirstName: string;
  buyerLastName: string;
  buyerEmail: string;
  referralId: string;
  calUsername: string;
  eventSlug: string;
  // Iframe fallback props
  // calLink: rancher's embed-ready slug (e.g. 'username/event') — when present,
  // the iframe books the rancher rather than the operator. Mirrors the
  // CalInlineBooker priority: calLink > operatorCalLink.
  calLink?: string;
  operatorCalLink?: string;
  name?: string;
  email?: string;
}

export default function NativeWithFallback({
  buyerFirstName,
  buyerLastName,
  buyerEmail,
  referralId,
  calUsername,
  eventSlug,
  calLink,
  operatorCalLink,
  name,
  email,
}: Props) {
  const [useFallback, setUseFallback] = useState(false);

  const handleNativeError = useCallback((err: Error) => {
    console.warn('[NativeWithFallback] atoms failed, switching to iframe:', err.message);
    setUseFallback(true);
  }, []);

  if (useFallback) {
    // Atoms failed → render the battle-tested iframe. referralId is passed
    // so the webhook still ties the booking back to the Airtable Referral row.
    // calLink (rancher slug) takes priority when present — same priority as
    // the non-fallback CalInlineBooker path.
    return (
      <CalInlineBooker
        calLink={calLink}
        operatorCalLink={operatorCalLink}
        name={name}
        email={email}
        referralId={referralId}
      />
    );
  }

  return (
    <BookerNative
      buyerFirstName={buyerFirstName}
      buyerLastName={buyerLastName}
      buyerEmail={buyerEmail}
      referralId={referralId}
      calUsername={calUsername}
      eventSlug={eventSlug}
      onError={handleNativeError}
    />
  );
}
