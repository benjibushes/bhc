// lib/rancherAdSurface.ts
//
// Pure decision helpers for the PUBLIC rancher landing page — the surface we
// point paid traffic at. Every function here exists because the page asserted
// something the record did not support, and an ad-bound page that overclaims is
// worse than one that says less.
//
// Extracted from app/ranchers/[slug]/page.tsx (2026-08-18 live ad-readiness
// audit) because the page is an async RSC that can't be imported under
// `tsx --test` — inline logic there is, by construction, unpinnable.
//
// HOUSE RULE for everything below, inherited from lib/rancherPageGuards: a
// missing/ambiguous field HIDES the element. Never invent, never default into
// a claim. The real fix for a blank field is always rancher data quality.
//
// Hermetic by construction: imports only lib/imageUrl and lib/rancherPageGuards
// (both zero-dependency) plus lib/brokerRail (which imports only lib/pricing).

import { normalizeImageUrl } from './imageUrl';
import { safeExternalUrl } from './rancherPageGuards';
import { isBrokerSelfServe } from './brokerRail';

// ── og:image ─────────────────────────────────────────────────────────────────

/** The site card we ship ourselves — the only image whose size we actually know. */
export const SITE_OG_DEFAULT = 'https://www.buyhalfcow.com/og-image.png';
const SITE_OG_WIDTH = 1200;
const SITE_OG_HEIGHT = 630;

export interface OgImage {
  url: string;
  alt: string;
  /** Only ever set for assets WE own. Omitted for anything rancher-supplied. */
  width?: number;
  height?: number;
}

/**
 * Parse the `Gallery Photos` long-text JSON array into a list of URLs.
 * Bad JSON / wrong shape → [] (the page's own try/catch does the same, this is
 * the metadata-side twin so generateMetadata can't throw on a bad row).
 */
export function parseGalleryPhotos(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((u): u is string => typeof u === 'string' && !!u.trim());
  } catch {
    return [];
  }
}

/**
 * Choose the og:image for a rancher page, in the order a human scrolling
 * Facebook actually responds to.
 *
 * THE BUG (live until 2026-08-18): the logo won unconditionally, so every
 * Facebook / Instagram / LinkedIn preview for every ranch in the network was a
 * black-and-white logo on a white square instead of cattle on grass or a
 * ribeye. On a paid-social surface the preview image IS the ad creative — this
 * was the single highest-leverage fix on the page.
 *
 * SECOND HALF OF THE BUG: the page declared `width: 800, height: 600` for
 * whatever it picked, while the real assets are 802x659 / 1000x1000 /
 * 1500x541. Scrapers trust declared dimensions to lay out the card, so every
 * preview also cropped wrong. We cannot know a remote asset's true size at
 * build time without fetching it, so we OMIT the hint for rancher-supplied
 * images (scrapers then measure the real bytes) and only declare dimensions
 * for the site card we ship ourselves.
 *
 * Order: first gallery photo (the same image the hero cover uses, so the ad
 * preview and the landing page agree) → logo → site card.
 */
export function pickOgImage(rancher: any, name: string): OgImage {
  const gallery = parseGalleryPhotos(rancher?.['Gallery Photos']);
  for (const photo of gallery) {
    // Same normalize the hero cover runs (Drive/Dropbox share links → raw
    // bytes), then the absolute-http(s) guard: a relative path or a pasted
    // handle must never become an og:image, it just breaks the card silently.
    const hero = safeExternalUrl(normalizeImageUrl(photo));
    if (hero) return { url: hero, alt: name };
  }

  const logo = safeExternalUrl(normalizeImageUrl(String(rancher?.['Logo URL'] || '')));
  if (logo) return { url: logo, alt: name };

  return { url: SITE_OG_DEFAULT, alt: 'BuyHalfCow', width: SITE_OG_WIDTH, height: SITE_OG_HEIGHT };
}

// ── the hero trust pill ──────────────────────────────────────────────────────

export type HeroTrustPill = 'prospect' | 'represented' | 'verified' | null;

function readEnumOrString(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'name' in v) {
    return String((v as { name?: unknown }).name || '');
  }
  return String(v);
}

/**
 * Which status pill has this ranch actually EARNED for its hero?
 *
 * THE BUG (live until 2026-08-18): "✓ Verified partner" was the else-branch of
 * `isProspect ? … : brokerSelfServe ? … : <Verified>`, so it rendered for every
 * ranch that was neither. Live false claims on the day of the audit: Champion
 * Valley Farm (Verification Status = 'Not Started'), DD Ranch (blank), Thomas
 * Cattle & Catering (blank). Nine live ranches carried a verification claim
 * their record does not support.
 *
 * The rule now: only `Verification Status = 'Verified'` buys the Verified pill.
 * A ranch with no verdict gets NO pill — the slot stays empty rather than
 * filled with a softer trust-adjacent word, because anything in that position
 * reads as a status the platform is vouching for. The hero still carries the
 * evidence-based chips next to it (location, rating from real reviews, deals
 * closed, capacity) — those are earned, one at a time.
 *
 * DELIBERATE DIVERGENCE from lib/mapPinStatus.derivePinStatus, which also
 * treats `Onboarding Status = 'Live'` as verified. That is correct for PIN
 * BUCKETING (a map pin colour is a progress signal, and Live IS the terminal
 * onboarding state) and wrong here: the words "Verified partner" on an ad
 * landing page are a trust claim, and only the verification field may make it.
 * If Ben wants those nine ranches badged, the fix is one field flip per ranch,
 * not a wider predicate.
 */
export function heroTrustPill(rancher: any): HeroTrustPill {
  const verification = readEnumOrString(rancher?.['Verification Status']);
  if (verification === 'Prospect') return 'prospect';
  if (verification === 'Verified') return 'verified';
  // Terminology ruling (2026-08-18): a broker self-serve ranch is REPRESENTED,
  // never "verified" — it never ran verification and signed nothing.
  if (isBrokerSelfServe(rancher)) return 'represented';
  return null;
}

// ── the fulfillment reach line ───────────────────────────────────────────────

/**
 * Canonical Fulfillment Types (multi-select), matching the setup wizard and
 * /api/checkout/deposit. Airtable usually hands back string[]; some legacy rows
 * hand back [{name}]. Shared with app/ranchers/[slug]/FulfillmentSection so the
 * quick-fact strip and the "How you get your order" section below it can never
 * disagree about whether a ranch ships.
 */
export function normalizeFulfillmentTypes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t: any) => (t && typeof t === 'object' && 'name' in t ? String(t.name) : String(t ?? '')))
    .filter(Boolean);
}

export interface ReachLine {
  /** A verb phrase that is TRUE for this ranch's fulfillment methods. */
  label: string;
  states: string;
}

/**
 * The quick-fact strip's states line, derived from what the ranch actually does.
 *
 * THE BUG (live until 2026-08-18): the strip printed a hardcoded "Ships to
 * <States Served>" whenever States Served differed from State. Champion Valley
 * Farm (Local Pickup + Local Delivery, no shipping) advertised "Ships to NE,
 * CO, KS". So did Renick Valley Meats (WV, VA) and Gift Farms (OK, TX, KS, NM,
 * CO) — three of the four ranches the line rendered for could not ship a box.
 *
 * Branches, all provable from the record:
 *   Cold-Chain Shipping present  → "Ships to"                  (it really ships)
 *   pickup + delivery            → "Pickup and local delivery in"
 *   delivery only                → "Local delivery in"
 *   pickup only                  → "Local pickup in"
 *   no Fulfillment Types at all  → "Serves"    (neutral: claims no method,
 *                                               only that the ranch works there)
 *
 * Returns null when there is nothing extra to say — no States Served, or a
 * States Served that just echoes the ranch's own state.
 */
export function reachLine(rancher: any): ReachLine | null {
  const states = String(rancher?.['States Served'] || '').trim();
  if (!states) return null;
  const state = String(rancher?.['State'] || '').trim();
  if (state && states.toLowerCase() === state.toLowerCase()) return null;

  const types = normalizeFulfillmentTypes(rancher?.['Fulfillment Types']);
  const has = (t: string) => types.some((x) => x.toLowerCase() === t.toLowerCase());
  const ships = has('Cold-Chain Shipping');
  const pickup = has('Local Pickup');
  const delivery = has('Local Delivery');

  let label: string;
  if (ships) label = 'Ships to';
  else if (pickup && delivery) label = 'Pickup and local delivery in';
  else if (delivery) label = 'Local delivery in';
  else if (pickup) label = 'Local pickup in';
  else label = 'Serves';

  return { label, states };
}

// ── video embeds ─────────────────────────────────────────────────────────────

const YT_ID = '([a-zA-Z0-9_-]{11})';

/**
 * Turn a rancher's pasted Video URL into an embeddable iframe src, or null.
 *
 * THE BUG (live until 2026-08-18): the matcher knew youtu.be/, ?v=, /embed and
 * vimeo — but not /shorts/. BOTH ranchers who filled the field with a phone
 * video stored a Shorts link (Renick Valley `youtube.com/shorts/vaRyPu4hqFw`,
 * 5 Bar Beef `youtube.com/shorts/T001fLY61L4?si=…`), so both videos silently
 * never rendered. Shorts is what a rancher's phone produces, so it is the most
 * likely form on this field, and it was the one form we did not handle.
 *
 * Also fixed while here: a bare `vimeo.com/<id>` was returned as-is and refuses
 * to load in an iframe (it must go through player.vimeo.com), and `/live/`,
 * `/v/` and m.youtube.com watch links were unhandled.
 *
 * Anything unrecognized returns null and the video section stays hidden — never
 * a broken iframe on a conversion page.
 */
export function getVideoEmbedUrl(url: string): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  const yt = (id: string) => `https://www.youtube.com/embed/${id}`;

  // Path-style YouTube ids: /shorts/, /embed/, /live/, /v/, and youtu.be/.
  const pathMatch = trimmed.match(
    new RegExp(`(?:youtu\\.be/|youtube\\.com/(?:shorts/|embed/|live/|v/))${YT_ID}`),
  );
  if (pathMatch) return yt(pathMatch[1]);

  // Query-style: watch?v=, ?app=desktop&v=, etc.
  const queryMatch = trimmed.match(new RegExp(`[?&]v=${YT_ID}`));
  if (queryMatch) return yt(queryMatch[1]);

  // Vimeo: normalize a plain link to the player origin so the iframe loads.
  const vimeoPlayer = trimmed.match(/player\.vimeo\.com\/video\/(\d+)/);
  if (vimeoPlayer) return `https://player.vimeo.com/video/${vimeoPlayer[1]}`;
  const vimeo = trimmed.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`;

  return null;
}

// ── the Reviews link ─────────────────────────────────────────────────────────

const GOOGLE_HOSTS = /(^|\.)(google\.com|g\.page|goo\.gl)$/i;

/**
 * Is this URL a WRITE-a-review form rather than reviews you can read?
 *
 * THE BUG (live until 2026-08-18): Renick Valley Meats' Google Reviews URL is
 * `https://g.page/r/CRvZcrCGhd__EAE/review` — Google's "leave a review" deep
 * link, which dead-ends at a sign-in wall. The hero rendered it under the plain
 * label "Reviews", so a cold ad visitor clicking for social proof got a login
 * prompt asking them to rate a ranch they have never bought from.
 *
 * Deliberately narrow. A trailing `/review` only counts as a write form on
 * Google-family hosts — Trustpilot's READ page is literally
 * `trustpilot.com/review/<domain>`, and Facebook's read tab is `/reviews`
 * (plural). Anything we can't positively identify as a form is left alone.
 */
export function isWriteAReviewUrl(raw: string): boolean {
  const safe = safeExternalUrl(raw);
  if (!safe) return false;
  let u: URL;
  try {
    u = new URL(safe);
  } catch {
    return false;
  }
  const path = u.pathname.replace(/\/+$/, '').toLowerCase();
  // Explicit write-review paths on any host (Google local, Yelp, etc).
  if (/\/(writereview|writeareview|write-a-review)(\/|$)/.test(path)) return true;
  // Google's short-link review form: g.page/r/<CID>/review, g.page/<name>/review.
  if (GOOGLE_HOSTS.test(u.hostname) && path.endsWith('/review')) return true;
  return false;
}

/**
 * The href for the hero's "Reviews" link — '' when there is nothing honest to
 * link to.
 *
 * JUDGEMENT (2026-08-18): a write-a-review URL is SUPPRESSED, not relabelled.
 * Two reasons. First, this matches the existing guard doctrine in
 * lib/rancherPageGuards — a bad field value hides its element rather than
 * degrading the page. Second, relabelling it "Leave a review" would put a
 * solicitation in front of cold paid traffic that has bought nothing, which is
 * both useless to the buyer and an invitation to reviews with no purchase
 * behind them. The page already shows real, purchase-linked reviews in its own
 * #reviews section; that is the honest social proof.
 *
 * Fixing the underlying field value is Ben's data call — this just stops the
 * component misleading regardless of what is in there.
 */
export function readableReviewsUrl(raw: unknown): string {
  const safe = safeExternalUrl(raw);
  if (!safe) return '';
  return isWriteAReviewUrl(safe) ? '' : safe;
}
