import { getAllRecords, createRecord, updateRecord, TABLES, escapeAirtableValue } from './airtable';

/**
 * Canonical affiliate-code normalization. ALL writes and ALL lookups MUST
 * funnel through this so case + whitespace can never drift apart.
 *
 * Codes are stored + compared lowercase. URL `?ref=BENJI` and `?ref=benji`
 * both resolve to the same affiliate. Stops silent referral loss when a
 * partner shares their link via a copy-pasted SMS that auto-capitalized
 * the first letter.
 */
export function normalizeAffiliateCode(raw: string | null | undefined): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

/**
 * Pick a random suffix so two affiliates named "Ben" don't share a code.
 * Tries up to 20 times to avoid collisions with existing codes before
 * surrendering — by which point Math.random() being non-unique is the least
 * of our problems.
 */
export async function generateAffiliateCode(name: string): Promise<string> {
  const base = (name.split(' ')[0] || 'bhc').toLowerCase().replace(/[^a-z]/g, '') || 'bhc';
  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = Math.random().toString(36).slice(2, 6);
    const candidate = `${base}${suffix}`;
    try {
      const existing = await getAllRecords(
        TABLES.AFFILIATES,
        `{Code} = "${escapeAirtableValue(candidate)}"`,
      );
      if (existing.length === 0) return candidate;
    } catch {
      // Table missing or rate-limited — fall back to the unchecked candidate.
      return candidate;
    }
  }
  // Pathological collision territory — append timestamp suffix to guarantee
  // uniqueness even if Math.random() has been corrupted somehow.
  return `${base}${Date.now().toString(36).slice(-6)}`;
}

/**
 * Look up an affiliate by code (case-insensitive). Returns the raw Airtable
 * record OR null. Status check is NOT applied here — callers decide whether
 * Inactive affiliates are acceptable for their use case (e.g. dashboard
 * login should reject, but historical attribution lookups should succeed).
 */
export async function findAffiliateByCode(rawCode: string): Promise<any | null> {
  const code = normalizeAffiliateCode(rawCode);
  if (!code) return null;
  try {
    const rows = (await getAllRecords(
      TABLES.AFFILIATES,
      `{Code} = "${escapeAirtableValue(code)}"`,
    )) as any[];
    return rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * Validate a `?ref=CODE` URL parameter before stamping it on a Consumer or
 * Rancher record. Returns normalized code OR empty string. Rejects:
 *   - Missing/non-string/too-long values
 *   - Codes that don't exist
 *   - Codes whose Status != 'Active'
 *   - Self-referrals: if `selfEmail` is provided AND matches the affiliate's
 *     own email, the ref is silently dropped (prevents commission farming)
 */
export async function validateAffiliateRefForSignup(
  rawRef: string | null | undefined,
  selfEmail?: string | null,
): Promise<string> {
  const code = normalizeAffiliateCode(rawRef);
  if (!code || code.length > 50) return '';

  const aff = await findAffiliateByCode(code);
  if (!aff) return '';

  const status = String(aff['Status'] || '').toLowerCase();
  if (status !== 'active') return '';

  if (selfEmail) {
    const affEmail = String(aff['Email'] || '').trim().toLowerCase();
    if (affEmail && affEmail === selfEmail.trim().toLowerCase()) {
      // Self-referral — silently drop. Don't tell the affiliate so they
      // can't iterate around the block.
      return '';
    }
  }

  return code;
}

/**
 * Increment Click Count + stamp Last Click At for an affiliate. Idempotency
 * is the caller's concern (e.g. session-scoped sessionStorage flag on the
 * client). On failure the function logs + returns false — never throws,
 * since a click-tracking miss should not break the landing page render.
 */
export async function recordAffiliateClick(rawCode: string): Promise<boolean> {
  try {
    const aff = await findAffiliateByCode(rawCode);
    if (!aff) return false;
    const status = String(aff['Status'] || '').toLowerCase();
    if (status !== 'active') return false;
    const current = Number(aff['Click Count']) || 0;
    await updateRecord(TABLES.AFFILIATES, aff.id, {
      'Click Count': current + 1,
      'Last Click At': new Date().toISOString(),
    });
    return true;
  } catch (err: any) {
    console.error('[recordAffiliateClick] failed:', err?.message);
    return false;
  }
}

export { createRecord };
