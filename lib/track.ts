// Client-side event tracking helper. Fires both GA4 and Meta Pixel if
// configured. Safe no-op if analytics aren't loaded yet or env vars unset.
// Call from any client component on a conversion event:
//   track('Lead', { orderType: 'Half', ranchSlug: 'ashcraftbeef', value: 2100, event_id: 'recXYZ' });
// Standard Meta events: Lead, ViewContent, AddToCart, InitiateCheckout, Purchase.
// GA4 mirrors as a matching event name; treat Meta names as source of truth.
//
// E-1 audit fix: `event_id` in params is extracted and passed as the
// 4th-arg `{ eventID }` options object — that's what Meta Pixel expects
// for CAPI client+server dedup. Passing event_id inside params (instead
// of as the 4th arg) caused 100% dedup failure platform-wide.

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
      // Strip event_id from params — Meta Pixel expects it as the 4th-arg
      // options object, not inside the params payload. Without this,
      // (event_name, event_id) won't match server-side CAPI fires and
      // every event double-counts.
      const { event_id, ...restParams } = params;
      const eventIdString = typeof event_id === 'string' || typeof event_id === 'number'
        ? String(event_id)
        : undefined;
      if (standard.has(eventName)) {
        if (eventIdString) {
          window.fbq('track', eventName, restParams, { eventID: eventIdString });
        } else {
          window.fbq('track', eventName, restParams);
        }
      } else {
        if (eventIdString) {
          window.fbq('trackCustom', eventName, restParams, { eventID: eventIdString });
        } else {
          window.fbq('trackCustom', eventName, restParams);
        }
      }
    }
  } catch (e) {
    console.warn('Meta Pixel track error:', e);
  }
}
