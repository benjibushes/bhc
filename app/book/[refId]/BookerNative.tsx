'use client';

// BookerNative.tsx
//
// Wraps @calcom/atoms <Booker> (BookerPlatformWrapper) for native on-site
// booking on /book/[refId]. Renders Cal's booking UI directly without an
// iframe so the buyer never leaves buyhalfcow.com.
//
// RESEARCH NOTES (2026-06-19):
//   - @calcom/atoms Booker hits /atoms/event-types/{slug}/public?username=...
//     on the Cal Platform API (api.cal.com/v2) with an x-cal-client-id header
//     set by CalProvider. The docs list username + eventSlug as the ONLY
//     required props with no managed-user restriction (docs example uses plain
//     username="johndoe"). The /public suffix suggests no accessToken needed
//     for read-only availability + booking of a public event.
//   - Because the Cal platform plan is noted as maintenance-only and we can't
//     test locally without the NEXT_PUBLIC_CAL_OAUTH_CLIENT_ID env var, this
//     component is gated behind CAL_NATIVE_BOOKER=true (server-resolved, passed
//     as prop). Default is OFF so the iframe remains active in prod until the
//     owner confirms atoms work for ben-beauchman-1itnsg's public events.
//   - metadata.referralId round-trips: Booker passes `metadata` to Cal's
//     booking payload → webhook payload includes it → /api/webhooks/cal matches.
//
// FALLBACK: if CalAtomsProvider or Booker throw (e.g. Cal API error, missing
// clientId env), the ErrorBoundary in page.tsx catches and renders
// CalInlineBooker. Booking is ALWAYS available.

import { Component, type ReactNode, type ErrorInfo } from 'react';
import { Booker } from '@calcom/atoms';
import CalAtomsProvider from '@/app/rancher/cal/CalAtomsProvider';

// ---------- Error boundary ------------------------------------------------
// Catches any throw inside the atoms subtree (network error, missing env,
// Cal API returning 4xx during component hydration). Parent page reads the
// `nativeError` state via a callback to switch to the iframe fallback.

interface ErrorBoundaryProps {
  children: ReactNode;
  onError?: (err: Error) => void;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class BookerErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('[BookerNative] atoms error — iframe fallback active:', error.message, info.componentStack?.slice(0, 200));
    this.props.onError?.(error);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}

// ---------- Props ----------------------------------------------------------

interface BookerNativeProps {
  // Buyer identity for prefill
  buyerFirstName: string;
  buyerLastName: string;
  buyerEmail: string;
  // Referral ID — round-trips through Cal metadata to the /api/webhooks/cal
  // handler which uses it to tie the booking back to the Airtable Referral row.
  referralId: string;
  // Operator Cal credentials (resolved server-side with env fallbacks)
  calUsername: string;
  eventSlug: string;
  // Called when the native Booker fails so the parent can switch to iframe
  onError?: (err: Error) => void;
  // Called on successful booking
  onSuccess?: (data: unknown) => void;
}

// ---------- Inner Booker component ----------------------------------------
// Separated so the error boundary wraps it cleanly.

function BookerInner({
  buyerFirstName,
  buyerLastName,
  buyerEmail,
  referralId,
  calUsername,
  eventSlug,
  onSuccess,
}: Omit<BookerNativeProps, 'onError'>) {
  return (
    // CalAtomsProvider with NO accessToken → atoms use public booking flow.
    // refreshUrl is still wired (CalAtomsProvider always sets it) — for a
    // public booking the SDK won't call it, but it's harmless.
    <CalAtomsProvider>
      <div className="w-full cal-atoms-wrapper">
        <Booker
          username={calUsername}
          eventSlug={eventSlug}
          defaultFormValues={{
            firstName: buyerFirstName,
            lastName: buyerLastName,
            email: buyerEmail,
          }}
          // metadata reaches the Cal booking record → webhook payload includes
          // it as booking.metadata.referralId so /api/webhooks/cal can match.
          metadata={{ referralId }}
          onCreateBookingSuccess={(data) => {
            console.log('[BookerNative] booking created:', data?.data?.uid);
            onSuccess?.(data);
          }}
          onCreateBookingError={(err) => {
            // Surface as a console warn — non-fatal, buyer can retry. The
            // error boundary only fires on render errors, not API errors.
            console.warn('[BookerNative] booking creation error:', err);
          }}
          // Keep month-view to match the iframe layout. COLUMN_VIEW is
          // available too but month_view is what Cal's inline embed uses.
          view="MONTH_VIEW"
          // Hide Cal branding so the widget feels native to buyhalfcow.com.
          hideBranding
          // Custom class hook for on-brand saddle/charcoal token overrides
          // (CSS injected via globals — see styles below).
          customClassNames={{ atomsWrapper: 'bhc-booker-atoms' }}
        />
      </div>
    </CalAtomsProvider>
  );
}

// ---------- Exported component (error-boundary-wrapped) -------------------

export default function BookerNative({
  buyerFirstName,
  buyerLastName,
  buyerEmail,
  referralId,
  calUsername,
  eventSlug,
  onError,
  onSuccess,
}: BookerNativeProps) {
  return (
    <BookerErrorBoundary
      onError={onError}
      fallback={null} // page.tsx renders the iframe fallback on null-from-error
    >
      <BookerInner
        buyerFirstName={buyerFirstName}
        buyerLastName={buyerLastName}
        buyerEmail={buyerEmail}
        referralId={referralId}
        calUsername={calUsername}
        eventSlug={eventSlug}
        onSuccess={onSuccess}
      />
    </BookerErrorBoundary>
  );
}
