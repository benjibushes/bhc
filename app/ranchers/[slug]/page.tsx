import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import Pill from '../../components/Pill';
import Card from '../../components/Card';
import ProspectClaimBanner from '../../components/ProspectClaimBanner';
import BHCPromiseBadge from '../../components/BHCPromiseBadge';
import { getRancherOrProspectBySlug, getActiveRancherPages, getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';
import { isRancherOnConnect } from '@/lib/rancherEligibility';
import { getMaxActiveReferrals } from '@/lib/rancherCapacity';
import { normalizeImageUrl } from '@/lib/imageUrl';
import RancherOrderForm from './RancherOrderForm';
import DepositReserveForm from './DepositReserveForm';
import RancherPageAnalytics, { RancherPricingCTA } from './RancherPageAnalytics';
import RanchHeroCover, { RanchCoverFallback } from './RanchHeroCover';
import CertificationBadges from './CertificationBadges';
import FaqSection, { parseFaq, type FaqItem } from './FaqSection';
import FulfillmentSection, { parseFulfillment } from './FulfillmentSection';

// Public rancher landing page — the unit of conversion. Verified partners
// get full pricing + lead capture; prospects get the same shell with pricing
// hidden + a claim banner. This page is the SEO surface for every rancher
// in the network — every section here is a search hit.
//
// Visual hierarchy (post-rebuild):
//   1. Cover hero — full-bleed gallery photo (or branded fallback) with
//      name + state + verification pill overlaid. Cinematic.
//   2. Quick-fact strip — pull-out tagline + chips (state, beef types, USDA, certs)
//   3. Pricing (verified only) — the conversion CTA, sits high
//   4. About + video
//   5. Gallery
//   6. Testimonials
//   7. Process (How it works)
//   8. Custom products
//   9. Reserve
//   10. Note from rancher
//   11. Prospect claim CTA (prospects only)
//   12. Footer nav

export const revalidate = 600;

export async function generateStaticParams() {
  try {
    const ranchers = await getActiveRancherPages();
    return ranchers
      .map((r: any) => ({ slug: r['Slug'] || '' }))
      .filter((p: { slug: string }) => p.slug);
  } catch {
    return [];
  }
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> }
): Promise<Metadata> {
  const { slug } = await params;
  const rancher: any = await getRancherOrProspectBySlug(slug);
  if (!rancher) return { title: 'Rancher Not Found' };

  const name = rancher['Ranch Name'] || rancher['Operator Name'] || 'Ranch';
  const isProspect = rancher['Verification Status'] === 'Prospect';
  const stateLabel = rancher['State'] || '';
  const tagline = rancher['Tagline']
    || (isProspect
        ? `${name}${stateLabel ? ` (${stateLabel})` : ''} — direct-to-consumer rancher. Unclaimed listing on BuyHalfCow.`
        : `Buy direct from ${name} on BuyHalfCow`);
  const logo = normalizeImageUrl((rancher['Logo URL'] || '').toString());

  return {
    title: isProspect ? `${name} — Unclaimed Listing` : name,
    description: tagline,
    // Prospects are unclaimed/auto-generated listings — keep them out of the
    // index so they don't rank as stale or thin pages. Claimed, verified
    // rancher pages stay fully indexable.
    robots: isProspect ? { index: false, follow: true } : undefined,
    openGraph: {
      title: `${name} — BuyHalfCow`,
      description: tagline,
      ...(logo && { images: [{ url: logo, width: 800, height: 600, alt: name }] }),
    },
  };
}

function getYouTubeEmbedUrl(url: string): string | null {
  if (!url) return null;
  const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return `https://www.youtube.com/embed/${shortMatch[1]}`;
  const longMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (longMatch) return `https://www.youtube.com/embed/${longMatch[1]}`;
  if (url.includes('youtube.com/embed') || url.includes('vimeo.com')) return url;
  return null;
}

const PROCESSING_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Render the rancher's Next Processing Date faithfully in every timezone.
// The portal writes it via <input type="date"> → "YYYY-MM-DD" (no time);
// `new Date("2026-06-12").toLocaleDateString(...)` only renders correctly when
// pinned to UTC, and silently shifts a day if the field ever holds a datetime.
// Formatting the calendar parts directly shows exactly the day the rancher
// picked — a MT buyer never sees the pickup date off by one. Falls back to a
// UTC-pinned parse for any non-date-only legacy value.
function formatProcessingDate(raw: string): string | null {
  if (!raw) return null;
  const m = raw.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const month = PROCESSING_MONTHS[parseInt(m[2], 10) - 1];
    if (month) return `${month} ${parseInt(m[3], 10)}, ${m[1]}`;
  }
  const dt = new Date(raw);
  return isNaN(dt.getTime())
    ? null
    : dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export default async function RancherPage(
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const rancherRaw: any = await getRancherOrProspectBySlug(slug);
  if (!rancherRaw) notFound();

  const r = rancherRaw;
  const isProspect = r['Verification Status'] === 'Prospect';
  const name = r['Ranch Name'] || r['Operator Name'] || 'Ranch';
  const operatorName = r['Operator Name'] || '';
  // Display name(s) for the operator without the surname — so a couple-run
  // ranch reads "Meet Matt & Kelsey" (not just "Matt"); a single "John Smith"
  // still renders "John". Falls back to the full operator name.
  const operatorFirst = (() => {
    const parts = operatorName.trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return parts[0] || '';
    return parts.slice(0, -1).join(' ');
  })();
  const tagline = r['Tagline'] || '';
  const logoUrl = normalizeImageUrl((r['Logo URL'] || '').toString());
  const aboutText = r['About Text'] || '';
  const videoUrl = r['Video URL'] || '';
  const state = r['State'] || '';
  const city = r['City'] || '';
  const beefTypes = r['Beef Types'] || '';
  const statesServed = r['States Served'] || '';
  const certifications = r['Certifications'] || '';
  const nextProcessingDate = r['Next Processing Date'] || '';
  const reserveLink = r['Reserve Link'] || '';
  const customNotes = r['Custom Notes'] || '';
  // Cal.com slug — normalized (strip cal.com URL prefix, leading/trailing
  // slashes). When set, surface "Book a 15-min call" CTA on the public page
  // so organic-search visitors can self-schedule without going through the
  // /access → matching → intro email flow.
  const calComSlug = ((r['Cal.com Slug'] as string) || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?cal\.com\//i, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  // Tier drives Cal CTA routing. Operator tier ($500/mo, 0% commission)
  // means BHC handles every sales call — buyers get Ben's sales Cal link
  // instead of the rancher's slug. Singleselect can be string or {name}.
  const rancherTierRaw: any = r['Tier'];
  const rancherTierName =
    rancherTierRaw && typeof rancherTierRaw === 'object' && 'name' in rancherTierRaw
      ? String(rancherTierRaw.name)
      : String(rancherTierRaw || '');
  const isOperatorTier = rancherTierName.toLowerCase() === 'operator';
  const benSalesCalUrl =
    process.env.NEXT_PUBLIC_BEN_SALES_CAL_URL ||
    'https://cal.com/ben-beauchman-1itnsg/sales';
  const showCalCta = isOperatorTier || !!calComSlug;
  const calCtaUrl = isOperatorTier
    ? benSalesCalUrl
    : `https://cal.com/${calComSlug}`;
  const googleReviewsUrl = r['Google Reviews URL'] || '';
  const facebookUrl = r['Facebook URL'] || '';
  const instagramUrl = r['Instagram URL'] || '';
  const processingFacility = r['Processing Facility'] || '';
  const refundPolicy = r['Refund Policy'] || '';

  // Parse JSON-encoded fields. All wrapped in try/catch — a bad row can't
  // break the page, just hides the section. Audit finding 2026-05-20 #32:
  // log parse failures so operator can fix the bad data instead of
  // silently dropping content.
  const logBadJson = (field: string, err: unknown) => {
    console.error(`[rancher-page] bad JSON in ${field} for slug=${slug}:`, err);
  };
  let testimonials: { name: string; quote: string; location?: string; photo?: string }[] = [];
  try {
    if (r['Testimonials']) testimonials = JSON.parse(r['Testimonials']);
  } catch (e) { logBadJson('Testimonials', e); }

  // I-8 audit: H12 wired Buyer Review + Buyer Rating + Review Submitted At
  // fields on Referrals. Reviews were collected but never displayed.
  // Now: pull this rancher's Closed Won referrals where the buyer submitted
  // a review w/ rating >= 4. First-name-only privacy. Surfaces below.
  let buyerReviews: {
    buyerName: string;
    buyerState: string;
    review: string;
    rating: number;
    orderType: string;
    daysAgo: number;
  }[] = [];
  try {
    const rancherRefs = (await getAllRecords(
      TABLES.REFERRALS,
      `AND({Status} = "Closed Won", {Review Submitted At} != BLANK(), {Buyer Rating} >= 4)`,
    )) as any[];
    // Filter to refs that link to THIS rancher.
    const matching = rancherRefs.filter((ref) => {
      const ids: string[] = ref['Rancher'] || ref['Suggested Rancher'] || [];
      return ids.includes(r.id);
    });
    buyerReviews = matching
      .sort((a, b) => {
        const aDate = (a['Review Submitted At'] || '').toString();
        const bDate = (b['Review Submitted At'] || '').toString();
        return bDate > aDate ? 1 : bDate < aDate ? -1 : 0;
      })
      .slice(0, 6)
      .map((ref) => {
        const firstName = String(ref['Buyer Name'] || 'a buyer').trim().split(/\s+/)[0];
        const submittedAt = String(ref['Review Submitted At'] || '');
        const days = submittedAt
          ? Math.max(0, Math.floor((Date.now() - new Date(submittedAt).getTime()) / 86_400_000))
          : 0;
        return {
          buyerName: firstName,
          buyerState: String(ref['Buyer State'] || '').toString(),
          review: String(ref['Buyer Review'] || '').trim(),
          rating: Number(ref['Buyer Rating']) || 5,
          orderType: String(ref['Order Type'] || 'Beef'),
          daysAgo: days,
        };
      })
      .filter((rev) => rev.review.length > 0);
  } catch (e) {
    console.error(`[rancher-page] buyer reviews fetch failed for ${slug}:`, e);
  }

  let galleryPhotos: string[] = [];
  try {
    if (r['Gallery Photos']) galleryPhotos = JSON.parse(r['Gallery Photos']);
  } catch (e) { logBadJson('Gallery Photos', e); }

  let customProducts: { name: string; price: number; description: string; link: string }[] = [];
  try {
    if (r['Custom Products']) customProducts = JSON.parse(r['Custom Products']);
  } catch (e) { logBadJson('Custom Products', e); }

  // FAQ — long-text JSON array of {q,a}. parseFaq is defensive (bad JSON →
  // []) and logs via the shared logBadJson so operators can fix bad rows.
  // The same parsed list drives both the visible accordion AND the FAQPage
  // JSON-LD below, so structured data can never drift from what's rendered.
  const faqItems: FaqItem[] = parseFaq(r['FAQ'], (e) => logBadJson('FAQ', e));

  // Fulfillment — normalize the setup-wizard fields into a single object (or
  // null when the rancher filled none of them). Drives the "How you get your
  // order" section + lets the hardcoded "How it works" reference real methods.
  const fulfillment = parseFulfillment(r);

  const quarterPrice = r['Quarter Price'];
  const quarterLbs = r['Quarter lbs'] || '';
  // NOTE: Payment Links below are IGNORED for Connected ranchers (tier_v2 +
  // Connect active). isRancherOnConnect(r) routes all buyer-facing paths to
  // the on-platform commission flow (/access?rancher=slug). Config fields are
  // left as-is so ranchers can keep them for reference or legacy fallback.
  const quarterLink = r['Quarter Payment Link'] || '';
  const halfPrice = r['Half Price'];
  const halfLbs = r['Half lbs'] || '';
  const halfLink = r['Half Payment Link'] || '';
  const wholePrice = r['Whole Price'];
  const wholeLbs = r['Whole lbs'] || '';
  const wholeLink = r['Whole Payment Link'] || '';

  // MONEY-INTEGRITY INVARIANT: Connected ranchers must never expose raw
  // Payment-Link hrefs to buyers. All buy paths route through /access?rancher=
  // (the on-platform commission flow). Legacy ranchers are unaffected.
  const onConnect = isRancherOnConnect(r);

  const hasPricing = !isProspect && (quarterPrice || halfPrice || wholePrice);
  const embedUrl = getYouTubeEmbedUrl(videoUrl);

  // Cover photo — first gallery photo if available, else null. We layer a
  // dark gradient over it so hero text stays readable on any image.
  const coverPhoto = galleryPhotos[0] || '';

  // Hero rating summary (P1 #7) — reuse the buyerReviews query above. Show
  // "★ 4.9 · 12 reviews" only when there's at least one review. avg is
  // rounded to 1 decimal; an integer average renders cleanly (5 → "5.0").
  const reviewCount = buyerReviews.length;
  const avgRating =
    reviewCount > 0
      ? Math.round((buyerReviews.reduce((sum, rev) => sum + rev.rating, 0) / reviewCount) * 10) / 10
      : 0;

  // Scarcity (P1 #6) — remaining capacity this round = max active referrals −
  // current active referrals. Only meaningful for verified ranchers with a
  // real capacity signal AND remaining headroom; otherwise null so every
  // scarcity UI hides. We clamp at 0 and treat a non-positive remainder as
  // "no signal" (a full round shouldn't scream "0 left" on a storefront we
  // want converting — the order form/capacity gate handles the sold-out path).
  const sharesLeft: number | null = (() => {
    if (isProspect) return null;
    const maxRef = getMaxActiveReferrals(r);
    const currentRaw = r['Current Active Referrals'];
    if (currentRaw === undefined || currentRaw === null || currentRaw === '') return null;
    if (!Number.isFinite(maxRef) || maxRef <= 0) return null;
    const remaining = maxRef - (Number(currentRaw) || 0);
    return remaining > 0 && remaining <= maxRef ? remaining : null;
  })();

  const lat = Number(r['Latitude']);
  const lng = Number(r['Longitude']);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

  // Build offers array + priceRange (verified ranchers only)
  const offers: any[] = [];
  if (!isProspect && quarterPrice) {
    offers.push({
      '@type': 'Offer',
      name: 'Quarter Beef',
      price: quarterPrice,
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
    });
  }
  if (!isProspect && halfPrice) {
    offers.push({
      '@type': 'Offer',
      name: 'Half Beef',
      price: halfPrice,
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
    });
  }
  if (!isProspect && wholePrice) {
    offers.push({
      '@type': 'Offer',
      name: 'Whole Beef',
      price: wholePrice,
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
    });
  }

  const prices = [quarterPrice, halfPrice, wholePrice]
    .filter((p) => typeof p === 'number' && p > 0) as number[];
  const priceRange =
    prices.length > 0 ? `$${Math.min(...prices)}–$${Math.max(...prices)}` : undefined;

  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name,
    url: `${siteUrl}/ranchers/${slug}`,
    ...(state ? { address: { '@type': 'PostalAddress', addressLocality: city, addressRegion: state, addressCountry: 'US' } } : {}),
    ...(isFinite(lat) && isFinite(lng)
      ? { geo: { '@type': 'GeoCoordinates', latitude: lat, longitude: lng } }
      : {}),
    ...(logoUrl ? { image: logoUrl } : {}),
    ...(tagline ? { description: tagline } : {}),
    ...(offers.length > 0 ? { makesOffer: offers } : {}),
    ...(priceRange ? { priceRange } : {}),
    ...(isProspect
      ? {
          disambiguatingDescription:
            'Unclaimed listing — built from public information. The operator has not yet verified this listing on BuyHalfCow.',
        }
      : {}),
  };

  // FAQPage structured data (P1 #3) — emitted as a SECOND JSON-LD script
  // alongside LocalBusiness so search engines can surface FAQ rich results.
  // Built from the exact same faqItems the accordion renders. Null when there
  // are no questions, so we never emit an empty FAQPage.
  const faqJsonLd: Record<string, unknown> | null =
    faqItems.length > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: faqItems.map((item) => ({
            '@type': 'Question',
            name: item.q,
            acceptedAnswer: { '@type': 'Answer', text: item.a },
          })),
        }
      : null;

  const processingDateDisplay = formatProcessingDate(nextProcessingDate);

  // P2 #8 — is the Processing Facility a real, distinct plant (vs. just the
  // ranch name echoed back)? Normalize both sides (case/whitespace) before
  // comparing so "Bar M Ranch" === "bar m ranch ". Only a genuine third-party
  // facility earns the "USDA inspected" quick-fact.
  const normName = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const hasRealProcessingFacility =
    !!processingFacility && normName(processingFacility) !== normName(name);

  const locationLine = [city, state].filter(Boolean).join(', ');

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {faqJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
      )}

      {/* Audit 6 P1 — paid-scale tracking: fires rancher_page_view on mount
          with rancherId/slug/state custom_data for per-rancher Meta + GA
          segmentation. PixelTracker's generic PageView didn't carry this
          metadata, blinding paid creative ROAS by rancher. */}
      <RancherPageAnalytics
        rancherId={r.id}
        rancherSlug={slug}
        rancherState={state}
      />

      {isProspect && <ProspectClaimBanner ranchName={name} slug={slug} state={state} />}

      {/* ── HERO ──────────────────────────────────────────────────────────────
          Cover photo full-bleed (or warm bone gradient fallback) with a
          ground-up dark gradient to keep text legible. Logo + name + state +
          verification pill float on top. Cinematic on desktop, restrained
          on mobile.
         ───────────────────────────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden">
        <div className="absolute inset-0 -z-10">
          {/* P0 #1 — bulletproof cover. With a URL, RanchHeroCover renders the
              photo + onError-falls-back to a branded gradient + ranch motif
              (never a broken-image icon). With no URL, we render the identical
              fallback directly so the hero always reads as intentional. */}
          {coverPhoto ? (
            <RanchHeroCover src={coverPhoto} alt={`${name} cover`} />
          ) : (
            <RanchCoverFallback />
          )}
        </div>

        <Container>
          <div className="py-24 md:py-36 max-w-4xl">
            <div className="flex flex-col gap-6">
              {/* Verification + state pill row */}
              <div className="flex flex-wrap items-center gap-2">
                {isProspect ? (
                  <Pill tone="amber">Unclaimed listing</Pill>
                ) : (
                  <Pill tone="positive" icon={<span aria-hidden>✓</span>}>
                    Verified partner
                  </Pill>
                )}
                {locationLine && (
                  <Pill tone="inverted">{locationLine}</Pill>
                )}
                {beefTypes && (
                  <Pill tone="inverted">{beefTypes}</Pill>
                )}
                {/* Hero rating summary (P1 #7) — only when ≥1 real review. */}
                {reviewCount > 0 && (
                  <a
                    href="#reviews"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] uppercase tracking-widest font-semibold bg-bone/15 text-bone border border-bone/25 transition-base hover:bg-bone/25"
                  >
                    <span aria-hidden className="text-amber">★</span>
                    {avgRating.toFixed(1)} · {reviewCount} {reviewCount === 1 ? 'review' : 'reviews'}
                  </a>
                )}
                {/* Scarcity (P1 #6) — remaining capacity this round. */}
                {sharesLeft !== null && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] uppercase tracking-widest font-semibold bg-amber/20 text-amber border border-amber/40">
                    <span aria-hidden>●</span>
                    {sharesLeft} {sharesLeft === 1 ? 'share' : 'shares'} left this round
                  </span>
                )}
              </div>

              {/* Certifications as badges (P1 #4) — replaces the old single
                  plain pill that crammed all certs into one chip. Known terms
                  get an icon + sage chip; unknown terms render as plain chips. */}
              {certifications && (
                <CertificationBadges raw={certifications} />
              )}

              {/* Logo + name */}
              <div className="flex items-center gap-5">
                {logoUrl && (
                  <div className="relative h-20 w-20 md:h-24 md:w-24 shrink-0 bg-bone p-2 border border-bone/40">
                    <Image
                      src={logoUrl}
                      alt={`${name} logo`}
                      fill
                      className="object-contain"
                    />
                  </div>
                )}
                <h1 className="font-serif text-4xl md:text-6xl text-bone leading-[1.05] drop-shadow-sm">
                  {name}
                </h1>
              </div>

              {tagline && (
                <p className="text-lg md:text-xl text-bone/90 max-w-2xl leading-relaxed">
                  {tagline}
                </p>
              )}

              {/* CTA row — verified gets pricing-jump, prospect gets claim */}
              <div className="flex flex-wrap gap-3 pt-2">
                {hasPricing ? (
                  <RancherPricingCTA
                    href="#shares"
                    rancherSlug={slug}
                    rancherState={state}
                    className="inline-flex items-center gap-2 px-7 py-3.5 bg-bone text-charcoal text-sm font-medium tracking-wide uppercase transition-base hover:bg-bone-warm"
                  >
                    See pricing
                    <span aria-hidden>↓</span>
                  </RancherPricingCTA>
                ) : isProspect ? (
                  <Link
                    href={`/ranchers/${slug}/claim`}
                    className="inline-flex items-center gap-2 px-7 py-3.5 bg-bone text-charcoal text-sm font-medium tracking-wide uppercase transition-base hover:bg-bone-warm"
                  >
                    Claim this listing
                    <span aria-hidden>→</span>
                  </Link>
                ) : (
                  <Link
                    href="/access"
                    className="inline-flex items-center gap-2 px-7 py-3.5 bg-bone text-charcoal text-sm font-medium tracking-wide uppercase transition-base hover:bg-bone-warm"
                  >
                    Get on the list
                    <span aria-hidden>→</span>
                  </Link>
                )}
                {(facebookUrl || instagramUrl || googleReviewsUrl) && (
                  <div className="flex items-center gap-3 px-2">
                    {googleReviewsUrl && (
                      <a
                        href={googleReviewsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-bone/80 hover:text-bone transition-base text-sm underline underline-offset-4 decoration-bone/40"
                      >
                        Reviews
                      </a>
                    )}
                    {instagramUrl && (
                      <a
                        href={instagramUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-bone/80 hover:text-bone transition-base text-sm underline underline-offset-4 decoration-bone/40"
                      >
                        Instagram
                      </a>
                    )}
                    {facebookUrl && (
                      <a
                        href={facebookUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-bone/80 hover:text-bone transition-base text-sm underline underline-offset-4 decoration-bone/40"
                      >
                        Facebook
                      </a>
                    )}
                  </div>
                )}
              </div>

              {/* Secondary CTA: Ask a question (verified ranchers only) */}
              {!isProspect && (
                <div className="pt-4">
                  <Link
                    href={`/ranchers/${slug}/contact`}
                    className="text-sm text-saddle hover:text-charcoal underline underline-offset-2 transition-colors"
                  >
                    Have a question? Ask {operatorFirst || 'the ranch'} →
                  </Link>
                </div>
              )}
            </div>
          </div>
        </Container>
      </section>

      {/* ── QUICK FACTS STRIP ────────────────────────────────────────────────
          Compact dark band right under hero — same width-constrained band
          for processing date + USDA facility + states served. Replaces the
          old "social proof" section that was floating awkwardly mid-page.
         ───────────────────────────────────────────────────────────────────── */}
      {(processingDateDisplay || hasRealProcessingFacility || statesServed) && (
        <section className="bg-bone-warm border-b border-dust">
          <Container>
            <div className="py-5 md:py-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-sm text-charcoal/85">
              {processingDateDisplay && (
                <span>
                  <span className="text-saddle">Next processing</span>{' '}
                  <strong>{processingDateDisplay}</strong>
                </span>
              )}
              {/* P2 #8 — only claim "USDA inspected: <facility>" when the
                  facility is a real, distinct processing plant. When the
                  Processing Facility field just echoes the ranch name (no
                  separate plant on record), rendering it would be a circular
                  claim ("USDA inspected: <this ranch>"), so we hide it. */}
              {hasRealProcessingFacility && (
                <span>
                  <span className="text-saddle">USDA inspected</span>{' '}
                  <strong>{processingFacility}</strong>
                </span>
              )}
              {statesServed && statesServed !== state && (
                <span>
                  <span className="text-saddle">Ships to</span>{' '}
                  <strong>{statesServed}</strong>
                </span>
              )}
            </div>
          </Container>
        </section>
      )}

      {/* ── BHC PROMISE BADGE ─────────────────────────────────────────────────
          Trust floor (cold-chain + 7d satisfaction + mediation) displayed on
          verified ranchers BEFORE checkout. Audit 1 + 4 P1: move upstream from
          /checkout/[refId]/deposit so buyers see trust commitment before the fence.
         ───────────────────────────────────────────────────────────────────── */}
      {!isProspect && (
        <section className="py-16 md:py-20">
          <Container>
            <div className="max-w-4xl mx-auto">
              <BHCPromiseBadge />
            </div>
          </Container>
        </section>
      )}

      {/* ── RANCHER REFUND POLICY ─────────────────────────────────────────────
          H2: Surface rancher's refund policy publicly on landing page.
          Captured in setup wizard step 8 (20-500 char validated), now shown
          alongside BHC Promise so buyers can compare policies pre-purchase.
          Only rendered for verified ranchers when policy is set.
         ───────────────────────────────────────────────────────────────────── */}
      {!isProspect && refundPolicy && (
        <section className="py-16 md:py-20 bg-bone-warm border-y border-dust/60">
          <Container>
            <div className="max-w-4xl mx-auto">
              <div className="border-l-2 border-dust pl-4 py-3 text-sm">
                <p className="font-semibold text-charcoal text-xs uppercase tracking-widest">
                  Rancher refund policy
                </p>
                <p className="text-saddle mt-1 whitespace-pre-wrap">{refundPolicy}</p>
              </div>
            </div>
          </Container>
        </section>
      )}

      {/* ── PRICING ───────────────────────────────────────────────────────────
          Sits high on the page — main conversion. RancherOrderForm owns the
          UX of share selection + buyer-rancher connection. Submits an order
          REQUEST through BHC (no external redirect to rancher's website),
          creates a Referral, emails the rancher with reply-to=buyer.
         ───────────────────────────────────────────────────────────────────── */}
      {hasPricing && (
        <section id="shares" className="py-16 md:py-20 scroll-mt-12">
          <Container>
            <div className="max-w-4xl mx-auto space-y-8">
              <div className="text-center space-y-3">
                <Pill tone="neutral" className="mx-auto">Available shares</Pill>
                <h2 className="font-serif text-3xl md:text-5xl">Choose your share</h2>
                <p className="text-saddle max-w-xl mx-auto">
                  All prices include processing.{' '}
                  {onConnect
                    ? `Reserve yours now with a small deposit — you're matched to ${operatorFirst || name} and pay securely on-platform.`
                    : `${operatorFirst || name} reaches back out within 48h to confirm timing + payment.`}
                </p>
                {/* Scarcity (P1 #6) — surfaces remaining capacity right at the
                    point of decision. Hidden when there's no capacity signal. */}
                {sharesLeft !== null && (
                  <p className="inline-flex items-center gap-2 mx-auto px-4 py-2 bg-amber/15 border border-amber/40 text-sm font-semibold text-amber-dark">
                    <span aria-hidden>●</span>
                    Only {sharesLeft} {sharesLeft === 1 ? 'share' : 'shares'} left this processing round
                  </p>
                )}
              </div>

              {/* Collect-ready (tier_v2 + Connect active) ranchers route the
                  PRIMARY CTA straight onto the deposit rail (/access?rancher=
                  → qualify → match → on-platform deposit) instead of the
                  lead-capture form's 48h manual callback. Legacy / non-collect
                  ranchers keep the lead form (they collect off-platform). */}
              {onConnect ? (
                <DepositReserveForm
                  slug={slug}
                  ranchName={name}
                  operatorFirst={operatorFirst || name}
                  bookingUrl={showCalCta ? calCtaUrl : ''}
                  quarter={quarterPrice ? { price: quarterPrice, lbs: quarterLbs } : undefined}
                  half={halfPrice ? { price: halfPrice, lbs: halfLbs } : undefined}
                  whole={wholePrice ? { price: wholePrice, lbs: wholeLbs } : undefined}
                />
              ) : (
                <RancherOrderForm
                  slug={slug}
                  rancherName={operatorName || name}
                  ranchName={name}
                  quarter={quarterPrice ? { price: quarterPrice, lbs: quarterLbs } : undefined}
                  half={halfPrice ? { price: halfPrice, lbs: halfLbs } : undefined}
                  whole={wholePrice ? { price: wholePrice, lbs: wholeLbs } : undefined}
                />
              )}

              <p className="text-center text-xs text-dust">
                Prices in USD. Questions?{' '}
                <Link href="/access" className="underline underline-offset-2 hover:text-charcoal">
                  Contact BuyHalfCow
                </Link>
              </p>

              {showCalCta && (
                <div className="mt-8 border border-charcoal bg-bone p-6 md:p-7 text-center">
                  <p className="text-xs uppercase tracking-widest text-saddle mb-2">
                    Have questions before you buy?
                  </p>
                  <h3 className="font-serif text-2xl text-charcoal mb-3">
                    {isOperatorTier
                      ? `Schedule a 15-min call with Ben`
                      : `Schedule a 15-min call with ${operatorFirst || 'the rancher'}`}
                  </h3>
                  <p className="text-sm text-saddle mb-5 max-w-xl mx-auto">
                    {isOperatorTier
                      ? `${name} works with us under our Operator program — I (Ben, BuyHalfCow founder) personally walk every buyer through pricing, processing dates, cut options, and delivery. Pick a time and I'll have your slot reserved.`
                      : `Walk through pricing, processing date, cut options, and delivery — direct with the rancher, no middleman. They set their availability, you pick a time.`}
                  </p>
                  <a
                    href={calCtaUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block px-7 py-3.5 bg-charcoal text-bone hover:bg-saddle transition-colors font-medium uppercase tracking-widest text-xs"
                  >
                    {isOperatorTier ? 'Book your call with Ben →' : 'Book your 15-min call →'}
                  </a>
                </div>
              )}
            </div>
          </Container>
        </section>
      )}

      {/* ── ABOUT + VIDEO ────────────────────────────────────────────────────
          Two-column on desktop (text left, video right) — gives both equal
          weight without the old stacked layout that hid the video.

          P0 #2 (never-empty): when a verified rancher has NO about text and NO
          video, we still render a short, intentional intro built from the
          name + location + beef types, so the page reads as a complete story
          (hero → about → how-it-works → CTA) instead of jumping from hero
          straight to "How it works" with a visible gap. Prospects keep the
          old behavior (their page is a thin claim shell by design).
         ───────────────────────────────────────────────────────────────────── */}
      {(aboutText || embedUrl) ? (
        <section className="py-16 md:py-20 bg-bone-warm border-y border-dust/60">
          <Container>
            <div className="max-w-5xl mx-auto grid md:grid-cols-2 gap-10 lg:gap-14 items-start">
              {aboutText && (
                <div className="space-y-5">
                  <Pill tone="neutral">About</Pill>
                  <h2 className="font-serif text-3xl md:text-4xl">
                    Meet {operatorFirst || name}
                  </h2>
                  <div className="prose-bhc whitespace-pre-line">{aboutText}</div>
                </div>
              )}

              {embedUrl && (
                <div className="space-y-4">
                  {!aboutText && <Pill tone="neutral">Watch</Pill>}
                  <div
                    className="relative w-full overflow-hidden border border-dust"
                    style={{ paddingBottom: '56.25%' }}
                  >
                    <iframe
                      src={embedUrl}
                      title={`${name} interview`}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                      className="absolute inset-0 w-full h-full"
                    />
                  </div>
                  {operatorName && (
                    <p className="text-xs text-dust">Interview with {operatorName}</p>
                  )}
                </div>
              )}
            </div>
          </Container>
        </section>
      ) : !isProspect ? (
        // Never-empty fallback (P0 #2): no about text, no video. Build a warm,
        // honest intro from the fields we DO have so the page still tells a
        // story. Every clause is conditional, so this reads naturally whether
        // or not location / beef types are set.
        <section className="py-16 md:py-20 bg-bone-warm border-y border-dust/60">
          <Container>
            <div className="max-w-3xl mx-auto text-center space-y-5">
              <Pill tone="neutral" className="mx-auto">About</Pill>
              <h2 className="font-serif text-3xl md:text-4xl">
                Meet {operatorFirst || name}
              </h2>
              <p className="text-saddle leading-relaxed text-lg">
                {name} is a direct-to-consumer cattle ranch
                {locationLine ? ` in ${locationLine}` : ''}
                {beefTypes ? `, raising ${beefTypes.toLowerCase()} beef` : ''}
                {' '}for families who want to know exactly where their meat comes
                from. Order direct, skip the grocery-store middleman, and fill
                your freezer with beef raised the way it should be.
              </p>
            </div>
          </Container>
        </section>
      ) : null}

      {/* ── GALLERY ──────────────────────────────────────────────────────────
          Slips coverPhoto (idx 0) since it's already the hero. Remaining
          photos render as 4-col masonry-ish grid. Blurs on hover.
         ───────────────────────────────────────────────────────────────────── */}
      {galleryPhotos.length > 1 && (
        <section className="py-16 md:py-20">
          <Container>
            <div className="max-w-6xl mx-auto space-y-8">
              <div className="text-center space-y-2">
                <Pill tone="neutral" className="mx-auto">The Operation</Pill>
                <h2 className="font-serif text-3xl md:text-4xl">Inside the ranch</h2>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4">
                {galleryPhotos.slice(1).map((url, i) => (
                  <div
                    key={i}
                    className="relative aspect-square overflow-hidden border border-dust group"
                  >
                    <Image
                      src={url}
                      alt={`${name} ranch photo ${i + 2}`}
                      fill
                      className="object-cover transition-base group-hover:scale-105"
                      sizes="(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw"
                    />
                  </div>
                ))}
              </div>
            </div>
          </Container>
        </section>
      )}

      {/* ── BUYER REVIEWS (H12 collected via /api/reviews/submit) ────────────
          P0 audit I-8: H12 wired review collection → JWT magic link →
          /api/reviews/submit writes Buyer Rating + Buyer Review + Review
          Submitted At. But testimonials display only read legacy
          Testimonial/Quote fields. Now real reviews surface here.
          ───────────────────────────────────────────────────────────────────── */}
      {buyerReviews.length > 0 && (
        <section id="reviews" className="py-16 md:py-20 bg-bone-warm border-y border-dust/60 scroll-mt-12">
          <Container>
            <div className="max-w-5xl mx-auto space-y-10">
              <div className="text-center space-y-3">
                <Pill tone="neutral" className="mx-auto">Verified buyers</Pill>
                <h2 className="font-serif text-3xl md:text-4xl">What buyers say</h2>
                {/* Aggregate summary mirrors the hero badge (P1 #7). */}
                <p className="flex items-center justify-center gap-2 text-saddle">
                  <span className="text-amber" aria-hidden>
                    {'★'.repeat(Math.round(avgRating))}
                    <span className="opacity-30">{'★'.repeat(5 - Math.round(avgRating))}</span>
                  </span>
                  <span className="font-semibold text-charcoal">{avgRating.toFixed(1)}</span>
                  <span className="text-dust">·</span>
                  <span>{reviewCount} verified {reviewCount === 1 ? 'review' : 'reviews'}</span>
                </p>
              </div>
              <div className="grid md:grid-cols-2 gap-5 md:gap-6">
                {buyerReviews.map((rev, i) => (
                  <Card key={i} variant="default" padding="lg" className="space-y-4">
                    <div className="flex items-center gap-1 text-saddle" aria-label={`${rev.rating} of 5 stars`}>
                      {Array.from({ length: 5 }).map((_, idx) => (
                        <span key={idx} className={idx < rev.rating ? '' : 'opacity-30'} aria-hidden>
                          ★
                        </span>
                      ))}
                    </div>
                    <p className="text-charcoal/90 leading-relaxed text-base md:text-lg italic">
                      {rev.review}
                    </p>
                    <div className="flex items-center gap-3 pt-3 border-t border-dust/60 text-sm">
                      <div className="w-10 h-10 border border-dust flex items-center justify-center rounded-full bg-bone-deep">
                        <span className="text-saddle font-medium">{rev.buyerName.charAt(0)}</span>
                      </div>
                      <div>
                        <p className="font-semibold text-charcoal">{rev.buyerName}</p>
                        <p className="text-xs text-dust">
                          {rev.orderType}{rev.buyerState ? ` · ${rev.buyerState}` : ''}
                          {rev.daysAgo > 0 ? ` · ${rev.daysAgo === 1 ? '1 day ago' : rev.daysAgo < 30 ? `${rev.daysAgo} days ago` : `${Math.floor(rev.daysAgo / 30)} mo ago`}` : ''}
                        </p>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          </Container>
        </section>
      )}

      {/* ── TESTIMONIALS ─────────────────────────────────────────────────────
          Larger quote cards with serif quote marks. Lifts on hover.
         ───────────────────────────────────────────────────────────────────── */}
      {testimonials.length > 0 && (
        <section className="py-16 md:py-20 bg-bone-warm border-y border-dust/60">
          <Container>
            <div className="max-w-5xl mx-auto space-y-10">
              <div className="text-center space-y-2">
                <Pill tone="neutral" className="mx-auto">Word of mouth</Pill>
                <h2 className="font-serif text-3xl md:text-4xl">What customers say</h2>
              </div>
              <div className="grid md:grid-cols-2 gap-5 md:gap-6">
                {testimonials.map((t, i) => (
                  <Card key={i} variant="default" padding="lg" className="space-y-5">
                    <div
                      aria-hidden
                      className="font-serif text-5xl leading-none text-saddle/40 select-none"
                    >
                      “
                    </div>
                    <p className="text-charcoal/90 leading-relaxed text-base md:text-lg italic -mt-3">
                      {t.quote}
                    </p>
                    <div className="flex items-center gap-3 pt-2 border-t border-dust/60">
                      {t.photo ? (
                        <Image
                          src={t.photo}
                          alt={t.name}
                          width={40}
                          height={40}
                          className="rounded-full object-cover"
                        />
                      ) : (
                        <div className="w-10 h-10 border border-dust flex items-center justify-center rounded-full bg-bone-deep">
                          <span className="text-sm text-saddle font-medium">
                            {t.name.charAt(0)}
                          </span>
                        </div>
                      )}
                      <div>
                        <p className="text-sm font-semibold text-charcoal">{t.name}</p>
                        {t.location && <p className="text-xs text-dust">{t.location}</p>}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          </Container>
        </section>
      )}

      {/* ── PROCESS ──────────────────────────────────────────────────────────
          Three-step explainer. Big numbers in serif, restrained borders.
          Copy is honest about logistics — pickup OR delivery depending on
          the rancher, not promised either way.
         ───────────────────────────────────────────────────────────────────── */}
      <section className="py-16 md:py-20">
        <Container>
          <div className="max-w-5xl mx-auto space-y-10">
            <div className="text-center space-y-2">
              <Pill tone="neutral" className="mx-auto">How it works</Pill>
              <h2 className="font-serif text-3xl md:text-4xl">
                Direct from {name} to your freezer
              </h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6">
              {[
                {
                  num: '01',
                  title: 'Choose your share',
                  blurb: 'Quarter, half, or whole — based on your family and freezer space.',
                },
                {
                  num: '02',
                  title: 'Reserve & confirm',
                  blurb: `Hold your share with a deposit. ${operatorFirst || name} reaches out to confirm cut sheet, timing, and logistics.`,
                },
                {
                  num: '03',
                  // P2 #9 — point at the real fulfillment section when the
                  // rancher has filled it in (so we describe THEIR actual
                  // options), and soften to a non-committal line when they
                  // haven't, instead of asserting both pickup AND delivery for
                  // every ranch.
                  title: fulfillment ? 'Get your beef' : 'Pickup or delivery',
                  blurb: fulfillment
                    ? 'Custom butchered and vacuum-sealed on processing day. See your delivery and pickup options below.'
                    : 'Custom butchered and vacuum-sealed on processing day. You and the ranch arrange how it gets to you.',
                },
              ].map((step) => (
                <Card key={step.num} variant="default" padding="lg" className="space-y-3">
                  <p className="font-serif text-5xl text-saddle/70 leading-none">{step.num}</p>
                  <h3 className="font-serif text-xl text-charcoal">{step.title}</h3>
                  <p className="text-sm text-charcoal/75 leading-relaxed">{step.blurb}</p>
                </Card>
              ))}
            </div>
          </div>
        </Container>
      </section>

      {/* ── HOW YOU GET YOUR BEEF (P1 #5) ────────────────────────────────────
          Concrete per-rancher fulfillment — pickup / delivery / shipping —
          from the setup-wizard fields. Renders nothing when the rancher
          filled none of them (parseFulfillment → null). Grounds the generic
          "How it works" step 3 above with real options.
         ───────────────────────────────────────────────────────────────────── */}
      {fulfillment && <FulfillmentSection data={fulfillment} />}

      {/* ── FAQ (P1 #3) ──────────────────────────────────────────────────────
          Accordion from rancher['FAQ']. FAQPage JSON-LD emitted up top from
          the same parsed list. Renders nothing when there are no questions.
         ───────────────────────────────────────────────────────────────────── */}
      <FaqSection items={faqItems} />

      {/* ── CUSTOM PRODUCTS ──────────────────────────────────────────────── */}
      {!isProspect && customProducts.length > 0 && (
        <section className="py-16 md:py-20 bg-bone-warm border-y border-dust/60">
          <Container>
            <div className="max-w-5xl mx-auto space-y-10">
              <div className="text-center space-y-2">
                <Pill tone="neutral" className="mx-auto">Other products</Pill>
                <h2 className="font-serif text-3xl md:text-4xl">More from {name}</h2>
              </div>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5 md:gap-6">
                {customProducts.map((product, i) => (
                  <Card key={i} variant="default" padding="lg" className="flex flex-col">
                    <div className="flex-1 space-y-2.5">
                      <h3 className="font-serif text-2xl text-charcoal">{product.name}</h3>
                      <p className="font-serif text-3xl text-saddle">
                        ${product.price}
                      </p>
                      {product.description && (
                        <p className="text-sm text-charcoal/75 leading-relaxed">
                          {product.description}
                        </p>
                      )}
                    </div>
                    {/* Connected ranchers: suppress raw product link; route to commission path instead */}
                    {onConnect ? (
                      <Link
                        href="#reserve"
                        className="block w-full text-center mt-5 px-6 py-3 border border-charcoal text-sm font-medium tracking-wide uppercase transition-base hover:bg-charcoal hover:text-bone"
                      >
                        Reserve a share →
                      </Link>
                    ) : product.link ? (
                      <a
                        href={product.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block w-full text-center mt-5 px-6 py-3 border border-charcoal text-sm font-medium tracking-wide uppercase transition-base hover:bg-charcoal hover:text-bone"
                      >
                        Buy now
                      </a>
                    ) : null}
                  </Card>
                ))}
              </div>
            </div>
          </Container>
        </section>
      )}

      {/* ── RESERVE / NEXT PROCESSING ────────────────────────────────────── */}
      {!isProspect && (processingDateDisplay || reserveLink) && (
        <section className="py-16 md:py-20">
          <Container>
            <Card
              variant="inverted"
              padding="lg"
              className="max-w-3xl mx-auto text-center space-y-5"
            >
              <Pill tone="inverted" className="mx-auto bg-bone/15">
                Not ready to commit?
              </Pill>
              <h2 className="font-serif text-3xl md:text-4xl text-bone">
                Hold your spot
              </h2>
              {processingDateDisplay && (
                <p className="text-bone/85">
                  Next processing date{' '}
                  <strong className="text-bone">{processingDateDisplay}</strong>
                </p>
              )}
              {/* Scarcity (P1 #6) in the reserve CTA — concrete urgency. */}
              {sharesLeft !== null && (
                <p className="inline-flex items-center gap-2 mx-auto px-4 py-2 bg-amber/20 border border-amber/40 text-sm font-semibold text-amber">
                  <span aria-hidden>●</span>
                  {sharesLeft} {sharesLeft === 1 ? 'share' : 'shares'} left this round
                </p>
              )}
              <p className="text-bone/75 text-sm leading-relaxed max-w-md mx-auto">
                A small deposit holds your share. Reserve before the processing date
                fills up.
              </p>
              <div className="pt-2">
                {/* Connected ranchers: always route through commission path, never raw Reserve Link */}
                {reserveLink && !onConnect ? (
                  <a
                    href={reserveLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-7 py-3.5 bg-bone text-charcoal text-sm font-medium tracking-wide uppercase transition-base hover:bg-bone-warm"
                  >
                    Reserve your share
                    <span aria-hidden>→</span>
                  </a>
                ) : (
                  <Link
                    href={onConnect ? '#reserve' : '/access'}
                    className="inline-flex items-center gap-2 px-7 py-3.5 bg-bone text-charcoal text-sm font-medium tracking-wide uppercase transition-base hover:bg-bone-warm"
                  >
                    {onConnect ? 'Reserve your share' : 'Get in touch'}
                    <span aria-hidden>→</span>
                  </Link>
                )}
              </div>
            </Card>
          </Container>
        </section>
      )}

      {/* ── NOTE FROM RANCHER ────────────────────────────────────────────── */}
      {customNotes && (
        <section className="py-16 md:py-20 border-t border-dust/40">
          <Container>
            <div className="max-w-3xl mx-auto space-y-4">
              <Pill tone="neutral">A note from the ranch</Pill>
              <h2 className="font-serif text-2xl md:text-3xl">
                Direct from {operatorName || name}
              </h2>
              <div className="prose-bhc whitespace-pre-line">{customNotes}</div>
            </div>
          </Container>
        </section>
      )}

      {/* ── PROSPECT CLAIM CTA ───────────────────────────────────────────── */}
      {isProspect && (
        <section className="py-16 md:py-20 border-t border-dust/40">
          <Container>
            <Card
              variant="inverted"
              padding="lg"
              className="max-w-3xl mx-auto text-center space-y-5"
            >
              <Pill tone="amber" className="mx-auto">Are you {name}?</Pill>
              <h2 className="font-serif text-3xl md:text-4xl text-bone">
                Take over this listing
              </h2>
              <p className="text-bone/85 text-sm leading-relaxed max-w-md mx-auto">
                We built this page from public information so families looking for
                direct-to-consumer beef in {state || 'your state'} could find you.
                Claim your listing to take it over and start taking orders through
                BuyHalfCow.
              </p>
              <div className="flex flex-wrap justify-center gap-3 pt-2">
                <Link
                  href={`/ranchers/${slug}/claim`}
                  className="inline-flex items-center gap-2 px-7 py-3.5 bg-bone text-charcoal text-sm font-medium tracking-wide uppercase transition-base hover:bg-bone-warm"
                >
                  Claim your listing
                  <span aria-hidden>→</span>
                </Link>
                <Link
                  href={`/ranchers/${slug}/remove`}
                  className="inline-flex items-center self-center text-sm tracking-wide text-bone/60 hover:text-bone underline underline-offset-4 decoration-bone/30"
                >
                  Or remove me from the map
                </Link>
              </div>
            </Card>
          </Container>
        </section>
      )}

      {/* ── FOOTER NAV ───────────────────────────────────────────────────── */}
      <div className="border-t border-dust/40 py-8 md:py-10">
        <Container>
          <div className="max-w-5xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-3 text-sm text-saddle">
            <Link
              href={isProspect ? '/map' : '/ranchers'}
              className="hover:text-charcoal transition-base"
            >
              ← {isProspect ? 'Back to discover map' : 'Browse all ranchers'}
            </Link>
            <Link href="/" className="hover:text-charcoal transition-base">
              BuyHalfCow
            </Link>
          </div>
        </Container>
      </div>
    </main>
  );
}
