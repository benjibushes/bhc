// Pure decision + shape logic for the self-serve deposit ("reserve") path.
// The thin route (app/api/checkout/reserve/route.ts) does the Airtable I/O
// and session minting; everything testable lives here.

import { isRancherOnConnect, isRancherOperationalForBuyers } from '@/lib/rancherEligibility';
import { MIN_TIER_PRICE } from '@/lib/pricing';

export type Cut = 'quarter' | 'half' | 'whole';

export const CUT_LABELS: Record<Cut, string> = {
  quarter: 'Quarter Cow',
  half: 'Half Cow',
  whole: 'Whole Cow',
};

const CUT_PRICE_FIELD: Record<Cut, string> = {
  quarter: 'Quarter Price',
  half: 'Half Price',
  whole: 'Whole Price',
};

// Mirrors lib/tiers.ts tierFor() normalization, inlined so this module stays
// hermetic — importing @/lib/tiers transitively pulls lib/secrets, which throws
// at module load when prod env is absent and breaks the unit test. A rancher
// with no valid Tier 409s at the deposit endpoint (route.ts:120-123), so the
// reserve gate must reject it too (else the buyer dead-ends at deposit).
const VALID_TIER_NAMES = new Set(['pasture', 'ranch', 'operator', 'legacy connect', 'legacy_connect']);
function hasValidTier(rancher: any): boolean {
  const raw = rancher?.['Tier'];
  const tierStr = raw && typeof raw === 'object' && 'name' in raw ? String(raw.name) : (raw ?? '');
  return VALID_TIER_NAMES.has(String(tierStr).toLowerCase().trim());
}

/**
 * Normalize a US phone to E.164 (+1XXXXXXXXXX). Returns '' when it can't be
 * coerced into a plausible number. Inlined (not imported from lib/twilio) so
 * this module stays hermetic — importing lib/twilio instantiates the SMS
 * client at module load and would break the unit test in a bare env.
 * Mirrors lib/twilio.ts::normalizeToE164.
 */
export function normalizeReservePhone(input: unknown): string {
  if (!input) return '';
  const digits = String(input).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return '';
}

export type ReserveEligibility =
  | { ok: true }
  | { ok: false; status: number; error: string; fallback?: boolean };

/**
 * Gate a reserve attempt so the buyer never bounces at the deposit page.
 * Mirrors the deposit route's own gates (app/api/checkout/deposit/route.ts:
 * 108-126, 183-193) but fails BEFORE we create anything.
 */
export function assertReserveEligible(rancher: any, cut: Cut): ReserveEligibility {
  if (!CUT_LABELS[cut]) {
    return { ok: false, status: 400, error: 'cut must be quarter|half|whole' };
  }
  if (!isRancherOnConnect(rancher)) {
    return {
      ok: false,
      status: 409,
      error: 'This rancher takes orders through our standard flow.',
      fallback: true, // client falls back to the lead form / quiz
    };
  }
  if (!isRancherOperationalForBuyers(rancher)) {
    return {
      ok: false,
      status: 409,
      error: 'This rancher is not taking orders right now.',
      fallback: true,
    };
  }
  // The deposit endpoint 409s when the rancher has no Tier (route.ts:120-123).
  // The Connect webhook flips Pricing Model=tier_v2 on activation but does NOT
  // set Tier, so a Connect-active rancher can have a blank Tier — reserve would
  // otherwise succeed then dead-end at deposit. Gate it so the client falls back.
  if (!hasValidTier(rancher)) {
    return {
      ok: false,
      status: 409,
      error: 'This rancher is not set up for online deposit yet.',
      fallback: true,
    };
  }
  const price = Number(rancher[CUT_PRICE_FIELD[cut]]) || 0;
  if (price < MIN_TIER_PRICE) {
    return {
      ok: false,
      status: 409,
      error: 'That share is not priced for online deposit yet.',
      fallback: true,
    };
  }
  return { ok: true };
}

/**
 * Airtable field set for the Consumer minted by the reserve rail (no quiz).
 *
 * `Status: 'Approved'` is load-bearing (buyer-trust tail #2): the member auth
 * gates (app/api/auth/member/login + /verify) only admit Status in
 * ['approved','active','waitlisted']. The reserve rail previously created the
 * Consumer with NO Status — the buyer could pay a deposit, then every magic
 * link 302'd them to /access?reason=not-approved (an unexplained quiz) and
 * the login route silently sent a "still under review" email. Mirrors
 * /api/consumers, whose deriveStatus() unconditionally returns 'Approved' for
 * funnel signups — a buyer putting money down is at least as approved.
 */
export function buildReserveConsumerFields(args: {
  slug: string;
  cut: Cut;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string;
  buyerState?: string;
  /**
   * Normalized 5-digit US ZIP (output of normalizeZip) or ''/undefined. Written
   * to Consumers.`Zip` only when present — the route never passes an
   * unnormalized value, so a malformed ZIP can't reach the record.
   */
  buyerZip?: string;
  smsOptIn: boolean;
  /**
   * T2.2 (2026-07-02): VALIDATED affiliate code (output of
   * validateAffiliateRefForSignup — normalized, existence/Active-checked,
   * self-referral-blocked). Non-empty → stamped 'Referred By' so the upstream
   * affiliate is credited at Closed Won. The reserve rail is where success-
   * page share links land; without this stamp every shared reservation lost
   * its attribution.
   */
  referredBy?: string;
  nowIso?: string;
}): Record<string, any> {
  const nowIso = args.nowIso || new Date().toISOString();
  return {
    ...(args.referredBy ? { 'Referred By': args.referredBy } : {}),
    'Full Name': args.buyerName || '',
    'Email': args.buyerEmail,
    'Phone': args.buyerPhone,
    ...(args.buyerState ? { 'State': args.buyerState } : {}),
    ...(args.buyerZip ? { 'Zip': args.buyerZip } : {}),
    'Segment': 'Beef Buyer',
    'Status': 'Approved',
    'Approved At': nowIso,
    'Source': `rancher-page-deposit:${args.slug}`,
    'Order Type': CUT_LABELS[args.cut],
    // FIX (store-reserve 500): 'Interest Beef' is a singleLineText field —
    // writing boolean `true` 422'd Airtable (typecast can't coerce bool→text),
    // the catch returned 500, and reserve aborted BEFORE the referral was
    // created → EVERY new store buyer's deposit failed. The real,
    // read-everywhere field is 'Interests' (multipleSelects); match the main
    // funnel (/api/consumers). typecast auto-creates 'Beef'.
    'Interests': ['Beef'],
    'Intent Score': 90,
    'Intent Classification': 'High',
    // SMS consent (TCPA): seed the checkbox explicitly on a brand-new Consumer
    // so the Twilio gate starts in a known state; stamp the consent time only
    // on a real opt-in. Mirrors /api/consumers ~545.
    'SMS Opt-In': args.smsOptIn,
    ...(args.smsOptIn ? { 'SMS Opt-In At': nowIso } : {}),
  };
}

// Statuses the member login/verify gates accept (mirrors LOGIN_ALLOWED in
// app/api/auth/member/{login,verify}/route.ts — keep in sync).
const RESERVE_LOGIN_ALLOWED = new Set(['approved', 'active', 'waitlisted']);

/**
 * Patch for an EXISTING Consumer adopted by the reserve rail. Blank/'Pending'
 * statuses are promoted to 'Approved' so the reserve magic link can actually
 * log them in (see buildReserveConsumerFields rationale). Already-allowed
 * statuses are left untouched, and anything else (e.g. 'Rejected') is a
 * deliberate admin decision the reserve rail must not undo — those buyers
 * still reach support, they just don't get silently re-approved.
 */
export function reserveConsumerStatusPatch(
  existingStatus: unknown,
  nowIso?: string,
): Record<string, any> {
  const s = String(existingStatus ?? '').trim().toLowerCase();
  if (RESERVE_LOGIN_ALLOWED.has(s)) return {}; // already able to log in
  if (s === '' || s === 'pending') {
    return { 'Status': 'Approved', 'Approved At': nowIso || new Date().toISOString() };
  }
  // Any other status (e.g. 'Rejected') is deliberate — no silent re-approval.
  return {};
}

/**
 * Airtable field set for a deposit-intent referral. Pins Rancher + Buyer so
 * the deposit route's ownership + rancher lookup succeed. Deliberately omits
 * 'Approval Status' so it is NOT treated as a callback lead.
 */
export function buildReserveReferralFields(args: {
  rancher: any;
  consumerId: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone?: string;
  buyerState?: string;
  cut: Cut;
}): Record<string, any> {
  const ranchName = String(args.rancher['Ranch Name'] || args.rancher['Operator Name'] || 'Rancher');
  const who = args.buyerName || args.buyerEmail;
  const fields: Record<string, any> = {
    Name: `${who} → ${ranchName} · ${CUT_LABELS[args.cut]}`,
    Status: 'Pending',
    'Match Type': 'Direct (Rancher Page) — Deposit',
    'Buyer Name': args.buyerName || '',
    'Buyer Email': args.buyerEmail,
    'Order Type': CUT_LABELS[args.cut],
    'Intent Score': 90,
    'Intent Classification': 'High',
    Notes: '[Source] Self-serve deposit (rancher page, no quiz)',
    Rancher: [args.rancher.id],
    Buyer: [args.consumerId],
  };
  // Denormalize the buyer's phone + state onto the referral so the rancher can
  // call the moment the deposit lands (the whole promise of this rail). Only
  // write when present so we never blank an existing value on re-create.
  const phone = String(args.buyerPhone || '').trim();
  if (phone) fields['Buyer Phone'] = phone;
  const state = String(args.buyerState || '').trim();
  if (state) fields['Buyer State'] = state;
  return fields;
}

/**
 * Resolve the buyer's best phone + state for a rancher notification. Prefers the
 * values denormalized onto the referral; falls back to the linked Consumer
 * record so historical referrals (created before phone/state capture) still
 * surface a click-to-call number. Pure — callers pass already-fetched rows.
 */
export function resolveBuyerContact(
  referral: Record<string, any> | null | undefined,
  consumer?: Record<string, any> | null,
): { phone: string; state: string } {
  const refPhone = String(referral?.['Buyer Phone'] || '').trim();
  const refState = String(referral?.['Buyer State'] || '').trim();
  const conPhone = String(consumer?.['Phone'] || '').trim();
  const conState = String(consumer?.['State'] || '').trim();
  return {
    phone: refPhone || conPhone,
    state: refState || conState,
  };
}

export function depositPathFor(referralId: string, cut: Cut): string {
  return `/checkout/${referralId}/deposit?cut=${cut}`;
}
