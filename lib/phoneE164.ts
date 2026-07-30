// lib/phoneE164.ts — E.164 phone normalization for the SMS rail.
//
// EXTRACTED from lib/twilio.ts (2026-07-30, provider-agnostic SMS transport).
// The logic is byte-identical to what lived there; it moved so that
// lib/smsTransport.ts and the provider adapters can normalize without
// importing lib/twilio.ts (which imports the transport — a cycle).
//
// IMPORT-CLEAN by design, same contract as lib/smsFlag.ts: this module must
// never import anything. It is pulled in by webhooks, crons, adapters, and
// unit tests that must not drag side-effectful modules (twilio SDK, airtable)
// along.
//
// lib/twilio.ts re-exports `normalizeToE164` so every existing
// `import { normalizeToE164 } from '@/lib/twilio'` keeps working unchanged.

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
