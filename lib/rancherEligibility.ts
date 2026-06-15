// Single source of truth for "can this rancher receive a buyer right now?"
//
// Before this lived in 4+ places that quietly drifted apart:
//   - app/api/consumers/route.ts (signup-time waitlist gate)
//   - app/api/matching/suggest/route.ts (match engine)
//   - app/api/cron/rancher-launch-warmup/route.ts (Page Live=TRUE filter)
//   - lib/bulkRoute.ts (just Active Status)
//
// Drift caused real customer pain: ranchers with Active=Active +
// Onboarding=Live + Agreement Signed (e.g. ZK Ranches in TN, DD Ranch in OR)
// were rejected by the signup gate (because Page Live wasn't toggled), but
// accepted by the match engine. Buyers in those states got sent to waitlist
// emails despite an operational rancher serving them. 48 stranded.
//
// The unified rule:
//   • Active Status === 'Active'                    — admin gating
//   • Agreement Signed === true                      — legal: must have signed
//   • Onboarding Status === 'Live' (or '')           — onboarding finished
//   • Subscription Status NOT in past_due|unpaid|    — Stripe collections gate
//     canceled (active/trialing/'' all pass)
//
// Page Live is NOT a routing requirement — it's a UX flag that the rancher's
// public landing page is published. Routing happens via email; if the buyer
// asks for the page and it's not up yet, the rancher's intro email still
// reaches them. Tying routing to Page Live just hides ready ranchers behind
// a flag that operators forget to flip.
//
// Subscription Status gate (2026-05-27): mirrors the 409 gate in
// /api/checkout/deposit/route.ts. Without this, matching/suggest routed
// buyers to ranchers in past_due/unpaid/canceled state — rancher took the
// call, then buyer hit a 409 wall at deposit time. Broken experience. The
// deposit endpoint stays as a defense-in-depth backstop, but the primary
// fix is excluding these ranchers from the routing pool upstream. Active,
// trialing, and empty/unset values all pass (legacy ranchers predating
// subscription flow have no value).
//
// Capacity is intentionally NOT checked here — it's caller-dependent (hot-lead
// bypass, etc.). This function answers "is this rancher live + signed up?",
// not "can they take one more right now?"

import { normalizeState, normalizeStates } from './states';

export type RancherFields = Record<string, unknown> & {
  'Active Status'?: unknown;
  'Agreement Signed'?: unknown;
  'Onboarding Status'?: unknown;
  'Subscription Status'?: unknown;
  'Pricing Model'?: unknown;
  'Stripe Connect Status'?: unknown;
  'State'?: unknown;
  'States Served'?: unknown;
};

function readEnumOrString(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

/**
 * True iff the rancher is operationally ready to receive a buyer match.
 * Use this everywhere — signup gates, match filters, warmup queries.
 *
 * Gates (all must pass):
 *   - Active Status === 'Active'
 *   - Onboarding Status === 'Live' (or empty/unset)
 *   - Agreement Signed === true
 *   - Subscription Status NOT in past_due|unpaid|canceled. Active, trialing,
 *     and empty/unset all pass. Mirrors the deposit 409 gate so we never
 *     route a buyer to a rancher whose deposit would be blocked downstream.
 *   - tier_v2 ONLY: Stripe Connect Status === 'active'. Legacy (non-tier_v2)
 *     ranchers are exempt — they checkout off-platform and never hit the
 *     Connect deposit endpoint. Mirrors the deposit 409 gate (Connect not
 *     active → buyer dead-ends at deposit time).
 */
export function isRancherOperationalForBuyers(rancher: RancherFields): boolean {
  const active = readEnumOrString(rancher['Active Status']);
  if (active !== 'Active') return false;

  const onboarding = readEnumOrString(rancher['Onboarding Status']);
  if (onboarding && onboarding !== 'Live') return false;

  if (!rancher['Agreement Signed']) return false;

  // Subscription Status gate. Mirrors /api/checkout/deposit/route.ts so we
  // don't route buyers to ranchers whose deposit endpoint would 409 them.
  // Active, trialing, and unset values all pass — only the Stripe collections
  // states (past_due, unpaid, canceled) exclude.
  const subStatus = String(rancher['Subscription Status'] || '').toLowerCase();
  if (subStatus === 'past_due' || subStatus === 'unpaid' || subStatus === 'canceled') {
    return false;
  }

  // Stripe Connect gate — tier_v2 ONLY (2026-06-15). tier_v2 buyers pay via
  // the platform deposit endpoint, which hard-requires Stripe Connect
  // Status==='active' (app/api/checkout/deposit/route.ts:123 → 409 otherwise).
  // Without this gate, a tier_v2 rancher mid-onboarding (Connect='onboarding')
  // gets routed buyers + a deposit link, then the buyer hits a 409 wall at
  // deposit time — a dead-end conversion. Mirror the deposit endpoint here so
  // these ranchers are excluded from the routing pool until Connect is live.
  //
  // Legacy ranchers (Pricing Model != tier_v2, e.g. Payment Link model) are
  // INTENTIONALLY exempt: they route buyers to their own off-platform checkout
  // on /ranchers/[slug] and never touch the Connect deposit endpoint, so a
  // Connect status (which they may not even have) must NOT gate them.
  const pricingModel = String(rancher['Pricing Model'] || '').toLowerCase();
  if (pricingModel === 'tier_v2') {
    const connectStatus = String(rancher['Stripe Connect Status'] || '').toLowerCase();
    if (connectStatus !== 'active') return false;
  }

  return true;
}

/**
 * Returns the deduped 2-letter state codes a rancher serves.
 *
 * HOME-STATE GATE (2026-05-13): default behavior is HOME STATE ONLY. Multi-
 * state coverage requires admin opt-in via the `Admin Approved Multi-State`
 * boolean. Without the boolean, even a populated Routing States list is
 * ignored. Prevents bulk-imported nationwide lists, accidental dashboard
 * over-shares, or rancher-edited Preferred States from silently routing
 * cross-state. Matches the gate in app/api/matching/suggest/route.ts so
 * the signup-time "rancher available in your state?" check stays consistent.
 */
export function getOperationalServedStates(rancher: RancherFields): string[] {
  const out = new Set<string>();
  const primary = normalizeState(rancher['State']);
  if (primary) out.add(primary);
  const approved = !!(rancher as any)['Admin Approved Multi-State'];
  if (approved) {
    // Prefer Routing States (admin-controlled); fall back to legacy States Served.
    const routing = String((rancher as any)['Routing States'] || rancher['States Served'] || '');
    for (const s of normalizeStates(routing)) out.add(s);
  }
  return Array.from(out);
}

/**
 * Convenience: does any rancher in the list serve `buyerState`?
 * Used by the signup-time gate to decide ready-to-buy-prompt vs waitlist.
 */
export function hasOperationalRancherForState(
  ranchers: RancherFields[],
  buyerState: unknown
): boolean {
  const stateNorm = normalizeState(buyerState);
  if (!stateNorm) return false;
  return ranchers.some((r) => {
    if (!isRancherOperationalForBuyers(r)) return false;
    const served = getOperationalServedStates(r);
    return served.includes(stateNorm);
  });
}
