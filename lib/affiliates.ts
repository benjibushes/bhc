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
 *
 * Case-insensitivity matters because self-serve signup mints UPPERCASE codes
 * (e.g. `9NQBDE`) while admin codes from generateAffiliateCode are lowercase
 * (e.g. `benji4f2k`). Without LOWER() the lookup matches one style or the
 * other but not both, and tracking silently no-ops for the missing style.
 */
export async function findAffiliateByCode(rawCode: string): Promise<any | null> {
  const code = normalizeAffiliateCode(rawCode);
  if (!code) return null;
  try {
    const rows = (await getAllRecords(
      TABLES.AFFILIATES,
      `LOWER({Code}) = "${escapeAirtableValue(code)}"`,
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
 *   - Phone-based self-referrals: if `selfPhone` is provided AND its digit-only
 *     form matches the affiliate's stored phone, ref is dropped. Closes the
 *     `me+sock@x.com` loophole — an affiliate could previously sign up under a
 *     fresh email but keep the same phone and farm commission off themselves.
 *
 * Accepts either the old positional `selfEmail` argument OR a structured
 * `{ email, phone }` object. Positional form preserved for the older callers
 * that haven't been threaded for phone yet (typecheck stays clean during the
 * audit's incremental rollout).
 */
export async function validateAffiliateRefForSignup(
  rawRef: string | null | undefined,
  selfEmailOrOpts?: string | null | { email?: string | null; phone?: string | null },
): Promise<string> {
  const code = normalizeAffiliateCode(rawRef);
  if (!code || code.length > 50) return '';

  const aff = await findAffiliateByCode(code);
  if (!aff) return '';

  const status = String(aff['Status'] || '').toLowerCase();
  if (status !== 'active') return '';

  // Normalize positional/object call signatures.
  let selfEmail: string | null | undefined;
  let selfPhone: string | null | undefined;
  if (typeof selfEmailOrOpts === 'string' || selfEmailOrOpts === null || selfEmailOrOpts === undefined) {
    selfEmail = selfEmailOrOpts as string | null | undefined;
  } else {
    selfEmail = selfEmailOrOpts.email;
    selfPhone = selfEmailOrOpts.phone;
  }

  if (selfEmail) {
    const affEmail = String(aff['Email'] || '').trim().toLowerCase();
    if (affEmail && affEmail === selfEmail.trim().toLowerCase()) {
      // Self-referral — silently drop. Don't tell the affiliate so they
      // can't iterate around the block.
      return '';
    }
  }

  if (selfPhone) {
    const normalizedSelf = String(selfPhone).replace(/\D/g, '');
    if (normalizedSelf) {
      const affPhone = String(aff['Phone'] || '').replace(/\D/g, '');
      if (affPhone && affPhone === normalizedSelf) {
        // Phone-based self-referral — silently drop. Same rationale as email.
        return '';
      }
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

/**
 * Auto-enroll a Closed Won buyer as an affiliate (I-9 audit).
 *
 * Why: every Closed Won buyer is a potential referrer, but the affiliate
 * program was operator-provisioned only. Flywheel dormant. This auto-creates
 * an affiliate row at Closed Won w/ a unique 6-char alphanumeric code.
 *
 * Idempotent — if the buyer already has an affiliate row (by email match),
 * no-op + return the existing code. Buyer's Consumer row gets stamped
 * `Affiliate Created At` so we have an audit trail + don't double-fire.
 *
 * Returns:
 *   { code: string; existing: boolean } on success
 *   null on any failure (caller logs but never blocks Closed Won path)
 */
export async function ensureBuyerAffiliate(args: {
  consumerId: string;
  email: string;
  fullName?: string;
}): Promise<{ code: string; existing: boolean } | null> {
  const email = (args.email || '').trim().toLowerCase();
  if (!email) return null;

  try {
    // Idempotency by email — return existing code if any.
    const existing = (await getAllRecords(
      TABLES.AFFILIATES,
      `LOWER({Email}) = "${escapeAirtableValue(email)}"`,
    )) as any[];
    if (existing.length > 0) {
      const code = String(existing[0]['Code'] || '').trim();
      if (code) return { code, existing: true };
    }

    // Mint code — 6-char uppercase alphanumeric (matches /api/affiliates/signup
    // self-serve style; tweet-friendly, brand-anonymous).
    const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const randomCode = (len = 6): string => {
      let out = '';
      for (let i = 0; i < len; i++) {
        out += ALPHANUM[Math.floor(Math.random() * ALPHANUM.length)];
      }
      return out;
    };
    let code = randomCode();
    // Single collision retry — 36^6 = 2.2B keyspace.
    try {
      const collide = await getAllRecords(
        TABLES.AFFILIATES,
        `LOWER({Code}) = "${escapeAirtableValue(code.toLowerCase())}"`,
      );
      if (collide.length > 0) code = randomCode();
    } catch {
      // table missing — fall back to candidate
    }

    const fields: Record<string, any> = {
      'Email': email,
      'Code': code,
      'Status': 'Active',
      'Created At': new Date().toISOString(),
      'Source': 'auto-closed-won',
      'Linked Consumer': [args.consumerId],
    };
    if (args.fullName) {
      fields['Full Name'] = args.fullName;
      fields['Name'] = args.fullName;
    }
    try {
      await createRecord(TABLES.AFFILIATES, fields);
    } catch (err: any) {
      console.error('[ensureBuyerAffiliate] createRecord failed:', err?.message);
      return null;
    }
    return { code, existing: false };
  } catch (err: any) {
    console.error('[ensureBuyerAffiliate] lookup failed:', err?.message);
    return null;
  }
}

/**
 * Credit the referring affiliate when a Closed Won lands for a buyer they
 * sent. P3-D audit fix: previously `recordClose` only auto-enrolled the
 * NEW buyer as a future affiliate but never paid the upstream affiliate
 * who actually sent the buyer in the first place. The flywheel only spun
 * one direction.
 *
 * Commission is flat % of saleAmount, env-tunable via
 * AFFILIATE_COMMISSION_RATE (default 0.05). Stamped on the Affiliates row's
 * `Earnings Pending` aggregate — when that field doesn't exist on the schema
 * we swallow the write error and rely on the console log for operator
 * payout reconciliation.
 *
 * Fail-open everywhere: a missing affiliate, missing field, or Airtable
 * hiccup must never block the close path. Caller is expected to also
 * wrap in try/catch.
 *
 * TODO: add a proper `Affiliate Commissions` ledger table via Airtable MCP
 * so we have per-referral commission rows instead of a single aggregate
 * (lets us reverse a commission cleanly on refund/chargeback). For now the
 * Telegram-equivalent console log is the audit trail.
 */
export async function creditAffiliateOnClose(input: {
  code: string;
  referralId: string;
  rancherId: string;
  buyerId: string;
  saleAmount: number;
}): Promise<void> {
  if (!input.code || !Number.isFinite(input.saleAmount) || input.saleAmount <= 0) return;
  let affiliate: any = null;
  try {
    const code = normalizeAffiliateCode(input.code);
    if (!code) return;
    const rows = (await getAllRecords(
      TABLES.AFFILIATES,
      `LOWER({Code}) = "${escapeAirtableValue(code)}"`,
    )) as any[];
    affiliate = rows[0];
  } catch (e: any) {
    console.warn(`[creditAffiliateOnClose] lookup failed for code ${input.code}:`, e?.message);
    return;
  }
  if (!affiliate) {
    console.warn(`[creditAffiliateOnClose] no affiliate found for code ${input.code}`);
    return;
  }

  const rate = Number(process.env.AFFILIATE_COMMISSION_RATE || '0.05');
  const commissionDollars = Math.round(input.saleAmount * rate * 100) / 100;

  // Stamp commission earned on the Affiliates row (best-effort, fail-open).
  // For now we don't have an Affiliate Commissions ledger table — stamp the
  // aggregate on the Affiliates row instead. TODO above tracks the ledger work.
  const currentEarned = Number(affiliate['Earnings Pending'] || 0);
  try {
    await updateRecord(TABLES.AFFILIATES, affiliate.id, {
      'Earnings Pending': currentEarned + commissionDollars,
    });
  } catch (e: any) {
    console.warn(`[creditAffiliateOnClose] Earnings Pending write failed (field may not exist): ${e?.message}`);
  }

  // Operator alert — log line is the manual-payout trail until the ledger
  // table exists. Console log matches the format `bhc-ops` greps for.
  console.log(
    `[affiliate] ${input.code} earned $${commissionDollars} on ref=${input.referralId} (rancher=${input.rancherId})`,
  );
}

export { createRecord };
