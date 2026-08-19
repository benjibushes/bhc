// lib/publicRepresentGuard.ts
//
// What an ANONYMOUS POST to /api/partner/represent is allowed to do to a row
// that already exists in the Ranchers table.
//
// THE HOLE (2026-08-19). The route deduped by email against ANY row in
// Ranchers and then "upgraded" the match onto the broker rail: it set
// `Broker Rail = true` and overwrote Ranch Name, Operator Name, Phone, State
// and Ops Notes with attacker-supplied strings. No authentication of any kind.
//
// That is not a data-quality problem, it is a kill switch. lib/brokerRail's
// referralRailForRancher returns 'ambiguous' for a row that is BOTH broker-
// flagged and carrying a Connect footprint, and app/api/checkout/deposit
// refuses to charge on 'ambiguous' — by design, because a coin flip with
// money is not code's call. So one unauthenticated request naming a live
// Connect rancher's email takes that rancher offline for payments, and
// renames their ranch on the way out.
//
// The upgrade path itself is legitimate and must survive: Ben hand-enters
// prospects, and a represented seller signing up with an email already on a
// bare prospect row SHOULD land on the broker rail rather than silently
// duplicating (the previous bug: told he was represented, nothing written).
// So the rule is not "never touch an existing row" — it is "never touch one
// that has money wired to it".
//
// Pure. The route owns the Airtable I/O; this owns the decision.

import { rancherHasConnectAccount, isBrokerRancher } from './brokerRail';

export type RepresentDecision =
  /** No row for this email — create a fresh broker rancher. */
  | { action: 'create' }
  /** A bare prospect row — safe to put on the broker rail. */
  | { action: 'upgrade'; rancherId: string }
  /** Already represented — idempotent re-submit, refresh the note only. */
  | { action: 'already-broker'; rancherId: string }
  /**
   * Carries a Connect footprint. Flipping it would brick their checkout, so
   * the request is accepted at the door and handed to a human instead.
   */
  | { action: 'refuse-connect'; rancherId: string; reason: string };

/**
 * Decide what an anonymous represent submission may do with `existing`.
 * `existing` is null when no row matched the email.
 */
export function decideRepresent(
  existing: { id?: string; fields?: Record<string, unknown> } | Record<string, unknown> | null,
): RepresentDecision {
  if (!existing) return { action: 'create' };

  // Airtable rows reach this code in two shapes depending on the caller:
  // the raw REST record ({id, fields}) and lib/airtable's flattened form
  // ({id, ...fields}). Read through both rather than trusting one.
  const rec = existing as Record<string, any>;
  const fields: Record<string, unknown> =
    rec.fields && typeof rec.fields === 'object' ? (rec.fields as Record<string, unknown>) : rec;
  const rancherId = String(rec.id || '');

  // Connect footprint FIRST — it outranks everything, including an existing
  // broker flag. A row that is already ambiguous must not be made more so by
  // an anonymous write; it needs a human either way.
  if (rancherHasConnectAccount(fields)) {
    return {
      action: 'refuse-connect',
      rancherId,
      reason:
        'This ranch already takes card payments through BuyHalfCow. Flipping it to the represented-seller rail would stop its checkout working, so a person needs to look at it.',
    };
  }

  if (isBrokerRancher(fields)) return { action: 'already-broker', rancherId };

  return { action: 'upgrade', rancherId };
}
