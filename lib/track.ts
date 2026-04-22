// Client-side event tracking helper. Fires both GA4 and Meta Pixel if
// configured. Safe no-op if analytics aren't loaded yet or env vars unset.
// Call from any client component on a conversion event:
//   track('Lead', { orderType: 'Half', ranchSlug: 'ashcraftbeef', value: 2100 });
// Standard Meta events: Lead, ViewContent, AddToCart, InitiateCheckout, Purchase.
// GA4 mirrors as a matching event name; treat Meta names as source of truth.

type AnalyticsParams = Record<string, string | number | boolean | undefined | null>;

declare global {
  interface Window {
    gtag?: (...args: any[]) => void;
    fbq?: (...args: any[]) => void;
  }
}

export function track(eventName: string, params: AnalyticsParams = {}) {
  if (typeof window === 'undefined') return;

  try {
    if (typeof window.gtag === 'function') {
      window.gtag('event', eventName, params);
    }
  } catch (e) {
    console.warn('GA4 track error:', e);
  }

  try {
    if (typeof window.fbq === 'function') {
      // Meta's standard events list a specific subset. Unknown names fall
      // through as trackCustom.
      const standard = new Set([
        'PageView', 'ViewContent', 'Search', 'AddToCart', 'AddToWishlist',
        'InitiateCheckout', 'AddPaymentInfo', 'Purchase', 'Lead', 'CompleteRegistration',
        'Contact', 'CustomizeProduct', 'Donate', 'FindLocation', 'Schedule',
        'StartTrial', 'SubmitApplication', 'Subscribe',
      ]);
      if (standard.has(eventName)) {
        window.fbq('track', eventName, params);
      } else {
        window.fbq('trackCustom', eventName, params);
      }
    }
  } catch (e) {
    console.warn('Meta Pixel track error:', e);
  }
}
