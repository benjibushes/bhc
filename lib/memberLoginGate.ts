// lib/memberLoginGate.ts
//
// Pure decisions for the member magic-link login gate
// (app/api/auth/member/login/route.ts). Extracted 2026-07-29 to close the
// PORTAL LOCKOUT: a rancher-added lead (My Leads CRM #511) is created with a
// deliberately BLANK Consumer 'Status', so after paying a deposit the login
// allowlist ['approved','active','waitlisted'] rejected them and mailed
// "application still under review" — a PAYING buyer locked out of /member
// forever once the 48h deposit-grant cookie died.
//
// Two-layer fix:
//   1. lib/stripeSettlement.payingBuyerConsumerPatch backfills Status='Approved'
//      at deposit-settle (the writer).
//   2. THIS gate (the belt): blank-Status logins get ONE extra referral lookup —
//      if any referral for this email has 'Deposit Paid At', they're allowed in.
//      Only the blank-Status path pays the lookup; the hot path stays one query.

/** Statuses that may log in without any further checks (lowercased). */
export const LOGIN_ALLOWED_STATUSES = ['approved', 'active', 'waitlisted'] as const;

/** Normalize an Airtable Status (string or {name} enum object) for comparison. */
export function normalizeStatus(status: unknown): string {
  return String((status as any)?.name || status || '').trim().toLowerCase();
}

export function isLoginAllowedStatus(status: unknown): boolean {
  return (LOGIN_ALLOWED_STATUSES as readonly string[]).includes(normalizeStatus(status));
}

/**
 * Whether a not-allowed status warrants the paid-referral fallback lookup.
 * ONLY blank — 'pending' is a real value an admin can act on, and 'rejected'
 * is a deliberate decision the belt must never route around.
 */
export function shouldCheckPaidReferralFallback(status: unknown): boolean {
  return normalizeStatus(status) === '';
}

/**
 * Given the referral rows fetched for the buyer's email, is any of them a
 * paid deposit? (Airtable date fields can come back as '' when unset.)
 */
export function hasPaidDepositReferral(referrals: any[]): boolean {
  if (!Array.isArray(referrals)) return false;
  return referrals.some((r) => String(r?.['Deposit Paid At'] || '').trim() !== '');
}
