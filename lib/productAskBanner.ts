// lib/productAskBanner — when does the products form show its ask-banner?
//
// The #623 edit-wall fix asks a rancher for EVERY missing legacy answer up
// front (ships-in days + shipping choice, the two answers pre-#524 listings
// never captured) instead of one prose 400 per save. But it keyed visibility
// on `editingId` alone, which missed two flows:
//
//   1. DUPLICATE: startDuplicate seeds the form from an existing product but
//      sets editingId=null (the save POSTs a new row). A copy of a legacy
//      listing carries the same blanks — with no banner, the rancher
//      rediscovered each blocker one rejected save at a time.
//   2. ANY 400-with-missing: the API's validator returns the full `missing`
//      set on rejection, and save() used to throw it away, showing only the
//      prose `error`.
//
// This helper is the ONE decision the banner and the red field marks derive
// from. Pure + import-clean (client component safe), same pattern as
// lib/rancherSetupLinkDelivery / lib/syncManagedProductFence.
//
// Content is always the LIVE `openAsks` recompute (the same
// missingRequiredAnswers helper the API validates with, so the two cannot
// drift): an answer clears its banner line the moment it is typed, no save
// round-trip needed. `rejectedMissing` (the last 400's `missing` payload) and
// `seededFromExisting` only decide VISIBILITY. A truly blank add form — not
// editing, not seeded, never rejected — stays banner-free: its `*` markers
// already say what's required, and a warning over an empty form is noise.

import type { MissingAnswer } from './rancherProductInput';

export function askBannerAsks(opts: {
  /** Editing an existing row (editingId non-null) — the original #623 case. */
  editing: boolean;
  /** Form was seeded from an existing product via Duplicate (editingId null). */
  seededFromExisting: boolean;
  /** `missing` from the last 400 this form session, [] until one happens. */
  rejectedMissing: readonly MissingAnswer[];
  /** Live missingRequiredAnswers() recompute of the current form values. */
  openAsks: readonly MissingAnswer[];
}): MissingAnswer[] {
  const { editing, seededFromExisting, rejectedMissing, openAsks } = opts;
  if (!editing && !seededFromExisting && rejectedMissing.length === 0) return [];
  return [...openAsks];
}
