// lib/twilio.ts
// SMS helper. Graceful no-op when env vars missing.
//
// NAME IS HISTORICAL — this file is no longer Twilio-specific. The actual wire
// moved to lib/smsTransport.ts (2026-07-30) so the channel is not hostage to
// one vendor's signup queue; the Twilio path is now one of four adapters under
// lib/smsProviders/ and stays the DEFAULT when SMS_PROVIDER is unset. The file
// keeps its name + exports because ten callers import from '@/lib/twilio' and
// none of them should have to care which vendor is on the other end.
//
// Env (default twilio adapter — see docs/SMS-PROVIDER-SETUP.md for the others):
//   TWILIO_ACCOUNT_SID    — from Twilio Console
//   TWILIO_AUTH_TOKEN     — from Twilio Console (or use API Key for production)
//   TWILIO_FROM_NUMBER    — Twilio phone number in E.164 (+1XXXXXXXXXX)
//
// If any missing, sendSMS() warns + returns false. Never block request paths.
//
// TCPA / opt-in posture (UNCHANGED by the transport swap — the provider sits
// strictly BELOW every gate below):
//   - `sendSMS()` is the raw bottom-half — normalizes phone to E.164 + fires.
//     ONLY safe to call for one-off admin/test sends to known-consenting numbers.
//   - `sendSMSToConsumer()` is the consumer-facing top-half — gates on the
//     Consumer record's `SMS Opt-In === true` AND `Unsubscribed !== true`,
//     then delegates to sendSMS(). EVERY consumer-facing SMS must go through
//     this helper so the gate can't be bypassed by a future careless caller.

// DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
// lib/demo/demoMode.ts. Pure import, no side effect when the flag is off.
import { isDemoMode } from '@/lib/demo/demoMode';
import { sendViaProvider } from '@/lib/smsTransport';

// Re-exported from lib/phoneE164.ts (moved there so the transport + adapters can
// normalize without importing this module, which imports the transport). Every
// existing `import { normalizeToE164 } from '@/lib/twilio'` keeps working.
export { normalizeToE164 } from '@/lib/phoneE164';
import { normalizeToE164 } from '@/lib/phoneE164';

export async function sendSMS(input: {
  to: string;
  body: string;
}): Promise<boolean> {
  // DEMO MODE (local only, NEXT_PUBLIC_DEMO_MODE) — never true in prod; see
  // lib/demo/demoMode.ts. Report success without calling the provider.
  if (isDemoMode()) {
    console.log(`[twilio] DEMO MODE — skipping SMS to ${input.to}`);
    return true;
  }

  const to = normalizeToE164(input.to);
  if (!to) {
    console.warn(`[twilio] invalid phone number, skipping: ${input.to}`);
    return false;
  }

  // Transport dispatch. Credential checks, the vendor HTTP call, error shaping
  // and logging all live in the adapter; a missing credential still warns and
  // returns false exactly as before. Result is collapsed to a boolean so every
  // existing caller's contract is untouched.
  const result = await sendViaProvider({ to, body: input.body });
  return result.ok;
}

/**
 * Consumer-facing SMS gate. THE ONLY safe entry point for sending SMS
 * to a buyer/rancher. Checks the Consumer (or Rancher) record's opt-in
 * + suppression state before delegating to sendSMS().
 *
 * Hard gates (any one returns false → no SMS):
 *   - `SMS Opt-In !== true`         — TCPA: no explicit consent, no send
 *   - `Unsubscribed === true`       — global suppression mirror (email + SMS)
 *   - empty/invalid phone           — handled downstream in sendSMS()
 *
 * Use this from every cron, route, and webhook. Never call sendSMS()
 * directly from a consumer-facing path.
 */
export async function sendSMSToConsumer(input: {
  consumer: Record<string, any> | null | undefined;
  body: string;
  /**
   * Optional override when caller already pulled phone separately
   * (e.g. forms where the record-level Phone is empty but the request body
   *  carried a fresh number). Falls back to consumer['Phone'].
   */
  phone?: string;
  /** For logs / future per-consumer audit. */
  reason?: string;
}): Promise<boolean> {
  const { consumer, body, phone, reason } = input;
  if (!consumer) {
    console.warn('[twilio] sendSMSToConsumer: no consumer record', { reason });
    return false;
  }

  // Suppression mirror — Unsubscribed flag drives email suppression already;
  // applying it to SMS keeps the two channels consistent.
  if (consumer['Unsubscribed'] === true) {
    console.log('[twilio] gated: Unsubscribed=true', { reason });
    return false;
  }

  // TCPA explicit opt-in. Without true here, we never fire.
  if (consumer['SMS Opt-In'] !== true) {
    console.log('[twilio] gated: SMS Opt-In !== true', { reason });
    return false;
  }

  const to = (phone || consumer['Phone'] || '').toString().trim();
  if (!to) {
    console.log('[twilio] gated: no phone on record', { reason });
    return false;
  }

  return sendSMS({ to, body });
}
