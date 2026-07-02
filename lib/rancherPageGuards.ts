// lib/rancherPageGuards.ts
//
// Pure guards for rancher-typed fields the public landing template renders
// raw. The template (app/ranchers/[slug]/page.tsx) is shared code, so a single
// rancher pasting a paragraph / a non-URL / a per-lb price into a free-text
// field ships a visibly broken page. normalizeImageUrl already guards the
// logo/cover; these cover the remaining raw pass-throughs found in the
// 2026-07-02 flawless audit:
//   - social/reserve URL fields → dead hero links when the value isn't a URL
//   - Beef Types hero pill → giant malformed chip when the value is a long
//     checklist instead of a short phrase
//
// Every guard DEGRADES: a bad value hides the element rather than breaking the
// page. Real fix is still rancher data quality; these stop the bleed.

/**
 * Return an http(s) URL safe to drop into an href, or '' when the value is
 * not a usable absolute URL. Ranchers routinely type a handle ("ZK Ranches"),
 * a status ("coming soon"), or a bare domain into the Instagram/Facebook/
 * Google-Reviews/Reserve URL fields; rendered raw those become links that
 * resolve to a broken RELATIVE path on our own origin (/ranchers/<slug>/ZK
 * Ranches). Only absolute http/https URLs pass.
 */
export function safeExternalUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Must parse as an absolute URL with an http(s) scheme and a real host.
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (!u.hostname || !u.hostname.includes('.')) return '';
    return u.toString();
  } catch {
    return '';
  }
}

/**
 * Max length for a value shown in a hero "pill" chip (Beef Types, a location
 * line, etc). The chips are a single short phrase — anything longer is a
 * paste of a checklist / paragraph and blows the hero layout out.
 */
export const HERO_PILL_MAX_LEN = 40;

/**
 * Return the value only if it's short enough + single-line to render in a hero
 * pill; otherwise ''. A newline (multi-line paste) always fails regardless of
 * length. The caller falls back to hiding the pill (the info still lives in
 * the About/story body where long text belongs).
 */
export function heroPillText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.length > HERO_PILL_MAX_LEN) return '';
  if (/[\r\n]/.test(trimmed)) return '';
  return trimmed;
}

/**
 * Format a custom-product price for display. Ranchers enter either a total
 * price (a whole-hog at $650) or a per-lb rate (hanging weight at $7.25/lb);
 * the template printed BOTH as a big total ("$7"), so a buyer saw a whole hog
 * for $7. We can't know intent from the number alone, so we render a per-lb
 * price honestly WHEN the description signals per-pound pricing. Returns the
 * display string (e.g. "$7.25/lb" or "$650").
 *
 * Heuristic: if the product name or description mentions per-lb / /lb / "per
 * pound" / "hanging weight", show "$<price>/lb"; else "$<price>". Deliberately
 * conservative — only relabels when the rancher's own text says per-pound.
 */
export function formatCustomProductPrice(
  price: number,
  name = '',
  description = '',
): string {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return '';
  const hay = `${name} ${description}`.toLowerCase();
  const perLb = /\/\s*lb|per\s*lb|per\s*pound|\blb\b|hanging\s*weight/.test(hay);
  const money = Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
  return perLb ? `${money}/lb` : money;
}
