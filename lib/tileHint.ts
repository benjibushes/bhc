// lib/tileHint.ts
//
// What to tell the operator when a dashboard tile has no number.
//
// "This integration is not configured" and "the read that feeds this tile blew
// up" are different problems with different fixes, and answering the second
// with the first sends whoever is debugging to the wrong system entirely.
//
// That is not hypothetical. The /admin command-center's Email Sends read had
// outgrown its 10s Airtable timeout (8,698 rows / 14.3s) and threw on EVERY
// dashboard load. Because the failure collapsed into the same empty state as
// "unconfigured", the tile rendered "enable Resend open/click tracking to
// populate" — confident, plausible, and pointing at Resend, which was working
// fine. The real fault went unnoticed until someone measured the query.
//
// So: a failed read gets its OWN words, and they say plainly that this is not
// a settings problem.

export interface TileState {
  /** True when the underlying read THREW. Distinct from "returned nothing". */
  unavailable?: boolean;
  /** The genuine "you haven't set this up yet" copy. */
  hint: string;
}

export const READ_FAILED_HINT =
  "couldn't load — the read failed, check server logs (this is NOT a settings problem)";

export function hintFor(tile: TileState): string {
  return tile.unavailable ? READ_FAILED_HINT : tile.hint;
}
