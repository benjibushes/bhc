// lib/heroImage.ts — responsive sources for the rancher hero cover.
//
// WHY (ad-readiness 2026-08-17): the cover on /ranchers/[slug] is the LCP
// element on the exact page paid Meta traffic lands on, and it rendered as a
// raw <img src={storedUrl}> with no resize param and no srcset. Live-measured
// on the one ad page with a real photo: ~678 KB of webp shipped to a phone.
// That is a bounce risk and a Quality-Score drag before the buyer ever sees a
// price.
//
// The stored URL is arbitrary and rancher-supplied — pasted from wherever the
// ranch already hosts its photos (see app/components/ImageUploader.tsx's host
// allowlist). So this helper is deliberately NARROW: it only rewrites URLs on
// hosts whose imaging API we have actually verified, and returns everything
// else untouched. For an unverified host a resize param is at best dead weight
// and at worst breaks the URL — and a hero that fails only degrades to the
// branded gradient fallback, i.e. a photo-less ad page. Shipping the full-size
// file is the better trade there.
//
// SUPPORTED HOSTS (params + byte counts measured live 2026-08-17)
//   *.squarespace-cdn.com — `?format=<width>w`.
//     Measured on the live champion-valley cover (webp, to a mobile UA):
//     original 678 KB · 500w 51 KB · 750w 110 KB · 1000w 189 KB · 1500w 366 KB
//     · 2500w 678 KB (2500w IS the original).
//     We emit only CANONICAL rungs — 500/750/1000/1500/2500. Squarespace does
//     accept off-ladder values, but it SNAPS THEM UP to the next canonical
//     rung (measured: `640w` returns the 750w bytes, `1200w` the 1500w bytes).
//     So an off-ladder `640w` descriptor would advertise a width the CDN never
//     actually delivers, and the browser's selection math runs on those
//     descriptors. Canonical rungs keep every `w` descriptor truthful.
//     (An unparseable value like `format=junk` degrades to the original, 200 —
//     Squarespace soft-fails rather than 404s.)
//   cdn.shopify.com       — `?width=<n>`. Resizes to ARBITRARY widths, and
//     additionally auto-upgrades the format: measured 1.8 MB source jpeg →
//     180 KB webp at width=1000. Matched exactly (not a suffix): a merchant's
//     own custom domain in front of Shopify is not guaranteed to proxy the
//     param, and we have not verified one.
//
// EVERYTHING ELSE (Vercel Blob, Wix, Cloudfront, a ranch's own webserver, an
// unparseable string) passes through unchanged with NO srcset.

/**
 * Canonical Squarespace `format=<n>w` rungs. Off-ladder requests are snapped
 * UP to the next rung, so staying on-ladder is what keeps each srcset `w`
 * descriptor equal to the width actually delivered.
 */
const SQUARESPACE_WIDTHS = [500, 750, 1000, 1500, 2500] as const;

/** Shopify resizes to any width; this ladder covers phone → retina desktop. */
const SHOPIFY_WIDTHS = [640, 1000, 1500, 2500] as const;

/**
 * Bounded default for the plain `src`. Every modern browser picks from
 * `srcset`, so this only serves srcset-blind clients (and view-source) — but
 * it must still never be the unbounded original.
 */
const DEFAULT_WIDTH = 1500;

export interface HeroImageSources {
  /** Always set. Equals the input URL when the host isn't rewritable. */
  src: string;
  /** Omitted entirely for unknown hosts — never guess. */
  srcSet?: string;
}

/**
 * `sizes` for a full-bleed hero: the cover is absolutely positioned to fill
 * the hero box, which spans the viewport at every breakpoint.
 */
export const HERO_COVER_SIZES = '100vw';

function paramUrl(url: URL, key: string, value: string): string {
  const next = new URL(url.toString());
  // set() overwrites rather than appends, so a URL that already carries
  // `?format=2500w` (Squarespace often does) is re-pointed, not doubled up.
  next.searchParams.set(key, value);
  return next.toString();
}

function build(
  url: URL,
  key: string,
  widths: readonly number[],
  toValue: (w: number) => string,
): HeroImageSources {
  return {
    src: paramUrl(url, key, toValue(DEFAULT_WIDTH)),
    srcSet: widths.map((w) => `${paramUrl(url, key, toValue(w))} ${w}w`).join(', '),
  };
}

/**
 * Given a stored cover-photo URL, return the `src` (+ `srcSet` when the host
 * supports resizing) for the hero <img>. Pure — safe to call during render.
 */
export function heroImageSources(rawUrl: string | null | undefined): HeroImageSources {
  const src = String(rawUrl ?? '').trim();
  if (!src) return { src };

  let u: URL;
  try {
    u = new URL(src);
  } catch {
    // Relative path, data: URI fragment, or plain garbage — hand it back as-is
    // and let the <img> onError fallback do its job.
    return { src };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { src };

  const host = u.hostname.toLowerCase();

  if (host === 'squarespace-cdn.com' || host.endsWith('.squarespace-cdn.com')) {
    return build(u, 'format', SQUARESPACE_WIDTHS, (w) => `${w}w`);
  }
  if (host === 'cdn.shopify.com') {
    return build(u, 'width', SHOPIFY_WIDTHS, (w) => String(w));
  }

  return { src };
}
