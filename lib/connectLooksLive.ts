// lib/connectLooksLive.ts
//
// Detect the silent supply killer: a rancher who LOOKS live and receives NOTHING.
//
// THE STATE (verified live 2026-07-24 — three ranchers are in it right now):
//   Active Status = 'Active'  AND  Page Live = true  AND  Pricing Model =
//   'tier_v2'  AND  Stripe Connect Status != 'active'
//
// To the rancher and to the operator this reads as a fully live listing. But
// lib/rancherEligibility.ts (isRancherOperationalForBuyers) hard-requires
// Connect Status === 'active' for every tier_v2 rancher, so the matching engine
// drops them from the routing pool — silently, forever, with no alert. They get
// ZERO buyers and no one is told why.
//
//   5 Bar Beef (CA)      — blocks 281 waiting California buyers on its own
//   2M Cattle Co. (TN)
//   Rocky Ridge Livestock (ME)
//
// LEGACY RANCHERS ARE DELIBERATELY EXCLUDED. A non-tier_v2 rancher routes
// buyers to their own off-platform checkout and never touches the Connect
// deposit endpoint, so a non-active Connect status does NOT block them — the
// eligibility gate exempts them for exactly this reason. Alerting on them
// would page the operator about Gift Farms (OK), who is off Connect BY DESIGN.
//
// PURE + ZERO-IMPORT so it unit-tests under `npm test` (lib/**/*.test.ts).
// The cron that consumes it does the I/O.

export interface LooksLiveFinding {
  /** Airtable record id. */
  id: string;
  /** Ranch Name, else Operator Name, else the record id. */
  name: string;
  /** Two-letter state, or '' when unset. */
  state: string;
  /** Current cached Stripe Connect Status ('' when never set). */
  connectStatus: string;
  /** Whether a Connect account exists at all. */
  hasAccount: boolean;
  /** The SINGLE thing standing between them and buyers. */
  missingStep: string;
}

/** Airtable single-selects arrive as either a bare string or a `{ name }` object. */
function readEnum(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    const name = (v as any).name;
    return typeof name === 'string' ? name.trim() : '';
  }
  return String(v).trim();
}

/**
 * Select every rancher who looks live to the world but cannot receive a single
 * buyer because Stripe Connect never went active.
 *
 * Never throws on a malformed row — a bad record is skipped, not fatal, because
 * this runs inside a cron whose primary job must not be taken down by it.
 */
export function selectLooksLiveButBlocked(ranchers: unknown): LooksLiveFinding[] {
  if (!Array.isArray(ranchers)) return [];
  const out: LooksLiveFinding[] = [];

  for (const raw of ranchers) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as any;

    // Closed/removed accounts are already excluded from routing on purpose —
    // they are not a supply blocker, and their public page 404s.
    if (readEnum(r['Verification Status']) === 'Removed') continue;

    if (readEnum(r['Active Status']) !== 'Active') continue;
    if (!r['Page Live']) continue;

    // Connect only gates tier_v2. See the module header.
    if (readEnum(r['Pricing Model']).toLowerCase() !== 'tier_v2') continue;

    const connectStatus = readEnum(r['Stripe Connect Status']);
    if (connectStatus.toLowerCase() === 'active') continue;

    const hasAccount = !!String(r['Stripe Connect Account Id'] || '').trim();
    const missingStep = !hasAccount
      ? 'Has never started Stripe Connect — no account exists yet.'
      : connectStatus.toLowerCase() === 'restricted'
        ? 'Stripe Connect is RESTRICTED — Stripe is blocking on outstanding requirements.'
        : 'Stripe Connect onboarding was started but never finished (stuck mid-KYC).';

    out.push({
      id: String(r.id || ''),
      name: String(r['Ranch Name'] || r['Operator Name'] || r.id || 'Unknown rancher').trim(),
      state: readEnum(r['State']),
      connectStatus: connectStatus || '(none)',
      hasAccount,
      missingStep,
    });
  }

  return out;
}

/**
 * Stable per-rancher dedupe key for the operator signal.
 *
 * Keyed on the rancher ONLY (not the status), so a rancher oscillating between
 * 'onboarding' and 'restricted' can't slip a fresh page through the window.
 */
export function looksLiveDedupeKey(id: string): string {
  return `connect-looks-live:${id}`;
}
