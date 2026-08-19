// lib/prospectOptOut.ts
//
// Who is allowed to be delisted by the UNAUTHENTICATED opt-out door
// (POST /api/prospects/remove, page /ranchers/<slug>/remove).
//
// ── Why this module exists ────────────────────────────────────────────────
// The opt-out door is deliberately anonymous: the listings it removes were
// built from PUBLIC information about ranchers who never asked to be listed,
// so a real operator must be able to get off the map in one tap without
// proving anything to us. That is a legal-compliance posture, not an
// oversight, and it stays.
//
// What was an oversight: the door resolved its target by slug ALONE. Every
// slug on the platform is public (they are the /ranchers/<slug> URLs, and
// /api/public/ranchers lists them), and the write it performs —
// Verification Status = 'Removed' — is the single most destructive flag on a
// rancher record:
//   • lib/rancherEligibility.ts (isRancherOperationalForBuyers) returns false
//     on 'Removed', so the ranch stops receiving routed buyers entirely;
//   • app/api/auth/rancher/verify/route.ts refuses the magic-link login of a
//     'Removed' account, so the operator cannot even sign in to undo it;
//   • the public page 404s and Page Live is cleared.
// So the anonymous door could reach signed, paid, live partner accounts — not
// just the scraped listings it exists to retract.
//
// The fix keeps both properties the door needs at once:
//   1. a genuine unclaimed prospect can still opt out anonymously, and
//   2. nothing that represents a REAL relationship can be touched here.
//
// This module is the pure half of (2) so it can be unit-tested without
// Airtable. The route layer adds rate limiting and the operator tripwire.
//
// MIRRORS the sibling claim door (app/api/prospects/claim/route.ts), which
// already scopes its Airtable lookup to {Verification Status} = "Prospect".
// This predicate is deliberately STRICTER than that formula: a row can read
// as 'Prospect' and still be a live relationship (a represented/broker ranch
// carries an EMPTY Active Status by design and routes off isBrokerRoutable,
// and a mid-onboarding account can be sitting on a signed agreement or a
// Stripe Connect account before anyone flips it to 'Verified'). Each gate
// below is one of those "looks like a prospect, isn't" shapes.

import { BROKER_RAIL_FIELD } from './brokerRail';

/**
 * Airtable single-selects come back as a bare string on some reads and as
 * `{ name: 'Prospect' }` on others (linked/expanded reads). Same defensive
 * read as lib/rancherEligibility.ts — a gate that only understands one of the
 * two shapes silently fails OPEN, which is the whole bug class this file is
 * closing.
 */
function readEnumOrString(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object' && typeof (v as any).name === 'string') {
    return (v as any).name.trim();
  }
  return '';
}

/** Truthy for Airtable checkbox `true` and for the string 'true'. */
function readCheckbox(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return false;
}

export type ProspectOptOutVerdict =
  /** A genuine unclaimed prospect — honor the opt-out. */
  | { decision: 'allow' }
  /** Already off the map. Idempotent no-op: no write, no alert, no error. */
  | { decision: 'already-removed' }
  /** A real relationship. Refuse, and tell the operator someone tried. */
  | { decision: 'refuse'; reason: string };

/**
 * May this row be delisted by an anonymous caller?
 *
 * ALLOW requires ALL of:
 *   - Verification Status is exactly 'Prospect' (the scraped-listing state),
 *   - the ranch is not on the broker rail (a represented ranch is a signed
 *     relationship whose Active Status is empty BY DESIGN — the single most
 *     likely "reads like a prospect" false positive),
 *   - no signed agreement,
 *   - no explicit account lifecycle state (Active / At Capacity / Paused /
 *     Non-Compliant all mean a human account exists),
 *   - Onboarding Status is not 'Live',
 *   - no Stripe Connect account has been started.
 *
 * Unknown/absent row → refuse. Fails CLOSED on every path: a field we cannot
 * read is treated as "might be a real account", never as "safe to delete".
 */
export function prospectOptOutVerdict(row: unknown): ProspectOptOutVerdict {
  if (!row || typeof row !== 'object') return { decision: 'refuse', reason: 'no-record' };
  const r = row as Record<string, unknown>;

  const status = readEnumOrString(r['Verification Status']);

  // Idempotent: a second submit (double-click, retry, refresh) must not 403
  // at a prospect who already opted out, and must not re-alert the operator.
  if (status === 'Removed') return { decision: 'already-removed' };

  if (status !== 'Prospect') {
    return { decision: 'refuse', reason: `verification-status:${status || 'blank'}` };
  }

  // Represented (broker-rail) ranches: signed with Ben, phone-or-self-serve
  // routable, and their Active Status is intentionally left EMPTY — so every
  // "is this account live?" gate below would wave them through.
  if (readCheckbox(r[BROKER_RAIL_FIELD])) {
    return { decision: 'refuse', reason: 'broker-rail' };
  }

  if (r['Agreement Signed']) {
    return { decision: 'refuse', reason: 'agreement-signed' };
  }

  // Any explicit lifecycle value means a real account exists. Only blank and
  // 'Pending Onboarding' (the pre-account states a scraped row can legitimately
  // carry) fall through.
  const active = readEnumOrString(r['Active Status']);
  if (active && active !== 'Pending Onboarding') {
    return { decision: 'refuse', reason: `active-status:${active}` };
  }

  if (readEnumOrString(r['Onboarding Status']) === 'Live') {
    return { decision: 'refuse', reason: 'onboarding-live' };
  }

  // Any Connect state at all — 'onboarding' counts. A rancher who has started
  // Stripe has handed over identity documents; that is not a scraped listing.
  const connect = readEnumOrString(r['Stripe Connect Status']);
  if (connect) {
    return { decision: 'refuse', reason: `stripe-connect:${connect}` };
  }

  return { decision: 'allow' };
}
