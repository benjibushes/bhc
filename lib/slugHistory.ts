// lib/slugHistory.ts
//
// Slug-rename safety (dashboard-audit rank 10). A rancher renaming their
// live page used to silently 404 every link they'd ever shared (business
// cards, IG bio, ManyChat). The landing-page PATCH now records the old slug
// in the Ranchers long-text field 'Previous Slugs' (comma+space separated,
// newest first), and app/ranchers/[slug] falls back to a 308 redirect via
// getRancherByPreviousSlug when the live-slug lookup misses.
//
// PURE — no IO. The Airtable write that persists this value is best-effort
// in the route ('Previous Slugs' may not exist in the base yet; a missing
// field must never break the save).

/**
 * Compute the next 'Previous Slugs' value after a rename oldSlug → newSlug.
 *
 * Rules:
 *  - entries are comma(+space) separated, lowercase, newest first;
 *  - newSlug is REMOVED from the list — re-claiming an old slug must stop
 *    redirecting it (the live slug always wins);
 *  - oldSlug is prepended when non-empty and different from newSlug;
 *  - deduped, capped at 10 (oldest dropped).
 */
export function appendPreviousSlug(
  existingList: string,
  oldSlug: string,
  newSlug: string,
): string {
  const old = String(oldSlug || '').trim().toLowerCase();
  const next = String(newSlug || '').trim().toLowerCase();
  const entries = String(existingList || '')
    .split(/,\s*/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((s) => s !== next);
  const out: string[] = [];
  if (old && old !== next) out.push(old);
  for (const s of entries) {
    if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, 10).join(', ');
}
