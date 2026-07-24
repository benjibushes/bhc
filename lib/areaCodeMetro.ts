// lib/areaCodeMetro.ts
//
// Phone area-code → Texas metro, for the ZIP-gathering campaign (2026-07-23).
//
// ~248 legacy TX WAITING buyers have no ZIP, so distance/exclusive-ZIP routing
// can't place them. Before we ask them to confirm a ZIP, we shortlist the ones
// whose PHONE area code already puts them in the exclusive supplier's metro —
// a cheap, offline pre-filter that keeps the ask relevant (and the send small).
//
// Area-code → metro is a heuristic, never a routing decision: it only decides
// WHO to ask. The authoritative gate is still the confirmed ZIP (lib/exclusiveZip).
//
// Pure. Area-code sets from the founder directive; keep them explicit so the
// mapping is auditable, not buried in a regex.

/** Houston metro overlay codes (713/281/832/346) + Galveston-Beaumont (409) + Brazos Valley (979). */
export const HOUSTON_AREA_CODES = ['713', '281', '832', '346', '409', '979'] as const;
/** Austin metro (512/737) + Central-TX / Hill Country (830). */
export const AUSTIN_AREA_CODES = ['512', '737', '830'] as const;

export type TxMetro = 'houston' | 'austin';

/**
 * The 3-digit area code of a US phone number, or null when it isn't one.
 *
 * Accepts the messy real-world forms Airtable holds — "(713) 555-1234",
 * "713-555-1234", "+1 713 555 1234", bare "7135551234". Strips to digits,
 * drops a leading US country "1" on 11-digit numbers, and only trusts a clean
 * 10-digit result. Anything else (short, foreign 12-digit, junk) → null, so a
 * non-US number can never be mis-read as a Texas one.
 */
export function areaCodeOf(phone: unknown): string | null {
  if (phone === null || phone === undefined) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  return digits.slice(0, 3);
}

/**
 * Which TX metro this phone's area code belongs to, or null.
 * null means "don't shortlist" — never a guess.
 */
export function metroFromPhone(phone: unknown): TxMetro | null {
  const ac = areaCodeOf(phone);
  if (!ac) return null;
  if ((HOUSTON_AREA_CODES as readonly string[]).includes(ac)) return 'houston';
  if ((AUSTIN_AREA_CODES as readonly string[]).includes(ac)) return 'austin';
  return null;
}
