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
 * REC-ID BELT (F10, Wave 1 rails hardening 2026-08-18). The slug set alone
 * left two holes: a slug RENAME in Airtable silently dropped the protection,
 * and any config that names the RECORD ID directly (the demand-router's
 * DEMAND_CAMPAIGN_RANCHER_IDS pool env) never consulted the slug at all —
 * Rep Provisions' record id in that env would have armed a generic campaign
 * pool with zero request-only guard. Same policy, second key: consumed
 * alongside the slug set everywhere the slug set is consumed
 * (isRequestOnlyRancher below checks BOTH), plus directly wherever only an
 * id is on hand (demand-router resolveSlot). Airtable record ids are
 * case-sensitive — matched verbatim, trimmed only.
 */
export const REQUEST_ONLY_RANCHER_IDS: ReadonlySet<string> = new Set([
  // Rep Provisions (grass-finished specialty supply — Ben, 2026-08-12).
  'recYE5zpedhPg6KIV',
]);

/**
 * Is this Airtable record id a request-only rancher? Pure; empty/garbage ids
 * are NOT request-only (the gate stays narrow on purpose).
 */
export function isRequestOnlyRancherId(id: unknown): boolean {
  const s = String(id ?? '').trim();
  return s !== '' && REQUEST_ONLY_RANCHER_IDS.has(s);
}

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
 * Checks BOTH keys of the same policy: the slug set AND the record-id belt
 * (F10) — a slug rename in Airtable must never drop the protection, so every
 * existing call site (live matcher, campaign-wave table, launch warmup)
 * inherits the id belt through this one function.
 *
 * A record with neither a listed slug nor a listed id is NOT request-only —
 * this gate stays narrow on purpose.
 */
export function isRequestOnlyRancher(rancher: unknown): boolean {
  const slug = slugOf(rancher).toLowerCase();
  if (slug !== '' && REQUEST_ONLY_RANCHER_SLUGS.has(slug)) return true;
  const id = (rancher as Record<string, unknown> | null | undefined)?.['id'];
  return isRequestOnlyRancherId(id);
}
