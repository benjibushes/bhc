// Pure go-live gate logic — the ONE contract every go-live rail checks.
//
// Before this, go-live was a 2×2 of half-rails:
//   - POST /api/admin/ranchers/[id]/go-live gated Stripe Connect (409+force)
//     but NEVER checked Agreement Signed and never emailed the rancher.
//   - PATCH /api/admin/ranchers/[id] with onboarding_status='Live' ("Mark
//     Live" / handleRelease) gated NOTHING — one click could mint a Live
//     rancher who can't route (unsigned → matching excludes them) or can't
//     collect (tier_v2 with Connect not active → deposit 409s buyers).
//
// This file is import-clean (no Airtable/email/Telegram) so the gates are
// unit-testable and safe to import from client components (admin UI buttons
// use isReadyToGoLive to only OFFER Go Live when the server would accept it).
// The I/O rail — writes + side effects — lives in lib/goLiveRancher.ts.

export type GoLiveGateCode =
  | 'rancher_not_found'
  | 'agreement_not_signed'
  | 'connect_not_active'
  | 'verification_pending';

export type GoLiveGateResult =
  | { ok: true }
  | { ok: false; code: GoLiveGateCode; message: string };

/** Airtable-shaped rancher record (raw field names). */
export type RancherRecordLike = Record<string, unknown>;

/**
 * The canonical go-live write — the union of the 4 status fields the two
 * legacy rails wrote between them (POST /go-live wrote all 4; PATCH "Mark
 * Live" wrote the first 3 and skipped Status):
 *   - 'Active Status': 'Active'   — matching/suggest + routing eligibility gate
 *   - 'Onboarding Status': 'Live' — routing requires Live (or empty)
 *   - 'Page Live': true           — publishes /ranchers/[slug]
 *   - 'Status': 'Active'          — application status; mirrors /api/rancher/activate
 */
export const GO_LIVE_FIELDS = {
  'Page Live': true,
  'Active Status': 'Active',
  'Onboarding Status': 'Live',
  'Status': 'Active',
} as const;

// Airtable single-selects sometimes arrive as {name: '...'} objects.
// Mirrors lib/rancherEligibility.ts readEnumOrString.
function readEnumOrString(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

function displayName(rancher: RancherRecordLike): string {
  return (
    readEnumOrString(rancher['Operator Name']) ||
    readEnumOrString(rancher['Ranch Name']) ||
    'This rancher'
  );
}

/**
 * True iff the rancher is already fully live (all go-live fields converged
 * on the Live state that matters operationally). Status ('Approved' vs
 * 'Active') is intentionally NOT checked — routing never reads it, and we
 * don't want a legacy 'Approved' value to re-fire warmup/email side effects
 * on every idempotent go-live call.
 */
export function isAlreadyLive(rancher: RancherRecordLike): boolean {
  return (
    readEnumOrString(rancher['Onboarding Status']) === 'Live' &&
    readEnumOrString(rancher['Active Status']) === 'Active' &&
    rancher['Page Live'] === true
  );
}

/**
 * Evaluate the go-live gates against a raw Airtable rancher record.
 * force=true overrides ALL gates (operator escape hatch — e.g. a
 * legacy-Connect rancher mis-tagged tier_v2).
 *
 * Gate order (first failure wins):
 *   1. Agreement Signed truthy — matching requires it; unsigned + Live =
 *      silently receives zero buyers.
 *   2. tier_v2 → Stripe Connect Status === 'active' — deposits 409 otherwise.
 *      Legacy ranchers are EXEMPT (off-platform Payment Links).
 *   3. Onboarding Status !== 'Verification Pending' — don't skip an
 *      in-flight verification review. ('Docs Sent' is implicitly blocked by
 *      gate 1: docs-sent ranchers are unsigned.)
 */
export function goLiveGates(
  rancher: RancherRecordLike,
  force = false,
): GoLiveGateResult {
  if (force) return { ok: true };

  const name = displayName(rancher);

  // 1 — Agreement Signed
  if (!rancher['Agreement Signed']) {
    return {
      ok: false,
      code: 'agreement_not_signed',
      message:
        `${name} can't go live yet — the partner agreement isn't signed. ` +
        `Matching requires Agreement Signed, so they'd display as Live but silently receive zero buyers. ` +
        `Send/resend the agreement (or Mark Agreement Signed if it was signed offline), then retry. Pass force=true to override.`,
    };
  }

  // 2 — Stripe Connect (tier_v2 only)
  const pricingModel = readEnumOrString(rancher['Pricing Model']).toLowerCase() || 'legacy';
  const connectRaw = readEnumOrString(rancher['Stripe Connect Status']);
  if (pricingModel === 'tier_v2' && connectRaw.toLowerCase() !== 'active') {
    return {
      ok: false,
      code: 'connect_not_active',
      message:
        `${name} can't go live yet — Stripe Connect status is "${connectRaw || 'unset'}", not "active". ` +
        `tier_v2 ranchers take deposits via Stripe Connect, so they'd display as Live but couldn't accept money. ` +
        `Have them finish Stripe Connect onboarding (or use Resync), then retry. Pass force=true to override.`,
    };
  }

  // 3 — Verification not in-flight
  if (readEnumOrString(rancher['Onboarding Status']) === 'Verification Pending') {
    return {
      ok: false,
      code: 'verification_pending',
      message:
        `${name} can't go live yet — a verification request is still pending review. ` +
        `Approve it (Mark Verification Complete) or resolve it first. Pass force=true to override.`,
    };
  }

  return { ok: true };
}

// ─── Admin-UI adapters (snake_case view model) ─────────────────────────────

/** The subset of the admin ranchers-list view model the predicate needs. */
export type GoLiveRancherView = {
  agreement_signed?: boolean;
  pricing_model?: string;
  stripe_connect_status?: string;
  onboarding_status?: string;
};

function viewToRecord(r: GoLiveRancherView): RancherRecordLike {
  return {
    'Agreement Signed': !!r.agreement_signed,
    'Pricing Model': r.pricing_model || 'legacy',
    'Stripe Connect Status': r.stripe_connect_status || '',
    'Onboarding Status': r.onboarding_status || '',
  };
}

/**
 * Human-readable list of what's blocking go-live for an admin-view rancher.
 * Empty array = ready. Runs the SAME gates as the server (no drift) but
 * accumulates all blockers instead of stopping at the first.
 */
export function goLiveBlockersView(r: GoLiveRancherView): string[] {
  const record = viewToRecord(r);
  const blockers: string[] = [];
  if (!record['Agreement Signed']) blockers.push('agreement not signed');
  const pricingModel = String(record['Pricing Model']).toLowerCase();
  const connect = String(record['Stripe Connect Status']).toLowerCase();
  if (pricingModel === 'tier_v2' && connect !== 'active') {
    blockers.push(`Stripe Connect ${connect || 'unset'} (needs active)`);
  }
  if (record['Onboarding Status'] === 'Verification Pending') {
    blockers.push('verification review pending');
  }
  return blockers;
}

/**
 * Shared UI predicate: only OFFER a Go Live button when the server-side
 * gates would accept the click. signed + connect-ok-or-legacy +
 * verification not pending.
 */
export function isReadyToGoLive(r: GoLiveRancherView): boolean {
  return goLiveGates(viewToRecord(r)).ok;
}
