// app/api/webhooks/sms/route.ts
//
// PROVIDER-NEUTRAL inbound SMS webhook. Point Telnyx, Plivo or Bandwidth here
// and STOP/HELP/START behave EXACTLY as they do on the Twilio route — same
// keyword table (lib/smsKeywords.ts), same Airtable consent flip
// (lib/smsInboundHandler.ts), same reply copy. Carrier opt-out handling is a
// legal obligation; it must not depend on which vendor Ben could get through
// signup with.
//
//   URL to paste into the vendor console:
//     https://www.buyhalfcow.com/api/webhooks/sms?token=<SMS_INBOUND_SECRET>
//
// Auth: shared secret in the query string, constant-time compared
// (lib/smsInboundAuth.ts). Fail-CLOSED in production when SMS_INBOUND_SECRET is
// unset — an anonymous endpoint that can flip consent flags is not acceptable.
// Non-prod warns and allows so local curl testing works.
//
// The Twilio route (app/api/webhooks/twilio-sms) is untouched and remains the
// canonical Twilio endpoint with X-Twilio-Signature verification. This route
// ALSO understands Twilio's payload shape, so it works as a fallback if the
// Twilio number is ever repointed here.
//
// Replies: Twilio answers inbound over TwiML; the other three have no reply
// channel on the webhook response, so HELP/START replies go back out through
// lib/smsTransport. That outbound leg is gated by smsEnabled() like every other
// send — ENABLE_SMS remains THE master gate.
//
// Always returns 2xx (except auth failures) so no vendor retry-storms. Bandwidth
// in particular REQUIRES a 2xx for every callback.

import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { parseInboundSms } from '@/lib/smsInbound';
import { classifyKeyword, replyTextFor } from '@/lib/smsKeywords';
import { applyInboundKeyword } from '@/lib/smsInboundHandler';
import { verifySmsInboundToken } from '@/lib/smsInboundAuth';
import { sendViaProvider } from '@/lib/smsTransport';
import { smsEnabled } from '@/lib/smsFlag';
import { normalizeToE164 } from '@/lib/phoneE164';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const json = (body: unknown, status = 200) =>
  NextResponse.json(body as any, { status });

/**
 * Decode the request body into a plain object regardless of encoding.
 * JSON providers (telnyx, bandwidth) send application/json; form providers
 * (twilio, plivo) send application/x-www-form-urlencoded. Plivo can also be
 * configured to GET, in which case the params ride the query string.
 */
async function decodeBody(req: Request): Promise<unknown> {
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      return await req.json();
    } catch {
      return null;
    }
  }
  try {
    const form = await req.formData();
    const out: Record<string, string> = {};
    for (const [k, v] of form.entries()) out[k] = typeof v === 'string' ? v : '';
    return out;
  } catch {
    // Some vendors post JSON without the header. Last resort: try text→JSON.
    try {
      const text = await req.text();
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }
}

/** Query params as a plain object — the Plivo-GET path. */
function queryObject(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(req.url).searchParams.entries()) {
    if (k !== 'token') out[k] = v;
  }
  return out;
}

async function handle(req: Request, raw: unknown) {
  const inbound = parseInboundSms(raw);
  if (!inbound) {
    // Not a recognizable inbound MESSAGE — a delivery receipt, a status
    // callback, an empty body. Acknowledge and ignore; never an error.
    return json({ ok: true, ignored: true });
  }

  const keyword = classifyKeyword(inbound.body);
  await applyInboundKeyword({
    from: inbound.from,
    keyword,
    logTag: `sms-inbound:${inbound.provider}`,
  });

  const reply = replyTextFor(keyword);

  // Twilio replies inline via TwiML — same wire as the dedicated Twilio route.
  if (inbound.provider === 'twilio') {
    const msg = new twilio.twiml.MessagingResponse();
    if (reply) msg.message(reply);
    return new NextResponse(msg.toString(), {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  }

  let replied = false;
  if (reply) {
    if (!smsEnabled()) {
      // ENABLE_SMS is THE master gate and it applies to compliance replies too.
      // Inbound cannot realistically arrive with the channel off, but the gate
      // does not get an exception carved into it.
      console.warn(`[sms-inbound:${inbound.provider}] ENABLE_SMS off — skipping ${keyword} reply`);
    } else {
      // Reply FROM the number they texted when we can parse it, so a HELP reply
      // comes off the same long code (CTIA expectation). Falls back to the
      // provider's configured *_FROM when the inbound `to` is unusable.
      const from = normalizeToE164(inbound.to) || undefined;
      const res = await sendViaProvider({ to: inbound.from, body: reply, from });
      replied = res.ok;
      if (!res.ok) {
        console.error(`[sms-inbound:${inbound.provider}] ${keyword} reply failed:`, res.error);
      }
    }
  }

  return json({ ok: true, provider: inbound.provider, keyword, replied });
}

function authorize(req: Request): NextResponse | null {
  const token = new URL(req.url).searchParams.get('token');
  const verdict = verifySmsInboundToken(token);
  if (verdict === 'ok') {
    if (!String(process.env.SMS_INBOUND_SECRET ?? '').trim()) {
      console.warn('[sms-inbound] SMS_INBOUND_SECRET not set (non-prod) — skipping token check');
    }
    return null;
  }
  if (verdict === 'misconfigured') {
    console.error('[sms-inbound] SMS_INBOUND_SECRET missing in production — refusing inbound SMS');
    return json({ error: 'Not configured' }, 503);
  }
  console.warn('[sms-inbound] bad or missing token — rejecting');
  return json({ error: 'Unauthorized' }, 403);
}

export async function POST(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    return await handle(req, await decodeBody(req));
  } catch (e: any) {
    console.error('[sms-inbound] error:', e?.message || e);
    // Always 200 so no vendor retry-storms on our bug.
    return json({ ok: true, error: 'handled' });
  }
}

// Plivo can be configured to deliver inbound messages over GET.
export async function GET(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    return await handle(req, queryObject(req));
  } catch (e: any) {
    console.error('[sms-inbound] error:', e?.message || e);
    return json({ ok: true, error: 'handled' });
  }
}
