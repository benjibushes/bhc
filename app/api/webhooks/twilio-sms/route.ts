// app/api/webhooks/twilio-sms/route.ts
//
// Inbound SMS webhook — the carrier-required STOP/HELP/START handling for our
// A2P 10DLC campaign. Twilio POSTs form-urlencoded inbound messages here
// (`From`, `Body`, `To`, `MessageSid`, …). We classify the keyword and update
// the matching Consumer's opt-in state so the Twilio gate (sendSMSToConsumer in
// lib/twilio.ts, which checks `SMS Opt-In === true` && `Unsubscribed !== true`)
// reflects the buyer's wishes immediately.
//
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
import {
  getAllRecords,
  updateRecord,
  escapeAirtableValue,
  TABLES,
} from '@/lib/airtable';
import { normalizeToE164 } from '@/lib/twilio';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const BRAND = 'BuyHalfCow';
const SUPPORT_EMAIL = 'hello@buyhalfcow.com';

export type SmsKeyword = 'stop' | 'start' | 'help' | 'other';

// Twilio's standard opt-out / opt-in / help keyword sets (case-insensitive,
// whitespace-trimmed, punctuation stripped). Kept as a pure function so it's
// unit-testable without HTTP. The first non-empty token decides — carriers
// treat "STOP please" the same as "STOP".
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'stopn']);
const START_WORDS = new Set(['start', 'unstop', 'yes', 'unsubscribe-stop', 'resume']);
const HELP_WORDS = new Set(['help', 'info']);

export function classifyKeyword(body: string | null | undefined): SmsKeyword {
  if (!body) return 'other';
  // Strip everything but letters so "STOP." / "Stop!" / " stop " all match,
  // then take the first whitespace-delimited token of the original-trimmed body.
  const firstToken = String(body).trim().split(/\s+/)[0] || '';
  const word = firstToken.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return 'other';
  if (STOP_WORDS.has(word)) return 'stop';
  if (START_WORDS.has(word)) return 'start';
  if (HELP_WORDS.has(word)) return 'help';
  return 'other';
}

// Build the TwiML <Response> for a given keyword. HELP must reply with brand +
// contact per CTIA guidelines; STOP/START get a short confirmation; everything
// else gets an empty response (no auto-reply, avoids noise + loops).
function twimlFor(keyword: SmsKeyword): string {
  const msg = new twilio.twiml.MessagingResponse();
  if (keyword === 'help') {
    msg.message(
      `${BRAND}: half-cow beef matching. Help: ${SUPPORT_EMAIL}. Msg & data rates may apply. Reply STOP to cancel.`,
    );
  } else if (keyword === 'stop') {
    // Twilio injects its own carrier-mandated STOP confirmation; we keep our
    // TwiML empty to avoid sending a second message after an opt-out.
  } else if (keyword === 'start') {
    msg.message(`${BRAND}: you're re-subscribed. Reply STOP to cancel, HELP for help.`);
  }
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
    if (keyword === 'stop' || keyword === 'start') {
      const e164 = normalizeToE164(fromRaw);
      if (e164) {
        try {
          const consumer = await findConsumerByPhone(e164, fromRaw);
          if (consumer) {
            if (keyword === 'stop') {
              await updateRecord(TABLES.CONSUMERS, consumer.id, {
                'Unsubscribed': true,
                'SMS Opt-In': false,
              });
              console.log(`[twilio-sms] STOP → opted out ${consumer.id}`);
            } else {
              // re-opt-in: clear suppression + re-stamp consent evidence.
              await updateRecord(TABLES.CONSUMERS, consumer.id, {
                'Unsubscribed': false,
                'SMS Opt-In': true,
                'SMS Opt-In At': new Date().toISOString(),
              });
              console.log(`[twilio-sms] START → re-opted-in ${consumer.id}`);
            }
          } else {
            console.log('[twilio-sms] no consumer matched for inbound', { keyword });
          }
        } catch (e: any) {
          // Never let an Airtable hiccup turn into a Twilio retry storm.
          console.error('[twilio-sms] consumer update failed:', e?.message || e);
        }
      }
    }

    return twimlResponse(twimlFor(keyword));
  } catch (e: any) {
    console.error('[twilio-sms] error:', e?.message || e);
    // Always 200 with valid TwiML to avoid retry storms.
    return twimlResponse('<Response/>');
  }
}

// Find a Consumer by phone. We match on the normalized E.164 form but our DB
// stores phones in mixed formats (raw form input), so we query a few common
// representations. Best-effort, fail-open (returns null on error).
async function findConsumerByPhone(
  e164: string,
  raw: string,
): Promise<{ id: string } | null> {
  const digits = e164.replace(/\D/g, ''); // e.g. 15551234567
  const tenDigit = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  // Candidate stored formats to OR-match against the Phone column.
  const candidates = Array.from(
    new Set(
      [e164, raw.trim(), digits, tenDigit].filter((v) => v && v.length >= 7),
    ),
  );
  const clauses = candidates
    .map((c) => `{Phone} = "${escapeAirtableValue(c)}"`)
    .join(', ');
  // Also catch records whose stored phone, with non-digits stripped, ends with
  // the 10-digit national number — covers "(555) 123-4567" style storage.
  const formula = `OR(${clauses}, RIGHT(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({Phone}, "-", ""), " ", ""), "(", ""), ")", ""), 10) = "${escapeAirtableValue(tenDigit)}")`;
  try {
    const rows = (await getAllRecords(TABLES.CONSUMERS, formula)) as any[];
    if (rows.length > 0) return { id: rows[0].id };
  } catch (e: any) {
    console.error('[twilio-sms] findConsumerByPhone failed:', e?.message || e);
  }
  return null;
}
