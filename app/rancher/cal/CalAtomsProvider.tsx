'use client';

// Thin wrapper around @calcom/atoms' <CalProvider />. Only mount on
// routes that actually USE Cal atoms (rancher dashboard, /ranchers/[slug]
// booking widget) — wrapping the whole app would ship Cal's CSS + JS
// bundle to every page including buyer signup flows that never touch Cal.
//
// `clientId` is the OAuth client ID we registered with Cal (env:
// NEXT_PUBLIC_CAL_OAUTH_CLIENT_ID). Public exposure is fine — it's an
// identifier, not a secret. The CLIENT_SECRET stays server-side only.
//
// We pass `accessToken` when the rancher has already authorized us — the
// Atoms then run authenticated calls on their behalf. When undefined,
// atoms fall back to the public-booking flow (Booker can still load a
// rancher's public event-type slug without auth).

import { CalProvider } from '@calcom/atoms';
import '@calcom/atoms/globals.min.css';

const CAL_OAUTH_CLIENT_ID =
  process.env.NEXT_PUBLIC_CAL_OAUTH_CLIENT_ID || '';

interface Props {
  children: React.ReactNode;
  // When set, atoms make authenticated calls on the rancher's behalf.
  // Server passes this in for rancher-dashboard surfaces. Buyer pages
  // leave it undefined to use Cal's public booker flow.
  accessToken?: string;
}

export default function CalAtomsProvider({ children, accessToken }: Props) {
  if (!CAL_OAUTH_CLIENT_ID) {
    // Defensive: env var missing in dev. Render children unwrapped so
    // the rest of the page still works. Atoms components inside will
    // throw their own "no clientId" errors that point you at the env.
    return <>{children}</>;
  }
  return (
    <CalProvider
      clientId={CAL_OAUTH_CLIENT_ID}
      accessToken={accessToken}
      options={{
        apiUrl: 'https://api.cal.com/v2',
        // refreshUrl is called by Atoms when the in-memory accessToken
        // expires. Our server endpoint handles the refresh + returns a
        // fresh pair. If Atoms can't reach it, the user sees a re-auth
        // CTA on the next API call.
        refreshUrl: '/api/auth/cal/refresh',
      }}
    >
      {children}
    </CalProvider>
  );
}
