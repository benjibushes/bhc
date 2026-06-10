// lib/metaCapi.ts
//
// Server-side Meta Conversions API.
//
// Why: client-side Pixel loses ~30-50% of events under iOS 14.5+ ATT
// + adblockers + browser tracking protection. CAPI fires the same events
// from our server, deduplicated with the client Pixel via `event_id`.
// Restored attribution = accurate ROAS = paid-ad optimization that works.
//
// Required env vars:
//   META_PIXEL_ID            — pixel ID from Meta Events Manager
//   META_CAPI_ACCESS_TOKEN   — long-lived access token from same place
//
// Optional:
//   META_CAPI_TEST_CODE      — when set, events go to Test Events panel
//                              (use during QA, leave unset in production)
//
// If either env var is missing, fireCapi() logs a warning + returns
// without firing — never block the request path.

import crypto from 'crypto';

const PIXEL_ID = process.env.META_PIXEL_ID;
const ACCESS_TOKEN = process.env.META_CAPI_ACCESS_TOKEN;
const TEST_CODE = process.env.META_CAPI_TEST_CODE;
const GRAPH_API_VERSION = 'v18.0';

export interface CapiEvent {
  event_name: 'Lead' | 'CompleteRegistration' | 'InitiateCheckout' | 'Purchase' | 'PageView' | 'Schedule';
  event_time: number; // unix seconds
  event_source_url?: string;
  event_id?: string;
  action_source: 'website' | 'system_generated' | 'email';
  user_data: ReturnType<typeof buildUserData>;
  custom_data?: {
    value?: number;
    currency?: string;
    content_name?: string;
    content_category?: string;
    content_ids?: string[];
    content_type?: string;
  };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

export function buildUserData(input: {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  state?: string;
  city?: string;
  ip?: string;
  userAgent?: string;
  fbp?: string; // Facebook browser id (from _fbp cookie)
  fbc?: string; // Facebook click id (from _fbc cookie)
}) {
  const data: Record<string, any> = {};
  if (input.email) data.em = [sha256(input.email)];
  if (input.phone) {
    const digits = input.phone.replace(/\D/g, '');
    if (digits.length >= 10) data.ph = [sha256(digits)];
  }
  if (input.firstName) data.fn = [sha256(input.firstName)];
  if (input.lastName) data.ln = [sha256(input.lastName)];
  if (input.state) data.st = [sha256(input.state.toLowerCase())];
  if (input.city) data.ct = [sha256(input.city.toLowerCase())];
  data.country = [sha256('us')];
  if (input.ip) data.client_ip_address = input.ip;
  if (input.userAgent) data.client_user_agent = input.userAgent;
  if (input.fbp) data.fbp = input.fbp;
  if (input.fbc) data.fbc = input.fbc;
  return data;
}

/**
 * Read Meta's first-party cookies (_fbp, _fbc) from a Request.
 *
 * Why: Meta CAPI cannot match server events to ad clicks without these.
 * _fbp = persistent browser id (set by Pixel on first load).
 * _fbc = click id from fbclid param (set when user lands from ad).
 *
 * Missing fbp/fbc → severe match-rate loss even when event_id is correct.
 * Always read + pass to buildUserData from any handler with request context.
 *
 * For system-generated events (Stripe webhooks, cron) there is no browser,
 * so cookies remain undefined. That's correct — action_source distinguishes.
 */
export function getMetaCookiesFromRequest(request: Request): { fbp?: string; fbc?: string } {
  const cookieHeader = request.headers.get('cookie') || '';
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq);
    const v = trimmed.slice(eq + 1);
    cookies[k] = v;
  }
  return {
    fbp: cookies._fbp || undefined,
    fbc: cookies._fbc || undefined,
  };
}

export async function fireCapi(events: CapiEvent[]): Promise<void> {
  if (!PIXEL_ID || !ACCESS_TOKEN) {
    console.warn('[meta-capi] PIXEL_ID or ACCESS_TOKEN missing — skip fire');
    return;
  }
  if (events.length === 0) return;

  try {
    const body: Record<string, any> = { data: events };
    if (TEST_CODE) body.test_event_code = TEST_CODE;

    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[meta-capi] fire failed ${res.status}:`, text.slice(0, 500));
      // T6 (2026-06-10): Telegram alert on CAPI fire fail. Throttled
      // 1h per event_name so we surface dedup-break / token rot
      // without flooding during a Meta API incident. Names + status
      // get bucketed in dedupeKey.
      const firstEventName = events[0]?.event_name || 'unknown';
      try {
        const { sendOperatorSignal } = await import('./operatorSignal');
        await sendOperatorSignal({
          urgency: 'normal',
          kind: 'system-error',
          summary: `Meta CAPI ${firstEventName} fire ${res.status}`,
          detail: text.slice(0, 300) || 'no body',
          dedupeKey: `meta-capi-fail:${firstEventName}:${res.status}`,
          dedupeWindowMs: 60 * 60 * 1000,
        });
      } catch {}
    }
  } catch (e: any) {
    console.error('[meta-capi] error:', e);
    try {
      const { sendOperatorSignal } = await import('./operatorSignal');
      await sendOperatorSignal({
        urgency: 'normal',
        kind: 'system-error',
        summary: 'Meta CAPI exception',
        detail: String(e?.message || e).slice(0, 300),
        dedupeKey: 'meta-capi-exception',
        dedupeWindowMs: 60 * 60 * 1000,
      });
    } catch {}
  }
}
