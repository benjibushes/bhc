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
//   • Active Status === 'Active'           — admin gating
//   • Agreement Signed === true             — legal: must have signed
//   • Onboarding Status === 'Live' (or '')  — onboarding finished
//
// Page Live is NOT a routing requirement — it's a UX flag that the rancher's
// public landing page is published. Routing happens via email; if the buyer
// asks for the page and it's not up yet, the rancher's intro email still
// reaches them. Tying routing to Page Live just hides ready ranchers behind
// a flag that operators forget to flip.
//
// Capacity is intentionally NOT checked here — it's caller-dependent (hot-lead
// bypass, etc.). This function answers "is this rancher live + signed up?",
// not "can they take one more right now?"

import { normalizeState, normalizeStates } from './states';

export type RancherFields = Record<string, unknown> & {
  'Active Status'?: unknown;
  'Agreement Signed'?: unknown;
  'Onboarding Status'?: unknown;
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
 */
export function isRancherOperationalForBuyers(rancher: RancherFields): boolean {
  const active = readEnumOrString(rancher['Active Status']);
  if (active !== 'Active') return false;

  const onboarding = readEnumOrString(rancher['Onboarding Status']);
  if (onboarding && onboarding !== 'Live') return false;

  if (!rancher['Agreement Signed']) return false;

  return true;
}

/**
 * Returns the deduped 2-letter state codes a rancher serves (primary State +
 * any States Served entries). All comparisons against buyer state should run
 * through this so 'Montana' vs 'MT' typos can't strand customers.
 */
export function getOperationalServedStates(rancher: RancherFields): string[] {
  const out = new Set<string>();
  const primary = normalizeState(rancher['State']);
  if (primary) out.add(primary);
  for (const s of normalizeStates(rancher['States Served'] || '')) out.add(s);
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
