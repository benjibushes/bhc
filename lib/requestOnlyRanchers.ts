// lib/requestOnlyRanchers.ts
//
// REQUEST-ONLY SUPPLY — the single source of truth for "this rancher is
// never handed to a buyer generically" (Ben, explicit and repeated; first
// written down 2026-08-12 for campaign waves, extended to the LIVE MATCHER
// 2026-08-17 after an audit found the wave rule was honored in exactly one
// of the two engines).
//
// A request-only rancher is SPECIALTY supply. Rep Provisions is the
// grass-finished option: premium-priced, deliberately scarce, and sold to
// buyers who came looking for it. A buyer reaches them by ASKING — opening
// their public page, or arriving on their pinned deep-link. They must NEVER
// be:
//   • a NATIONWIDE / generic fallback match. Their `Admin Approved
//     Multi-State` + `Ships Nationwide` flags put them in the fallback
//     candidate pool for every uncovered state, and the buyer-fit gate
//     (lib/nationwideFit) passes anyone with a big enough budget — so an
//     uncovered-state buyer with zero grass-finished interest was one
//     sufficient budget away from being routed here. That is the forbidden
//     fallback, and paid traffic would hit it at volume.
//   • a generic LOCAL / in-state match. Their home + routing states would
//     otherwise hand them every nearby buyer who never asked for
//     grass-finished — the same violation with a smaller blast radius.
//   • a campaign-wave FIRST TOUCH (lib/campaignWaves state table).
//
// What stays OPEN by design — this list gates the GENERIC path only:
//   • their public rancher page and everything sold from it,
//   • the pinned deep-link / stored Campaign pin (`?campaign=rancher-<slug>`
//     → the direct-match block in app/api/matching/suggest). A buyer who
//     asked for THIS rancher still gets them; that is the whole point of a
//     request-only rancher having a link at all,
//   • any route an operator drives by hand.
//
// ADDING A SLUG HERE EXCLUDES THAT RANCHER FROM BOTH ENGINES AT ONCE — the
// live matcher (app/api/matching/suggest: local pool, nationwide fallback,
// and the shared base eligibility gate) and the campaign-wave state table
// (lib/campaignWaves). Removing a slug re-opens both. There is no third
// list; if you find one, delete it and import this.
//
// Kept hermetic on purpose — zero imports, no Airtable, no env — so an
// edge-adjacent API route and a pure lib can both pull it without dragging
// a dependency graph along.

/**
 * Slugs of ranchers reachable only by explicit buyer request.
 * Airtable `Ranchers.Slug` values (verbatim field name — the same one
 * app/api/matching/suggest and lib/campaignWaves already read).
 */
export const REQUEST_ONLY_RANCHER_SLUGS: ReadonlySet<string> = new Set([
  // Grass-finished specialty supply (Ben, 2026-08-12).
  'rep-provisions',
]);

/**
 * Resolve a rancher record's slug the way every other read path does:
 * the `Slug` field, stringified and trimmed. Never guessed — see
 * lib/campaignWaves.rancherForStateTable and the direct-pin block in
 * app/api/matching/suggest, which read the identical field.
 */
function slugOf(rancher: unknown): string {
  const raw = (rancher as Record<string, unknown> | null | undefined)?.['Slug'];
  return String(raw ?? '').trim();
}

/**
 * Is this rancher request-only — i.e. must NEVER win a generic match?
 *
 * Pure: reads only the record passed in, no network, no env. Comparison is
 * case-insensitive so a slug typed `Rep-Provisions` in Airtable can't slip
 * the gate; that only ever TIGHTENS the exclusion (the direct-pin path
 * resolves slugs separately and is deliberately untouched).
 *
 * A record with no slug is NOT request-only — it is unroutable for other
 * reasons already, and this gate stays narrow on purpose.
 */
export function isRequestOnlyRancher(rancher: unknown): boolean {
  const slug = slugOf(rancher).toLowerCase();
  return slug !== '' && REQUEST_ONLY_RANCHER_SLUGS.has(slug);
}
