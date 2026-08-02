// lib/buyerFieldValidation.ts
//
// Per-field inline validation for buyer-facing forms (Wave 2 buyer UI).
//
// PURE + client-safe — no IO, no env. One place for the wording so every
// buyer form says the same thing for the same mistake. Pattern: validate on
// BLUR (never on every keystroke — that punishes people mid-typing), render
// the message under the field via the Input/Textarea/Select `error` prop,
// clear it as soon as the value changes.
//
// Returns '' when valid so callers can store results directly in a
// Record<string, string> error map.

import { isValidEmail } from '@/lib/accountProfile';
import { isValidUsPhone } from '@/lib/phoneFormat';

export function emailFieldError(value: string): string {
  const v = String(value || '').trim();
  if (!v) return 'Enter your email address.';
  if (!isValidEmail(v)) return 'That doesn’t look like a valid email — check for typos.';
  return '';
}

export function requiredFieldError(value: string, label = 'This field'): string {
  return String(value || '').trim() ? '' : `${label} is required.`;
}

export function phoneFieldError(value: string): string {
  const v = String(value || '').trim();
  if (!v) return 'Enter your phone number.';
  if (!isValidUsPhone(v)) return 'Enter a valid 10-digit US phone number.';
  return '';
}

/** Optional-but-well-formed 5-digit ZIP ('' passes; a half-typed one fails). */
export function optionalZipFieldError(value: string): string {
  const v = String(value || '').trim();
  if (!v) return '';
  return /^\d{5}$/.test(v) ? '' : 'Enter a 5-digit ZIP code, or leave it blank.';
}

export function minLengthFieldError(value: string, min: number, label = 'This field'): string {
  const v = String(value || '').trim();
  if (!v) return `${label} is required.`;
  if (v.length < min) return `${label} needs at least ${min} characters.`;
  return '';
}
