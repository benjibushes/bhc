// lib/agreementAudit.ts
//
// E-sign audit trail for the rancher agreement — pure helpers shared by both
// sign paths (app/api/ranchers/sign-agreement POST + app/api/rancher/activate
// one-tap flow). Writes the Ranchers fields `Signature IP`,
// `Signature User Agent`, and `Agreement Version` (schema-only until
// 2026-07-28 — zero writers existed, see docs/WRITE-MAP.md).
//
// INVARIANT: a missing/hostile header must NEVER block signing — fields are
// omitted, never thrown.

/**
 * Version tag stamped into `Agreement Version` at e-sign time.
 *
 * '2026-04-legacy' = the agreement text live since the April launch (predates
 * versioning — hence "legacy"). BUMP THIS when Ben lands the /terms legal
 * rewrite (the deprecated invoice model is still referenced there) so
 * signatures made against the new text are distinguishable from old ones.
 */
export const AGREEMENT_VERSION = '2026-04-legacy';

// Airtable long-text is effectively unbounded, but a UA is identification
// noise past a few hundred chars — cap it so a hostile 100KB header can't
// bloat the record.
const MAX_UA_LENGTH = 500;

/**
 * Build the e-sign audit fields from request headers.
 *
 * - `Signature IP`: first hop of `x-forwarded-for` (the client, per Vercel's
 *   proxy chain), falling back to `x-real-ip`. Omitted when neither exists.
 * - `Signature User Agent`: `user-agent`, truncated to 500 chars. Omitted
 *   when missing.
 * - `Agreement Version`: always AGREEMENT_VERSION (repo truth, not
 *   request-derived).
 *
 * Accepts anything Headers-shaped (`request.headers`). Never throws.
 */
export function signatureAuditFields(
  headers: { get(name: string): string | null } | null | undefined,
): Record<string, string> {
  const fields: Record<string, string> = { 'Agreement Version': AGREEMENT_VERSION };
  try {
    const get = (name: string): string => {
      try {
        return String(headers?.get(name) ?? '').trim();
      } catch {
        return '';
      }
    };
    const firstHop = get('x-forwarded-for').split(',')[0]?.trim() || '';
    const ip = firstHop || get('x-real-ip');
    if (ip) fields['Signature IP'] = ip;
    const ua = get('user-agent');
    if (ua) fields['Signature User Agent'] = ua.slice(0, MAX_UA_LENGTH);
  } catch {
    // Never let audit-trail capture block a signature.
  }
  return fields;
}
