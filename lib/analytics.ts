/**
 * Analytics event wrapper. Fires events to Meta Pixel + Google Analytics
 * + Vercel Analytics in one call. Safe to call from server components
 * (no-op) or client components (full fire).
 *
 * Standard event names — pick from this list to keep funnel reports clean:
 * - 'access_view'              — /access page view
 * - 'access_quiz_submit'       — quiz form submitted
 * - 'quiz_started'             — /access quiz mounted (per-field drop-off baseline)
 * - 'quiz_step_completed'      — individual quiz field completed (step prop: email/state/timing/householdSize)
 * - 'founders_view'            — /founders page view
 * - 'founders_tier_click'      — backer clicked a tier
 * - 'founders_checkout_start'  — Stripe checkout opened
 * - 'founders_backed'          — Stripe success webhook fired
 * - 'brand_partners_view'      — /brand-partners view
 * - 'brand_partners_tier_click'— brand clicked a tier
 * - 'brand_partners_purchased' — brand completed purchase
 * - 'start_view'               — /start router view
 * - 'start_button_click'       — user clicked a router button
 * - 'shop_click'               — outbound to /shop or Shopify
 * - 'exit_intent_shown'        — exit modal displayed
 * - 'exit_intent_capture'      — email submitted to exit modal
 * - 'deposit_initiated'        — buyer landed on /checkout/[refId]/deposit (InitiateCheckout)
 * - 'deposit_completed'        — buyer landed on /checkout/[refId]/success (Purchase) — dedupe with server CAPI via event_id
 */

declare global {
  interface Window {
    fbq?: (...args: any[]) => void;
    gtag?: (...args: any[]) => void;
    dataLayer?: any[];
  }
}

export type AnalyticsEventName =
  | 'access_view'
  | 'access_quiz_submit'
  | 'quiz_started'
  | 'quiz_step_completed'
  | 'founders_view'
  | 'founders_tier_click'
  | 'founders_checkout_start'
  | 'founders_backed'
  | 'brand_partners_view'
  | 'brand_partners_tier_click'
  | 'brand_partners_purchased'
  | 'start_view'
  | 'start_button_click'
  | 'shop_click'
  | 'exit_intent_shown'
  | 'exit_intent_capture'
  | 'affiliate_signup_click'
  | 'affiliate_signup_success'
  | 'affiliate_link_copied'
  | 'affiliate_link_shared'
  | 'wholesale_view'
  | 'wholesale_submit_success'
  | 'deposit_initiated'
  | 'deposit_completed';

export function trackEvent(
  event: AnalyticsEventName,
  properties: Record<string, string | number | boolean> = {},
): void {
  if (typeof window === 'undefined') return;

  try {
    // Meta Pixel — use CustomEvent for non-standard events, fbq.track for standards.
    if (window.fbq) {
      const metaStandardEvents: Record<string, string> = {
        access_quiz_submit: 'Lead',
        founders_backed: 'Purchase',
        founders_checkout_start: 'InitiateCheckout',
        brand_partners_purchased: 'Purchase',
        exit_intent_capture: 'Lead',
        // G4 — deposit is the MOST VALUABLE conversion event on the platform.
        // Server-side CAPI fires from /api/checkout/deposit POST (F5); this
        // client Pixel fire pairs via event_id passed in properties for dedup.
        deposit_initiated: 'InitiateCheckout',
        deposit_completed: 'Purchase',
      };
      const standardName = metaStandardEvents[event];
      if (standardName) {
        window.fbq('track', standardName, properties);
      } else {
        window.fbq('trackCustom', event, properties);
      }
    }
    // GA4 + Google Ads
    if (window.gtag) {
      window.gtag('event', event, properties);
    }
  } catch (e) {
    // Never let analytics break the user flow.
    console.warn('[analytics] track failed:', e);
  }
}
