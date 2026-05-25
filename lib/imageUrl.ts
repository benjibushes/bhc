// Normalize image URLs pasted by ranchers into setup wizard.
//
// Operators frequently paste Dropbox / Google Drive sharing URLs
// thinking those work as <img src>. They don't — both return an HTML
// preview page, not raw image bytes. Result: broken image icon on
// public pages.
//
// This helper detects sharing URLs and rewrites them to the raw-asset
// equivalent. Pass-through for URLs already pointing at raw image
// content.
//
// Audited 2026-05-25: 2 of 9 rancher logos were broken via sharing
// URLs (2M Cattle Co Dropbox + Renick Valley Meats Drive). Long-term
// fix: rancher setup wizard should validate logo URLs at paste time
// (Phase 2). For now this normalize at the API boundary keeps the
// public pages clean.

export function normalizeImageUrl(url: string): string {
  if (!url) return '';
  const trimmed = url.trim();
  if (!trimmed) return '';

  // ── Google Drive sharing URL ────────────────────────────────────
  // Inputs:
  //   https://drive.google.com/file/d/<id>/view?usp=sharing
  //   https://drive.google.com/open?id=<id>
  // Output:
  //   https://drive.google.com/uc?export=view&id=<id>
  if (/drive\.google\.com/.test(trimmed)) {
    // /file/d/<id>/ form
    const fileMatch = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (fileMatch) {
      return `https://drive.google.com/uc?export=view&id=${fileMatch[1]}`;
    }
    // ?id=<id> form
    const idMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idMatch) {
      return `https://drive.google.com/uc?export=view&id=${idMatch[1]}`;
    }
  }

  // ── Dropbox sharing URL ─────────────────────────────────────────
  // Inputs:
  //   https://www.dropbox.com/scl/fi/<id>/<filename>?rlkey=...&dl=0
  //   https://www.dropbox.com/s/<id>/<filename>?dl=0
  // Output:
  //   Same URL but with `dl=1` (forces raw download/image bytes)
  //   For /scl/fi/ paths Dropbox honors ?raw=1 which inlines image.
  if (/dropbox\.com/.test(trimmed)) {
    // Strip existing dl= or raw= params + force raw=1
    const url = new URL(trimmed);
    url.searchParams.delete('dl');
    url.searchParams.set('raw', '1');
    return url.toString();
  }

  // ── Default — pass through ──────────────────────────────────────
  // Already a direct image URL (CDN, S3, Squarespace, Shopify, etc).
  return trimmed;
}
