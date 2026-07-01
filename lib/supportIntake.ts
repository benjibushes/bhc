// Support intake validation — pure helpers for /api/support/report.
//
// A distressed PAYING buyer previously had only a raw mailto (to a domain the
// inbound pipeline doesn't watch): zero record, zero Telegram, zero SLA.
// This module is the shape gate for the /support form's POST body. It is
// deliberately import-clean (no Airtable, no secrets, no next/*) so it can be
// unit-tested with `npx tsx --test lib/supportIntake.test.ts`.

export const SUPPORT_CATEGORIES = [
  'order-issue',
  'refund-request',
  'rancher-unresponsive',
  'quality-claim',
  'other',
] as const;

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const MESSAGE_MIN = 10;
export const MESSAGE_MAX = 2000;

export interface NormalizedSupportReport {
  email: string;
  category: SupportCategory;
  message: string;
  /** Airtable Referrals record id (rec + 14 alphanumerics), or undefined. */
  referralId?: string;
}

export type SupportReportValidation =
  | { ok: true; normalized: NormalizedSupportReport }
  | { ok: false; error: string };

// Same pragmatic shape used elsewhere in the funnel: local@domain.tld, no
// whitespace, at least one dot in the domain. RFC-perfect validation is a
// tarpit; the real gate is "can we reply to this address".
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;

// Canonical Airtable record id: "rec" + 14 alphanumeric chars.
const REC_ID_RE = /^rec[a-zA-Z0-9]{14}$/;

/**
 * Validate + normalize a raw support-report body (already JSON-parsed).
 *
 * - email: required, trimmed, lowercased, shape-checked
 * - category: enum with 'other' fallback (never rejects — a distressed buyer
 *   with a weird category value still gets through)
 * - message: required, trimmed, 10-2000 chars
 * - referralId: kept only when it looks like a real rec-id; otherwise silently
 *   dropped (never a reason to reject the report)
 */
export function validateSupportReport(body: unknown): SupportReportValidation {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Invalid request body' };
  }
  const b = body as Record<string, unknown>;

  const emailRaw = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!emailRaw) {
    return { ok: false, error: 'Please include your email address so we can reply.' };
  }
  if (emailRaw.length > EMAIL_MAX || !EMAIL_RE.test(emailRaw)) {
    return { ok: false, error: 'That email address does not look right — please double-check it.' };
  }

  const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (message.length < MESSAGE_MIN) {
    return { ok: false, error: 'Please tell us a bit more about the problem (at least a sentence) in the message.' };
  }
  if (message.length > MESSAGE_MAX) {
    return { ok: false, error: `That message is too long — please keep it under ${MESSAGE_MAX} characters.` };
  }

  const categoryRaw = typeof b.category === 'string' ? b.category.trim().toLowerCase() : '';
  const category: SupportCategory = (SUPPORT_CATEGORIES as readonly string[]).includes(categoryRaw)
    ? (categoryRaw as SupportCategory)
    : 'other';

  let referralId: string | undefined;
  if (typeof b.referralId === 'string') {
    const candidate = b.referralId.trim();
    if (REC_ID_RE.test(candidate)) referralId = candidate;
  }

  return { ok: true, normalized: { email: emailRaw, category, message, referralId } };
}
