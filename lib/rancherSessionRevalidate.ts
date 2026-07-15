// lib/rancherSessionRevalidate.ts
//
// Wave C (2026-07-14) — pure decision logic for the rancher-session 24h
// re-validation. Pre-fix, resolveRancherSession only verified the JWT: status
// checks lived solely at login time, so removing a Team Email, marking a
// rancher Non-Compliant, or closing the account NEVER cut existing access —
// a fired ranch hand kept owner-privilege access (buyer PII, earnings CSV,
// request-deposit, email edits) for the remaining life of a 30-day cookie,
// with no revocation mechanism short of rotating JWT_SECRET platform-wide.
//
// The fix is deliberately CHEAP: the session cookie carries a revalidatedAt
// claim, and only when it (or iat, for pre-fix cookies) is older than 24h
// does the resolver do ONE Airtable read, re-check the verdict below, and
// re-mint the cookie. A warm-instance memory cache absorbs the case where
// the cookie can't be re-set. Revocation latency drops from 30 days to at
// most one day — with zero added Airtable reads on the hot path.
//
// PURE — no IO, no Next imports. Unit-tested in
// lib/rancherSessionRevalidate.test.ts.

export const SESSION_REVALIDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Airtable singleSelects arrive as plain strings or {name} objects. */
function readEnumOrString(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

/**
 * Is this session's last validation older than the 24h window?
 * `revalidatedAt` is ms (stamped by the resolver on each re-mint); pre-fix
 * cookies lack it and fall back to the JWT's iat (seconds). A claim-less,
 * iat-less token (shouldn't exist) always revalidates — fail toward checking.
 */
export function needsRevalidation(
  decoded: { revalidatedAt?: unknown; iat?: unknown },
  nowMs: number,
): boolean {
  const reval = Number(decoded?.revalidatedAt);
  const iatMs = Number(decoded?.iat) * 1000;
  const last = isFinite(reval) && reval > 0 ? reval : isFinite(iatMs) && iatMs > 0 ? iatMs : 0;
  if (!last) return true;
  return nowMs - last >= SESSION_REVALIDATE_INTERVAL_MS;
}

export interface RevalidationVerdict {
  ok: boolean;
  /** 401-ish (membership) vs 403-ish (status) is the caller's concern; the
   *  reason string is for logs/debugging only. */
  reason?: 'rancher-missing' | 'account-closed' | 'non-compliant' | 'email-removed' | 'session-email-missing';
}

/**
 * Re-check a live session against the CURRENT rancher row.
 *  - Verification Status='Removed' (closed account) → out.
 *  - Active Status='Non-Compliant' (admin removal-for-cause) → out.
 *  - session email must still be the rancher's Email or in Team Emails
 *    (same split as login: whitespace/comma/semicolon/newline). Team Emails
 *    is rancher-editable and advertised for "spouse, hired help" — deleting
 *    an entry must actually revoke that person's access.
 *  - Admin impersonation sessions skip the membership check (the admin's
 *    email is intentionally not on the row).
 */
export function sessionRevalidationVerdict(
  rancher: Record<string, unknown> | null | undefined,
  session: { email?: string | null; impersonatedBy?: string | null },
): RevalidationVerdict {
  if (!rancher) return { ok: false, reason: 'rancher-missing' };
  if (readEnumOrString(rancher['Verification Status']) === 'Removed') {
    return { ok: false, reason: 'account-closed' };
  }
  if (readEnumOrString(rancher['Active Status']) === 'Non-Compliant') {
    return { ok: false, reason: 'non-compliant' };
  }
  if (session.impersonatedBy) return { ok: true };
  const email = String(session.email || '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'session-email-missing' };
  const primary = String(rancher['Email'] || '').trim().toLowerCase();
  const team = String(rancher['Team Emails'] || '')
    .split(/[\s,;\n]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (email !== primary && !team.includes(email)) {
    return { ok: false, reason: 'email-removed' };
  }
  return { ok: true };
}
