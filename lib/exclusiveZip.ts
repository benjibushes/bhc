// lib/exclusiveZip.ts
//
// EXCLUSIVE-ZIP HARD GATE (2026-07-23, founder directive: Ben signed an
// EXCLUSIVE Houston/Austin supplier — Thomas Cattle & Catering).
//
// A rancher with `Service ZIP Prefixes` set serves ONLY buyers whose ZIP starts
// with one of those prefixes (Thomas = "77" for Houston; add "78" if Austin is
// confirmed). This is a HARD eligibility gate that runs BEFORE any
// distance/radius logic — a buyer outside the service ZIPs must NEVER route to
// the exclusive rancher, on any path (local, nationwide, direct pin, or the
// admin deposit-invoice send).
//
// Fail CLOSED: a rancher WITH prefixes is ineligible for a buyer we can't place
// inside them — no ZIP, malformed ZIP, or out-of-prefix ZIP all exclude. The
// only fall-through is when the rancher has NO gate (empty prefixes), which is
// every non-exclusive rancher and preserves today's behavior byte-for-byte.
//
// Pure string logic. The only import is normalizeZip from ./zipFormat (NOT
// ./zipCentroids — we deliberately avoid dragging the 1 MB centroid table onto
// this hot path; a prefix match needs the ZIP string, never a centroid).

import { normalizeZip } from './zipFormat';

/** The subset of a Ranchers row this module reads. Loose — whole rows pass through. */
export interface ServiceZipRow {
  'Service ZIP Prefixes'?: unknown;
}

/**
 * Parse the comma-separated `Service ZIP Prefixes` field into a clean list.
 *
 * Digits-only tokens survive; anything else (blank cells, stray words, typos
 * like "7a") is dropped so a garbled field can never widen the gate — a
 * malformed prefix must reduce coverage, never accidentally match extra ZIPs.
 */
export function parseServiceZipPrefixes(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  return String(raw)
    .split(',')
    .map((p) => p.trim())
    .filter((p) => /^\d+$/.test(p));
}

/** True when this rancher exclusively serves a set of ZIP prefixes. */
export function hasServiceZipGate(rancher: ServiceZipRow | null | undefined): boolean {
  if (!rancher) return false;
  return parseServiceZipPrefixes(rancher['Service ZIP Prefixes']).length > 0;
}

/**
 * Is this buyer's ZIP inside the rancher's exclusive service area?
 *
 *  - No gate (empty/garbage prefixes) ⇒ true. Non-exclusive ranchers are
 *    unaffected; the buyer falls through to the existing radius/state gates.
 *  - Gate set + buyer ZIP starts with a prefix ⇒ true (served).
 *  - Gate set + buyer ZIP out-of-prefix ⇒ false (excluded).
 *  - Gate set + no/malformed buyer ZIP ⇒ false (FAIL CLOSED — never route a
 *    ZIP-unknown buyer to a ZIP-gated exclusive rancher).
 */
export function buyerZipServedBy(buyerZip: unknown, rancher: ServiceZipRow | null | undefined): boolean {
  const prefixes = parseServiceZipPrefixes(rancher?.['Service ZIP Prefixes']);
  if (prefixes.length === 0) return true; // no restriction
  const zip = normalizeZip(buyerZip);
  if (!zip) return false; // fail closed: gated rancher, but we can't place the buyer
  return prefixes.some((p) => zip.startsWith(p));
}
