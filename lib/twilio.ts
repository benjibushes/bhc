// lib/twilio.ts
// Twilio SMS helper. Graceful no-op when env vars missing.
//
// Required env vars:
//   TWILIO_ACCOUNT_SID    — from Twilio Console
//   TWILIO_AUTH_TOKEN     — from Twilio Console (or use API Key for production)
//   TWILIO_FROM_NUMBER    — Twilio phone number in E.164 (+1XXXXXXXXXX)
//
// If any missing, sendSMS() warns + returns false. Never block request paths.

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
