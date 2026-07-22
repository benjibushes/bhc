// lib/zipFormat.ts
//
// ZIP string handling ONLY — deliberately split out from lib/zipCentroids.ts so
// callers that just need to validate/normalize a ZIP (the funnel signup path)
// don't drag the 1 MB centroid table into their bundle. Zero imports, zero data.

/** "78701-1234" / " 78701 " / 78701 → "78701". null when not a US 5-digit ZIP. */
export function normalizeZip(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  // Numbers lose leading zeros ("01001" → 1001), so pad before matching —
  // otherwise every New England ZIP would silently miss.
  const s = typeof raw === 'number'
    ? String(Math.trunc(raw)).padStart(5, '0')
    : String(raw).trim();
  const m = /^(\d{5})(?:[- ]?\d{4})?$/.exec(s);
  return m ? m[1] : null;
}
