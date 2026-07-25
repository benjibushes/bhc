// lib/phoneFormat.ts
//
// ONE phone normalizer for every signup door.
//
// THE BUG THIS EXISTS TO KILL (2026-07-24): every door's formatter did
// `digits.slice(0, 10)` on the raw digit string. A rancher who typed their
// number the way half of America writes it — `1 (406) 555-1234` — produced
// digits `14065551234`, which the slice truncated to `1406555123` and rendered
// as `(140) 655-5123`. Ten digits, so BOTH the client guard and the server
// guard (`length >= 10`) waved it through: a plausible-looking, permanently
// WRONG phone number silently written to Airtable.
//
// Phone is not decoration. It is the REQUIRED second channel added after Vale
// Creek Ranch signed up with a typo'd email, hard-bounced, and became
// unreachable with nobody alerted (see /api/apply's phone guard). A corrupted
// number recreates that exact failure while looking healthy in the grid — the
// worst possible shape for a backstop.
//
// Rule: strip a leading US country code `1` when (and only when) the digit
// string is 11 digits starting with 1. Never truncate before that check.
//
// Pure. No imports, no I/O — fully unit-tested (lib/phoneFormat.test.ts).

/**
 * Digits of a US phone number, country code removed.
 *
 * `1 (406) 555-1234` → `4065551234`. A bare 10-digit number is unchanged.
 * Anything longer than a US number (an international entry, a fat-fingered
 * paste) is left intact rather than truncated — the validity check below is
 * what rejects it, so we never invent a wrong-but-valid-looking number.
 */
export function normalizePhoneDigits(raw: string | null | undefined): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  // ONLY the US country-code case. `1` + 10 digits is unambiguous; an 11-digit
  // string starting with anything else is not a US number with a country code.
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

/**
 * True when `raw` carries a usable phone number (US country code optional).
 *
 * Shared shape of every client guard and every server guard.
 *
 * Deliberately `>= 10`, NOT `=== 10` — identical acceptance to the door guards
 * this replaces. Supply is BHC's only constraint, so a signup door must never
 * newly reject a rancher who used to get in (an extension, an international
 * number). The corruption this module fixes came from TRUNCATION, not from
 * lenient validation: formatPhoneInput now keeps every digit the rancher typed,
 * so a longer-than-US entry stays visibly itself instead of quietly becoming a
 * different, wrong, ten-digit number.
 */
export function isValidUsPhone(raw: string | null | undefined): boolean {
  return normalizePhoneDigits(raw).length >= 10;
}

/**
 * Progressive display formatter for a phone <input> (fires on every keystroke).
 *
 * Formats what the rancher has typed so far and tolerates a pasted `+1`:
 *   ''            → ''
 *   '40'          → '(40'
 *   '4065'        → '(406) 5'
 *   '4065551234'  → '(406) 555-1234'
 *   '14065551234' → '(406) 555-1234'
 *
 * Over-long input keeps its extra digits visible (appended after the formatted
 * ten) so the rancher can SEE that something is wrong and fix it — silently
 * dropping them is what caused the corruption in the first place.
 */
export function formatPhoneInput(raw: string | null | undefined): string {
  const d = normalizePhoneDigits(raw);
  if (d.length === 0) return '';
  if (d.length < 4) return `(${d}`;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  const core = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`;
  return d.length > 10 ? `${core}${d.slice(10)}` : core;
}
