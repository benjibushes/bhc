// lib/smsInbound.ts — normalize an inbound-SMS webhook body from ANY supported
// provider into one shape.
//
// STOP/HELP handling is a legal requirement (CTIA + TCPA), not a nicety. It has
// to behave identically no matter which vendor is carrying the message, which
// means the four wildly different inbound payload shapes have to collapse to
// one before the handler ever sees them.
//
// Payload shapes are quoted from the vendors' own docs (all fetched 2026-07-30):
//
//   twilio     form-urlencoded: From, To, Body, MessageSid
//              (the shape app/api/webhooks/twilio-sms already consumes)
//
//   telnyx     JSON  https://developers.telnyx.com/docs/messaging/messages/receive-message
//              { data: { event_type: "message.received",
//                        payload: { id, text,
//                                   from: { phone_number },
//                                   to: [ { phone_number } ] } } }
//
//   plivo      form-urlencoded (POST default; GET also supported)
//              https://www.plivo.com/docs/messaging/use-cases/receive-sms/receive-sms
//              From, To, Text  — the docs' working samples show exactly these
//              three. MessageUUID / Type appear on Plivo's messages elsewhere
//              but are NOT documented on the inbound callback, so they are
//              read OPTIONALLY here and never required.
//
//   bandwidth  JSON ARRAY  https://dev.bandwidth.com/docs/messaging/webhooks/
//              [ { type: "message-received", to,
//                  message: { id, from, to: [...], text, direction: "in" } } ]
//
// Detection is by SHAPE, not by SMS_PROVIDER: inbound can legitimately arrive
// from a vendor you are migrating away from while its number still rings.
//
// `from` / `to` are returned as the vendor sent them (trimmed, NOT normalized).
// The handler normalizes to E.164 itself and also matches the raw form against
// Airtable's mixed-format Phone column — throwing the raw value away here would
// break that lookup.
//
// IMPORT-CLEAN by design (same contract as lib/smsFlag.ts): no airtable, no
// vendor SDKs, no env reads. Pure function, fully unit-tested.

import type { SmsProvider } from './smsProviders/types';

export interface InboundSms {
  provider: SmsProvider;
  /** Sender, as the vendor sent it (may be E.164 or raw digits). */
  from: string;
  /** The number that received it — our line. */
  to: string;
  /** Message text. */
  body: string;
  /** Vendor's own message id. '' when the payload carried none. */
  providerMessageId: string;
}

const str = (v: unknown): string => (v == null ? '' : String(v).trim());

/** First `phone_number` in a Telnyx `to: [...]` array. */
function telnyxFirstTo(to: unknown): string {
  if (Array.isArray(to)) return str((to[0] as any)?.phone_number);
  return str((to as any)?.phone_number);
}

/**
 * Parse a provider webhook body into `{ from, to, body, providerMessageId }`.
 *
 * `raw` is the already-decoded body: a plain object of form fields for
 * form-urlencoded providers (twilio, plivo) or parsed JSON for the rest.
 *
 * Returns null when the payload is not a recognizable inbound MESSAGE — a
 * delivery receipt, a status callback, an empty body, garbage. Callers must
 * treat null as "acknowledge and ignore", never as an error.
 */
export function parseInboundSms(raw: unknown): InboundSms | null {
  if (!raw || typeof raw !== 'object') return null;

  // ── Bandwidth: a JSON array of events ────────────────────────────────────
  if (Array.isArray(raw)) {
    const ev = raw.find(
      (e: any) => e && typeof e === 'object' && str(e.type) === 'message-received',
    ) as any;
    if (!ev?.message) return null;
    const m = ev.message;
    const to = Array.isArray(m.to) ? str(m.to[0]) : str(m.to) || str(ev.to);
    const from = str(m.from);
    if (!from) return null;
    return {
      provider: 'bandwidth',
      from,
      to,
      body: str(m.text),
      providerMessageId: str(m.id),
    };
  }

  const o = raw as Record<string, any>;

  // ── Telnyx: { data: { event_type, payload: {...} } } ─────────────────────
  const payload = o.data?.payload;
  if (payload && typeof payload === 'object') {
    // Only inbound messages. Delivery receipts (message.finalized / .sent)
    // share the envelope and must NOT be treated as a buyer texting STOP.
    const eventType = str(o.data?.event_type);
    if (eventType && eventType !== 'message.received') return null;
    if (!eventType && str(payload.direction) !== 'inbound') return null;
    const from = str(payload.from?.phone_number);
    if (!from) return null;
    return {
      provider: 'telnyx',
      from,
      to: telnyxFirstTo(payload.to),
      body: str(payload.text),
      providerMessageId: str(payload.id),
    };
  }

  // ── Plivo: form fields From / To / Text (+ optional MessageUUID) ─────────
  // Distinguished from Twilio by `Text` vs Twilio's `Body`.
  if ('Text' in o || 'MessageUUID' in o) {
    const from = str(o.From);
    if (!from) return null;
    return {
      provider: 'plivo',
      from,
      to: str(o.To),
      body: str(o.Text),
      providerMessageId: str(o.MessageUUID),
    };
  }

  // ── Twilio: form fields From / To / Body / MessageSid ────────────────────
  if ('Body' in o || 'MessageSid' in o || 'SmsMessageSid' in o) {
    const from = str(o.From);
    if (!from) return null;
    return {
      provider: 'twilio',
      from,
      to: str(o.To),
      body: str(o.Body),
      providerMessageId: str(o.MessageSid || o.SmsMessageSid),
    };
  }

  return null;
}
