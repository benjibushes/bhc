// lib/connectPrefill.ts
//
// Build the Stripe Connect prefill payload from what BHC ALREADY KNOWS.
//
// THE DEFECT THIS EXISTS TO KILL (verified live against Stripe 2026-07-24):
// 12 ranchers started Stripe Connect; only 6 finished. All five stalled
// accounts (5 Bar Beef, 2M Cattle, Rep Provisions, Rocky Ridge, Gift Farms)
// died at the IDENTICAL point — `tos_acceptance.date: null`, i.e. Stripe
// SCREEN ONE. None of them ever reached bank details or SSN. Every one of the
// five carried the same five `past_due` requirements:
//
//     business_profile.product_description
//     business_profile.support_phone
//     business_profile.url
//     tos_acceptance.date
//     tos_acceptance.ip
//
// THREE of those five are fields BHC already holds on the Ranchers row (the
// landing page we built them, their About text, the phone we require at
// signup). We were making ranchers retype data we own, on the exact screen
// where they quit. A rancher who DID complete it (Foodstead) took 203 seconds.
// This is a hand-off defect, not a rancher problem.
//
// The remaining two (`tos_acceptance.*`) are deliberately NOT prefilled:
// accepting Stripe's terms on a rancher's behalf is theirs to do, legally.
//
// PURE + ZERO-IMPORT so it unit-tests under the repo's standard `npm test`
// harness (lib/**/*.test.ts) with no Stripe client and no secrets chain.
// Everything here is best-effort by construction: a missing or junk value
// yields `undefined` for that key and the caller simply omits it — prefill
// must NEVER block Connect account creation.

/** Safe fallback when a rancher hasn't written their About text yet. */
export const DEFAULT_PRODUCT_DESCRIPTION =
  'Direct-to-consumer beef — quarter, half and whole shares, sold direct from the ranch';

/** Stripe truncates long descriptions; keep well inside the limit. */
const MAX_PRODUCT_DESCRIPTION = 500;
const MAX_DBA = 250;

/**
 * The prefill values, in BHC terms. The Stripe-shaped mapping (which of these
 * becomes `defaults.profile.business_url` vs `configuration.merchant.support
 * .phone`) lives in lib/stripeConnect.ts so this module stays API-agnostic.
 *
 * Every field is optional EXCEPT `productDescription`, which always has a
 * usable value (the rancher's About text, else the default above).
 */
export interface ConnectPrefill {
  /** → defaults.profile.business_url — the BHC landing page we built them. */
  businessUrl?: string;
  /** → configuration.merchant.support.url — same page (public support surface). */
  supportUrl?: string;
  /** → defaults.profile.product_description. Always present. */
  productDescription: string;
  /** → configuration.merchant.support.phone. E.164; omitted when unusable. */
  supportPhone?: string;
  /** → identity.business_details.phone. Same value; omitted when unusable. */
  businessPhone?: string;
  /** → configuration.merchant.support.email. Omitted when not a valid address. */
  supportEmail?: string;
  /** → defaults.profile.doing_business_as — the trading name, NOT a legal name. */
  doingBusinessAs?: string;
}

/**
 * Airtable single-selects and some linked reads arrive as `{ name }` objects
 * rather than bare strings. Read either shape, never throw.
 */
function readStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    const name = (v as any).name;
    return typeof name === 'string' ? name.trim() : '';
  }
  return String(v).trim();
}

/**
 * US phone → E.164 (`+1XXXXXXXXXX`), or null when the value can't be trusted.
 *
 * Returns null (rather than a guess) for anything that isn't unambiguously a
 * ten-digit US number, because a plausible-but-wrong support phone published
 * on a rancher's Stripe account is worse than no phone at all — and Stripe
 * rejects malformed values, which would fail the whole account write.
 *
 * Deliberately NOT imported from lib/phoneFormat.ts: that module's
 * `isValidUsPhone` is `>= 10` digits (correct for a signup door, which must
 * never newly reject a rancher), whereas Stripe needs an exactly-valid NANP
 * number. An 11+ digit international entry is omitted here, never truncated
 * into a different, wrong number.
 */
function toE164Us(raw: unknown): string | undefined {
  const digits = readStr(raw).replace(/\D/g, '');
  // Strip a US country code only in the unambiguous `1` + 10 digits case.
  const core = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (core.length !== 10) return undefined;
  // Repeated-digit placeholders (0000000000, 1111111111 — including the
  // hardcoded placeholder this module replaces) are not real numbers.
  if (/^(\d)\1{9}$/.test(core)) return undefined;
  // NANP area codes never start with 0 or 1.
  if (core[0] === '0' || core[0] === '1') return undefined;
  return `+1${core}`;
}

/**
 * Slug → public BHC landing page, but ONLY for a bare path segment.
 *
 * A slug holding a full URL, a slash, or whitespace would build a broken or
 * traversing link; Stripe would either reject it or publish a dead URL on the
 * rancher's account. Omit instead.
 */
function landingPageUrl(rancher: any, siteUrl: string): string | undefined {
  const slug = readStr(rancher?.['Slug']);
  if (!slug) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) return undefined;
  const base = String(siteUrl || '').replace(/\/+$/, '');
  if (!base) return undefined;
  return `${base}/ranchers/${slug}`;
}

function cleanDescription(raw: unknown): string {
  const collapsed = readStr(raw).replace(/\s+/g, ' ').trim();
  if (!collapsed) return DEFAULT_PRODUCT_DESCRIPTION;
  return collapsed.length > MAX_PRODUCT_DESCRIPTION
    ? collapsed.slice(0, MAX_PRODUCT_DESCRIPTION).trim()
    : collapsed;
}

function cleanEmail(raw: unknown): string | undefined {
  const v = readStr(raw);
  // Deliberately strict-ish: this address is PUBLIC on the rancher's Stripe
  // account (buyer receipts, disputes). Garbage in that slot is worse than none.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : undefined;
}

/**
 * Build the prefill payload for a rancher's Stripe Connect account.
 *
 * NEVER throws — a null record, a missing field, or a junk value degrades to
 * an omitted key. The caller spreads only the defined keys onto the Stripe
 * params, so a bad record produces a plain (pre-fix) account rather than a
 * failed one.
 *
 * Field names are the EXACT Ranchers column names (verified against the base
 * schema): 'Slug', 'About Text', 'Phone', 'Email', 'Ranch Name'.
 */
export function buildConnectPrefill(rancher: any, siteUrl: string): ConnectPrefill {
  const r = rancher && typeof rancher === 'object' ? rancher : {};
  const url = landingPageUrl(r, siteUrl);
  const phone = toE164Us(r['Phone']);
  const dba = readStr(r['Ranch Name']).slice(0, MAX_DBA) || undefined;

  return {
    ...(url ? { businessUrl: url, supportUrl: url } : {}),
    productDescription: cleanDescription(r['About Text']),
    ...(phone ? { supportPhone: phone, businessPhone: phone } : {}),
    ...(cleanEmail(r['Email']) ? { supportEmail: cleanEmail(r['Email']) } : {}),
    ...(dba ? { doingBusinessAs: dba } : {}),
  };
}

/**
 * True when there is anything worth sending to Stripe beyond the default
 * description. Lets the caller skip a pointless account-update round trip on
 * a rancher record we know nothing about.
 */
export function hasMeaningfulPrefill(p: ConnectPrefill): boolean {
  return !!(
    p.businessUrl ||
    p.supportPhone ||
    p.supportEmail ||
    p.doingBusinessAs ||
    p.productDescription !== DEFAULT_PRODUCT_DESCRIPTION
  );
}
