'use client';

import Script from 'next/script';

/**
 * Mounts Meta Pixel + GA4 + Google Ads conversion tags. Conditional on
 * env vars — if a pixel ID isn't set, that script doesn't render. Lets
 * staging / preview environments skip tracking without code changes.
 *
 * Env vars (all NEXT_PUBLIC_ for client exposure):
 * - NEXT_PUBLIC_META_PIXEL_ID   (e.g. "1234567890")
 * - NEXT_PUBLIC_GA4_ID          (e.g. "G-XXXXXXXXXX")
 * - NEXT_PUBLIC_GOOGLE_ADS_ID   (e.g. "AW-1234567890")
 */
export default function PixelTracker() {
  const metaPixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  const ga4Id = process.env.NEXT_PUBLIC_GA4_ID;
  const googleAdsId = process.env.NEXT_PUBLIC_GOOGLE_ADS_ID;

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
