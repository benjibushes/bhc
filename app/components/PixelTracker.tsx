'use client';

import { useEffect, useState } from 'react';
import Script from 'next/script';
import {
  CONSENT_GRANTED_EVENT,
  hasGlobalPrivacyControl,
  readConsent,
} from '@/lib/consent';

/**
 * Mounts Meta Pixel + GA4 + Google Ads conversion tags. Conditional on
 * env vars — if a pixel ID isn't set, that script doesn't render. Lets
 * staging / preview environments skip tracking without code changes.
 *
 * Env vars (all NEXT_PUBLIC_ for client exposure):
 * - NEXT_PUBLIC_META_PIXEL_ID   (e.g. "1234567890")
 * - NEXT_PUBLIC_GA4_ID          (e.g. "G-XXXXXXXXXX")
 * - NEXT_PUBLIC_GOOGLE_ADS_ID   (e.g. "AW-1234567890")
 *
 * Consent gate (F3 — CCPA/GPC): NO third-party script loads until the
 * visitor's consent is 'granted' — either stored from a prior visit
 * (localStorage/cookie via lib/consent) or granted live via ConsentBanner's
 * OK button, which fires CONSENT_GRANTED_EVENT so tracking starts on the
 * spot without a reload. Global Privacy Control browsers are denied
 * silently and never load anything. When denied/unset this renders null;
 * lib/track's window.fbq / window.gtag guards make every track() call a
 * safe no-op in that state. Server-side CAPI is a separate rail and is
 * unaffected by this gate.
 */
export default function PixelTracker() {
  const metaPixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  const ga4Id = process.env.NEXT_PUBLIC_GA4_ID;
  const googleAdsId = process.env.NEXT_PUBLIC_GOOGLE_ADS_ID;

  // false on the server and on first client render — the initial HTML never
  // contains tracking scripts, so denied/unset visitors load nothing at all.
  const [consented, setConsented] = useState(false);

  useEffect(() => {
    // GPC is a binding opt-out: it wins even over a previously stored grant.
    if (hasGlobalPrivacyControl()) return;
    if (readConsent() === 'granted') {
      setConsented(true);
      return;
    }
    // No stored grant yet — start the moment ConsentBanner's OK fires.
    const onGranted = () => setConsented(true);
    window.addEventListener(CONSENT_GRANTED_EVENT, onGranted);
    return () => window.removeEventListener(CONSENT_GRANTED_EVENT, onGranted);
  }, []);

  if (!consented) return null;

  return (
    <>
      {metaPixelId && (
        <Script
          id="meta-pixel"
          strategy="afterInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              !function(f,b,e,v,n,t,s)
              {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
              n.callMethod.apply(n,arguments):n.queue.push(arguments)};
              if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
              n.queue=[];t=b.createElement(e);t.async=!0;
              t.src=v;s=b.getElementsByTagName(e)[0];
              s.parentNode.insertBefore(t,s)}(window, document,'script',
              'https://connect.facebook.net/en_US/fbevents.js');
              fbq('init', '${metaPixelId}');
              fbq('track', 'PageView');
            `,
          }}
        />
      )}
      {(ga4Id || googleAdsId) && (
        <>
          <Script
            id="gtag-loader"
            strategy="afterInteractive"
            src={`https://www.googletagmanager.com/gtag/js?id=${ga4Id || googleAdsId}`}
          />
          <Script
            id="gtag-init"
            strategy="afterInteractive"
            dangerouslySetInnerHTML={{
              __html: `
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('js', new Date());
                ${ga4Id ? `gtag('config', '${ga4Id}');` : ''}
                ${googleAdsId ? `gtag('config', '${googleAdsId}');` : ''}
              `,
            }}
          />
        </>
      )}
    </>
  );
}
