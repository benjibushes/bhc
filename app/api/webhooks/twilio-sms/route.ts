// app/api/webhooks/twilio-sms/route.ts
//
// Inbound SMS webhook — the carrier-required STOP/HELP/START handling for our
// A2P 10DLC campaign, TWILIO FLAVOUR. Twilio POSTs form-urlencoded inbound
// messages here (`From`, `Body`, `To`, `MessageSid`, …).
//
// 2026-07-30: the keyword rules and the Airtable consent flip MOVED to
// lib/smsKeywords.ts + lib/smsInboundHandler.ts so the provider-neutral route
// (app/api/webhooks/sms) enforces the exact same behavior. This route is now
// Twilio-specific plumbing only: signature verification + TwiML. Nothing about
// its external behavior changed.
//
// Keyword semantics (now defined in lib/smsKeywords.ts, applied in
// lib/smsInboundHandler.ts):
//   STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / QUIT
//       → Unsubscribed=true + SMS Opt-In=false   (Twilio itself also blocks the
//         number at the carrier level; we mirror it so our own gate agrees).
//   START / UNSTOP / YES (re-subscribe)
//       → Unsubscribed=false + SMS Opt-In=true + re-stamp SMS Opt-In At.
//   HELP / INFO
//       → reply with brand + contact + "Reply STOP to cancel".
//   anything else
//       → acknowledge, no state change (carrier still delivers our reply, if any).
//
// Security: verify X-Twilio-Signature with twilio.validateRequest. The URL is
// reconstructed from x-forwarded-proto/host (Vercel terminates TLS upstream, so
// req.url's protocol/host can't be trusted). FAIL-CLOSED in production when the
// signature is absent/invalid; in non-prod (no auth token) we fail-open so local
// curl testing works. We always return valid TwiML so Twilio doesn't retry-storm.

import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { classifyKeyword, replyTextFor, type SmsKeyword } from '@/lib/smsKeywords';
import { applyInboundKeyword } from '@/lib/smsInboundHandler';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Re-exported so the existing app/api/webhooks/twilio-sms/classifyKeyword.test.ts
// (and any caller importing from this route) keeps resolving. Single definition
// lives in lib/smsKeywords.ts.
export { classifyKeyword };
export type { SmsKeyword };

// Build the TwiML <Response> for a given keyword. Reply COPY comes from
// lib/smsKeywords.replyTextFor so Twilio and the neutral route say the same
// words; TwiML wrapping is the only Twilio-specific part.
function twimlFor(keyword: SmsKeyword): string {
  const msg = new twilio.twiml.MessagingResponse();
  // STOP → replyTextFor returns null: Twilio injects its own carrier-mandated
  // STOP confirmation, so we keep our TwiML empty to avoid sending a second
  // message after an opt-out. 'other' also gets an empty response (no
  // auto-reply, avoids noise + loops).
  const text = replyTextFor(keyword);
  if (text) msg.message(text);
  return msg.toString();
}

function twimlResponse(xml: string) {
  return new NextResponse(xml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

export async function POST(req: Request) {
  try {
    // Read the raw form body once — we need it both for signature validation
    // (Twilio signs the sorted param set) and for the keyword.
    const form = await req.formData();
    const params: Record<string, string> = {};
    for (const [k, v] of form.entries()) params[k] = typeof v === 'string' ? v : '';

    const fromRaw = params['From'] || '';
    const bodyRaw = params['Body'] || '';

    // ── Signature verification (fail-closed in prod) ──────────────────────────
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const signature = req.headers.get('x-twilio-signature') || '';
    // Reconstruct the externally-visible URL: Vercel terminates TLS, so req.url
    // reports the internal http origin. Twilio signed against the public https
    // URL → rebuild from forwarded headers.
    const proto = req.headers.get('x-forwarded-proto') || 'https';
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || '';
    const url = `${proto}://${host}/api/webhooks/twilio-sms`;

    if (authToken) {
      const valid = twilio.validateRequest(authToken, signature, url, params);
      if (!valid) {
        console.warn('[twilio-sms] invalid X-Twilio-Signature — rejecting', { host });
        // 403 + empty TwiML. Twilio treats non-2xx as failure but won't act on
        // a forged request — exactly what we want.
        return new NextResponse('<Response/>', {
          status: 403,
          headers: { 'Content-Type': 'text/xml' },
        });
      }
    } else if (process.env.NODE_ENV === 'production') {
      // Prod with no auth token configured = misconfiguration. Fail closed so we
      // never act on unverifiable inbound messages.
      console.error('[twilio-sms] TWILIO_AUTH_TOKEN missing in production — refusing to process inbound SMS');
      return new NextResponse('<Response/>', {
        status: 503,
        headers: { 'Content-Type': 'text/xml' },
      });
    }
    // else: non-prod without a token → fall through (local testing).

    const keyword = classifyKeyword(bodyRaw);

    // STOP/START flip our own opt-in state on the matching consumer. HELP/other
    // never mutate. Match by normalized E.164 phone — best-effort; a no-match
    // (number not in our DB, e.g. a stranger texting the line) is fine, Twilio
    // still handles the carrier-level STOP regardless.
    await applyInboundKeyword({ from: fromRaw, keyword, logTag: 'twilio-sms' });

    return twimlResponse(twimlFor(keyword));
  } catch (e: any) {
    console.error('[twilio-sms] error:', e?.message || e);
    // Always 200 with valid TwiML to avoid retry storms.
    return twimlResponse('<Response/>');
  }
}
