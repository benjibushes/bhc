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
 * - 'deposit_completed'        — buyer landed on /checkout/[refId]/success (InitiateCheckout) — dedupe with server CAPI InitiateCheckout via event_id
 */

declare global {
  interface Window {
    fbq?: (...args: any[]) => void;
    gtag?: (...args: any[]) => void;
    dataLayer?: any[];
  }
}

/**
 * Meta Pixel ↔ CAPI dedup convention (E-3 audit) — THE one place it's defined.
 *
 * Meta dedups by (event_name, event_id). The client Pixel fire and the server
 * CAPI fire MUST send byte-identical event_ids or Meta sees two events and
 * every conversion double-counts. The convention:
 *
 *   event_id = the RAW Airtable record id of the event's subject.
 *   No prefixes. No suffixes. Not wrapped, not namespaced.
 *
 * (referralId for deposit InitiateCheckout/Purchase, consumer record id for
 * quiz Leads, partner/wholesale record id for form-submit Leads.) The same
 * record id can anchor multiple events safely because event_name differs.
 *
 * Prefixed ids (`deposit-invoice-${id}`, `cal-booking-${id}`) are ONLY legal
 * for server-only events that have no client Pixel pair to dedup against.
 *
 * Route both surfaces through this helper so the convention can't drift —
 * a prefix added on one side is exactly the bug E-3 fixed.
 */
export function metaEventId(recordId: string): string {
  return recordId;
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
  | 'partner_submit_success'
  | 'rancher_page_view'
  | 'rancher_pricing_click'
  | 'state_landing_view'
  | 'deposit_initiated'
  | 'deposit_completed'
  | 'funnel_lead'
  | 'funnel_complete_registration';

export function trackEvent(
  event: AnalyticsEventName,
  properties: Record<string, string | number | boolean> = {},
): void {
  if (typeof window === 'undefined') return;

  try {
    // Extract event_id from properties — Meta Pixel expects eventID as the
    // 4th-arg options object, NOT inside the properties payload. Passing it
    // inside properties causes 100% client+server CAPI dedup failure — Meta
    // can't match the two fires, every event double-counts, and the algo
    // optimizes against inflated signal. See Meta Pixel API docs.
    const { event_id, ...restProperties } = properties as Record<string, any>;
    // Meta Pixel — use CustomEvent for non-standard events, fbq.track for standards.
    if (window.fbq) {
      const metaStandardEvents: Record<string, string> = {
        access_quiz_submit: 'Lead',
        founders_backed: 'Purchase',
        founders_checkout_start: 'InitiateCheckout',
        brand_partners_purchased: 'Purchase',
        exit_intent_capture: 'Lead',
        // G4 — deposit fires are both InitiateCheckout (intent signal). The
        // actual Purchase fires server-side at Closed Won (final_invoice) — see
        // app/api/webhooks/stripe/route.ts final_invoice branch. Both deposit
        // events use event_id=referralId for client+server dedup.
        deposit_initiated: 'InitiateCheckout',
        deposit_completed: 'InitiateCheckout',
        // Audit 6 P0/P1 — paid-scale tracking gaps:
        // /partner is the B-side acquisition funnel (rancher/brand/land).
        // Each submit is a Lead — server CAPI pairs via record.id event_id.
        partner_submit_success: 'Lead',
        // /ranchers/[slug] paid traffic — per-rancher ViewContent gives
        // retargeting + creative-attribution segments by rancher_slug/state.
        rancher_page_view: 'ViewContent',
        // Pricing-click is the in-page intent signal — closer to AddToCart
        // than ViewContent. Funnel: rancher_page_view → rancher_pricing_click → Lead.
        rancher_pricing_click: 'AddToCart',
        // /access lander view — top-of-funnel ViewContent for the buyer funnel.
        access_view: 'ViewContent',
        // /access/[state] state-targeted ads need a state-segmented view
        // event for Meta optimization on the geo audience.
        state_landing_view: 'ViewContent',
        // /wholesale B2B form — server CAPI fires as 'Lead' with
        // event_id=recordId at /api/wholesale/signup/route.ts:235. Client
        // must fire same 'Lead' event_name + same event_id for Meta dedup
        // (E-4 audit fix). Previously fired as trackCustom which never
        // matched the server Lead → 100% double-count for wholesale.
        wholesale_submit_success: 'Lead',
        // BuyerFunnel contact step — Lead (pairs with server CAPI Lead at
        // /api/consumers contact branch via event_id=consumerId).
        funnel_lead: 'Lead',
        // BuyerFunnel storage step complete — CompleteRegistration (pairs
        // with server CAPI CompleteRegistration at /api/qualify via client-
        // minted eventId passed through the POST body).
        funnel_complete_registration: 'CompleteRegistration',
      };
      const standardName = metaStandardEvents[event];
      if (standardName) {
        if (event_id) {
          window.fbq('track', standardName, restProperties, { eventID: event_id });
        } else {
          window.fbq('track', standardName, restProperties);
        }
      } else {
        if (event_id) {
          window.fbq('trackCustom', event, restProperties, { eventID: event_id });
        } else {
          window.fbq('trackCustom', event, restProperties);
        }
      }
    }
    // GA4 + Google Ads — pass full properties (event_id is fine here).
    if (window.gtag) {
      window.gtag('event', event, properties);
    }
  } catch (e) {
    // Never let analytics break the user flow.
    console.warn('[analytics] track failed:', e);
  }
}
