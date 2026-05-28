// lib/twilio.ts
// Twilio SMS helper. Graceful no-op when env vars missing.
//
// Required env vars:
//   TWILIO_ACCOUNT_SID    — from Twilio Console
//   TWILIO_AUTH_TOKEN     — from Twilio Console (or use API Key for production)
//   TWILIO_FROM_NUMBER    — Twilio phone number in E.164 (+1XXXXXXXXXX)
//
// If any missing, sendSMS() warns + returns false. Never block request paths.
//
// TCPA / opt-in posture:
//   - `sendSMS()` is the raw bottom-half — normalizes phone to E.164 + fires.
//     ONLY safe to call for one-off admin/test sends to known-consenting numbers.
//   - `sendSMSToConsumer()` is the consumer-facing top-half — gates on the
//     Consumer record's `SMS Opt-In === true` AND `Unsubscribed !== true`,
//     then delegates to sendSMS(). EVERY consumer-facing SMS must go through
//     this helper so the gate can't be bypassed by a future careless caller.

import twilio from 'twilio';

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

const client = ACCOUNT_SID && AUTH_TOKEN ? twilio(ACCOUNT_SID, AUTH_TOKEN) : null;

/**
 * Normalize phone to E.164 format (+1XXXXXXXXXX for US).
 * Returns null if input can't be coerced to a valid E.164.
 */
export function normalizeToE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

export async function sendSMS(input: {
  to: string;
  body: string;
}): Promise<boolean> {
  if (!client || !FROM_NUMBER) {
    console.warn('[twilio] account SID/auth token/from number missing — skip send');
    return false;
  }

  const to = normalizeToE164(input.to);
  if (!to) {
    console.warn(`[twilio] invalid phone number, skipping: ${input.to}`);
    return false;
  }

  try {
    const result = await client.messages.create({
      body: input.body,
      from: FROM_NUMBER,
      to,
    });
    console.log(`[twilio] sent SID ${result.sid} to ${to}`);
    return true;
  } catch (e: any) {
    console.error(`[twilio] send failed to ${to}:`, e?.message || e);
    return false;
  }
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
