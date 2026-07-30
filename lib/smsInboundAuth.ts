// lib/smsInboundAuth.ts — shared-secret auth for the provider-neutral inbound
// SMS webhook (app/api/webhooks/sms).
//
// WHY A QUERY TOKEN and not a signature: every vendor signs inbound webhooks
// differently (Twilio X-Twilio-Signature, Telnyx ed25519, Bandwidth none by
// default), and the whole point of the neutral route is that it does not care
// which vendor is calling. A per-deploy shared secret in the webhook URL is the
// portable denominator — it is what the vendor consoles all accept, and it is
// the same shape the other non-signing integrations in this repo use.
//
// Posture matches lib/cronAuth.ts and the cal/manychat webhooks: constant-time
// compare, and FAIL-CLOSED in production when the secret is unset (an anonymous
// endpoint that can flip consent flags is not acceptable). Non-prod warns and
// allows so local curl testing works.
//
// IMPORT-CLEAN apart from node:crypto — no airtable, no vendor SDKs.

import { timingSafeEqual } from 'crypto';

/**
 * Constant-time string comparison that never short-circuits on length.
 * Returns false (instead of throwing) for any mismatch.
 * Same implementation as lib/cronAuth.ts:safeEqual.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Compare against self to keep timing uniform, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export type InboundAuthVerdict = 'ok' | 'forbidden' | 'misconfigured';

/**
 * Verify the `?token=` on an inbound SMS webhook against SMS_INBOUND_SECRET.
 *
 *   'ok'            → proceed
 *   'forbidden'     → 403, token absent or wrong
 *   'misconfigured' → 503, secret unset in production (fail closed)
 *
 * Pure: reads only the env object it is given.
 */
export function verifySmsInboundToken(
  token: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): InboundAuthVerdict {
  const secret = String(env.SMS_INBOUND_SECRET ?? '').trim();
  if (!secret) {
    if (env.NODE_ENV === 'production') return 'misconfigured';
    return 'ok'; // non-prod: allow local testing, caller warns.
  }
  const given = String(token ?? '');
  if (!given) return 'forbidden';
  return safeEqual(given, secret) ? 'ok' : 'forbidden';
}
