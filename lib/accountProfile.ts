// lib/accountProfile.ts
//
// WAVE 3b (2026-06-30) — pure validation/normalization for rancher
// account/profile editing (operator name, ranch name, email, phone). Ranchers
// previously could NOT edit these — only a password modal existed and the
// landing-page PATCH allowlist deliberately excluded account fields. This
// module is the shared gate the PATCH handler uses so a malformed email/phone
// can never persist.
//
// PURE — no IO. Unit-tested for email format, phone digits, non-empty names.

// Airtable field names on the Ranchers table (all pre-existing — these are the
// canonical operator-contact fields). No NEW Airtable fields are required for
// account editing.
export const ACCOUNT_FIELDS = {
  operatorName: 'Operator Name',
  ranchName: 'Ranch Name',
  email: 'Email',
  phone: 'Phone',
} as const;

// The set of body keys the client may send for an account update.
export const ACCOUNT_EDITABLE_KEYS = [
  'Operator Name',
  'Ranch Name',
  'Email',
  'Phone',
] as const;
export type AccountEditableKey = (typeof ACCOUNT_EDITABLE_KEYS)[number];

export function isAccountEditableKey(k: string): k is AccountEditableKey {
  return (ACCOUNT_EDITABLE_KEYS as readonly string[]).includes(k);
}

const MAX_NAME = 120;

// Pragmatic email check — exactly one @, non-empty local + domain, a dot in the
// domain, no whitespace. Not RFC-perfect (no validator is) but rejects the
// fat-finger cases that would silently break every transactional email.
export function isValidEmail(v: string): boolean {
  const s = String(v || '').trim();
  if (!s || /\s/.test(s)) return false;
  if (s.length > 254) return false;
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@')) return false;
  const domain = s.slice(at + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return false;
  return true;
}

/** Count of digits in a phone string. */
export function phoneDigits(v: string): string {
  return String(v || '').replace(/\D/g, '');
}

/**
 * Normalize a US-style phone to a stored display form. Accepts 10 digits, or
 * 11 with a leading 1. Returns the digit string (caller stores as-is — the
 * Airtable Phone field is free text). Empty input → '' (clear allowed).
 */
export function normalizePhone(v: string): { ok: boolean; value: string; error?: string } {
  const raw = String(v || '').trim();
  if (!raw) return { ok: true, value: '' };
  const digits = phoneDigits(raw);
  if (digits.length === 11 && digits.startsWith('1')) {
    return { ok: true, value: formatUsPhone(digits.slice(1)) };
  }
  if (digits.length === 10) {
    return { ok: true, value: formatUsPhone(digits) };
  }
  return { ok: false, value: raw, error: 'Phone must be a 10-digit US number.' };
}

function formatUsPhone(ten: string): string {
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

export interface AccountPatchResult {
  ok: boolean;
  /** Airtable field map to write (only changed keys). */
  fields: Record<string, any>;
  /** First validation error, if any. */
  error?: string;
}

/**
 * Validate + normalize the account-field subset of a PATCH body.
 *
 * Only keys present in the body are processed. Returns the Airtable field map
 * to merge into the update, or ok:false with the first error.
 *
 * Rules:
 *   - Operator Name / Ranch Name: trimmed, non-empty (a blank would wipe the
 *     name buyers see), max 120 chars.
 *   - Email: must pass isValidEmail. Empty NOT allowed (the rancher's login +
 *     every transactional email keys off it).
 *   - Phone: 10-digit US (or 11 w/ leading 1); empty allowed (clears).
 */
export function validateAccountPatch(body: Record<string, any>): AccountPatchResult {
  const fields: Record<string, any> = {};

  if ('Operator Name' in body) {
    const name = String(body['Operator Name'] ?? '').trim();
    if (!name) return { ok: false, fields: {}, error: 'Operator name can’t be empty.' };
    if (name.length > MAX_NAME) return { ok: false, fields: {}, error: 'Operator name is too long.' };
    fields[ACCOUNT_FIELDS.operatorName] = name;
  }

  if ('Ranch Name' in body) {
    const name = String(body['Ranch Name'] ?? '').trim();
    if (!name) return { ok: false, fields: {}, error: 'Ranch name can’t be empty.' };
    if (name.length > MAX_NAME) return { ok: false, fields: {}, error: 'Ranch name is too long.' };
    fields[ACCOUNT_FIELDS.ranchName] = name;
  }

  if ('Email' in body) {
    const email = String(body['Email'] ?? '').trim();
    if (!email) return { ok: false, fields: {}, error: 'Email can’t be empty — it’s your login and where leads land.' };
    if (!isValidEmail(email)) return { ok: false, fields: {}, error: 'That doesn’t look like a valid email address.' };
    fields[ACCOUNT_FIELDS.email] = email.toLowerCase();
  }

  if ('Phone' in body) {
    const res = normalizePhone(String(body['Phone'] ?? ''));
    if (!res.ok) return { ok: false, fields: {}, error: res.error || 'Invalid phone number.' };
    fields[ACCOUNT_FIELDS.phone] = res.value || null;
  }

  return { ok: true, fields };
}
