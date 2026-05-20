import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import Pill from '../../components/Pill';
import Card from '../../components/Card';
import ProspectClaimBanner from '../../components/ProspectClaimBanner';
import { getRancherOrProspectBySlug, getActiveRancherPages } from '@/lib/airtable';
import RancherOrderForm from './RancherOrderForm';

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
  const logo = rancher['Logo URL'] || '';

  return {
    title: isProspect ? `${name} — Unclaimed Listing` : name,
    description: tagline,
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
  const tagline = r['Tagline'] || '';
  const logoUrl = r['Logo URL'] || '';
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
  const googleReviewsUrl = r['Google Reviews URL'] || '';
  const facebookUrl = r['Facebook URL'] || '';
  const instagramUrl = r['Instagram URL'] || '';
  const processingFacility = r['Processing Facility'] || '';

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

  let galleryPhotos: string[] = [];
  try {
    if (r['Gallery Photos']) galleryPhotos = JSON.parse(r['Gallery Photos']);
  } catch (e) { logBadJson('Gallery Photos', e); }

  let customProducts: { name: string; price: number; description: string; link: string }[] = [];
  try {
    if (r['Custom Products']) customProducts = JSON.parse(r['Custom Products']);
  } catch (e) { logBadJson('Custom Products', e); }

  const quarterPrice = r['Quarter Price'];
  const quarterLbs = r['Quarter lbs'] || '';
  const quarterLink = r['Quarter Payment Link'] || '';
  const halfPrice = r['Half Price'];
  const halfLbs = r['Half lbs'] || '';
  const halfLink = r['Half Payment Link'] || '';
  const wholePrice = r['Whole Price'];
  const wholeLbs = r['Whole lbs'] || '';
  const wholeLink = r['Whole Payment Link'] || '';

  const hasPricing = !isProspect && (quarterPrice || halfPrice || wholePrice);
  const embedUrl = getYouTubeEmbedUrl(videoUrl);

  // Cover photo — first gallery photo if available, else null. We layer a
  // dark gradient over it so hero text stays readable on any image.
  const coverPhoto = galleryPhotos[0] || '';

  const lat = Number(r['Latitude']);
  const lng = Number(r['Longitude']);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';
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
    ...(isProspect
      ? {
          disambiguatingDescription:
            'Unclaimed listing — built from public information. The operator has not yet verified this listing on BuyHalfCow.',
        }
      : {}),
  };

  const processingDateDisplay = nextProcessingDate
    ? new Date(nextProcessingDate).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : null;

  const locationLine = [city, state].filter(Boolean).join(', ');

  return (
    <main className="min-h-screen bg-bone text-charcoal">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
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
          {coverPhoto ? (
            <>
              <Image
                src={coverPhoto}
                alt={`${name} cover`}
                fill
                className="object-cover"
                priority
                unoptimized
                sizes="100vw"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-charcoal/85 via-charcoal/50 to-charcoal/30" />
            </>
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-charcoal via-divider to-saddle" />
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
                {certifications && (
                  <Pill tone="inverted" icon={<span aria-hidden>★</span>}>
                    {certifications}
                  </Pill>
                )}
              </div>

              {/* Logo + name */}
              <div className="flex items-center gap-5">
                {logoUrl && (
                  <div className="relative h-20 w-20 md:h-24 md:w-24 shrink-0 bg-bone p-2 border border-bone/40">
                    <Image
                      src={logoUrl}
                      alt={`${name} logo`}
                      fill
                      className="object-contain"
                      unoptimized
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
                  <a
                    href="#shares"
                    className="inline-flex items-center gap-2 px-7 py-3.5 bg-bone text-charcoal text-sm font-medium tracking-wide uppercase transition-base hover:bg-bone-warm"
                  >
                    See pricing
                    <span aria-hidden>↓</span>
                  </a>
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
            </div>
          </div>
        </Container>
      </section>

      {/* ── QUICK FACTS STRIP ────────────────────────────────────────────────
          Compact dark band right under hero — same width-constrained band
          for processing date + USDA facility + states served. Replaces the
          old "social proof" section that was floating awkwardly mid-page.
         ───────────────────────────────────────────────────────────────────── */}
      {(processingDateDisplay || processingFacility || statesServed) && (
        <section className="bg-bone-warm border-b border-dust">
          <Container>
            <div className="py-5 md:py-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-sm text-charcoal/85">
              {processingDateDisplay && (
                <span>
                  <span className="text-saddle">Next processing</span>{' '}
                  <strong>{processingDateDisplay}</strong>
                </span>
              )}
              {processingFacility && (
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
                  All prices include processing. {operatorName ? operatorName.split(' ')[0] : name} reaches back out within 48h to confirm timing + payment.
                </p>
              </div>

              <RancherOrderForm
                slug={slug}
                rancherName={operatorName || name}
                ranchName={name}
                quarter={quarterPrice ? { price: quarterPrice, lbs: quarterLbs } : undefined}
                half={halfPrice ? { price: halfPrice, lbs: halfLbs } : undefined}
                whole={wholePrice ? { price: wholePrice, lbs: wholeLbs } : undefined}
              />

              <p className="text-center text-xs text-dust">
                Prices in USD. Questions?{' '}
                <Link href="/access" className="underline underline-offset-2 hover:text-charcoal">
                  Contact BuyHalfCow
                </Link>
              </p>
            </div>
          </Container>
        </section>
      )}

      {/* ── ABOUT + VIDEO ────────────────────────────────────────────────────
          Two-column on desktop (text left, video right) — gives both equal
          weight without the old stacked layout that hid the video.
         ───────────────────────────────────────────────────────────────────── */}
      {(aboutText || embedUrl) && (
        <section className="py-16 md:py-20 bg-bone-warm border-y border-dust/60">
          <Container>
            <div className="max-w-5xl mx-auto grid md:grid-cols-2 gap-10 lg:gap-14 items-start">
              {aboutText && (
                <div className="space-y-5">
                  <Pill tone="neutral">About</Pill>
                  <h2 className="font-serif text-3xl md:text-4xl">
                    Meet {operatorName ? operatorName.split(' ')[0] : name}
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
      )}

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
                      unoptimized
                      sizes="(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw"
                    />
                  </div>
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
                          unoptimized
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
         ───────────────────────────────────────────────────────────────────── */}
      <section className="py-16 md:py-20">
        <Container>
          <div className="max-w-5xl mx-auto space-y-10">
            <div className="text-center space-y-2">
              <Pill tone="neutral" className="mx-auto">How it works</Pill>
              <h2 className="font-serif text-3xl md:text-4xl">Direct from {name} to your freezer</h2>
            </div>
            <div className="grid md:grid-cols-3 gap-5 md:gap-6">
              {[
                {
                  num: '01',
                  title: 'Choose your share',
                  blurb: 'Quarter, half, or whole — based on your family and freezer space.',
                },
                {
                  num: '02',
                  title: 'Pay & confirm',
                  blurb: `Secure your share with a deposit. ${name} reaches out to confirm cut sheet, timing, pickup.`,
                },
                {
                  num: '03',
                  title: 'Pickup or delivery',
                  blurb: 'Custom butchered, vacuum-sealed, packed into coolers. Ready on processing day.',
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
                    {product.link && (
                      <a
                        href={product.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block w-full text-center mt-5 px-6 py-3 border border-charcoal text-sm font-medium tracking-wide uppercase transition-base hover:bg-charcoal hover:text-bone"
                      >
                        Buy now
                      </a>
                    )}
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
              <p className="text-bone/75 text-sm leading-relaxed max-w-md mx-auto">
                A small deposit holds your share. Reserve before the processing date
                fills up.
              </p>
              <div className="pt-2">
                {reserveLink ? (
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
                    href="/access"
                    className="inline-flex items-center gap-2 px-7 py-3.5 bg-bone text-charcoal text-sm font-medium tracking-wide uppercase transition-base hover:bg-bone-warm"
                  >
                    Get in touch
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
