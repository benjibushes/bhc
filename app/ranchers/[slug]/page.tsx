import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import Container from '../../components/Container';
import Divider from '../../components/Divider';
import { getRancherBySlug, getActiveRancherPages } from '@/lib/airtable';
import RancherLeadModal from './RancherLeadModal';

// Revalidate every 10 minutes
export const revalidate = 600;

// Pre-generate pages for known slugs at build time
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
  const rancher: any = await getRancherBySlug(slug);
  if (!rancher) return { title: 'Rancher Not Found' };

  const name = rancher['Ranch Name'] || rancher['Operator Name'] || 'Ranch';
  const tagline = rancher['Tagline'] || `Buy direct from ${name} on BuyHalfCow`;
  const logo = rancher['Logo URL'] || '';

  return {
    title: name,
    description: tagline,
    openGraph: {
      title: `${name} — BuyHalfCow`,
      description: tagline,
      ...(logo && { images: [{ url: logo, width: 800, height: 600, alt: name }] }),
    },
  };
}

// ─── YouTube embed helper ───────────────────────────────────────────────────

function getYouTubeEmbedUrl(url: string): string | null {
  if (!url) return null;
  // Handle youtu.be short links
  const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return `https://www.youtube.com/embed/${shortMatch[1]}`;
  // Handle youtube.com/watch?v=
  const longMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (longMatch) return `https://www.youtube.com/embed/${longMatch[1]}`;
  // Already an embed URL or other format — return as-is
  if (url.includes('youtube.com/embed') || url.includes('vimeo.com')) return url;
  return null;
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default async function RancherPage(
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const rancherRaw: any = await getRancherBySlug(slug);
  if (!rancherRaw) notFound();

  const r = rancherRaw;
  const name = r['Ranch Name'] || r['Operator Name'] || 'Ranch';
  const operatorName = r['Operator Name'] || '';
  const tagline = r['Tagline'] || '';
  const logoUrl = r['Logo URL'] || '';
  const aboutText = r['About Text'] || '';
  const videoUrl = r['Video URL'] || '';
  const state = r['State'] || '';
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

  // Parse testimonials JSON: [{name, quote, location?, photo?}]
  let testimonials: { name: string; quote: string; location?: string; photo?: string }[] = [];
  try {
    const raw = r['Testimonials'] || '';
    if (raw) testimonials = JSON.parse(raw);
  } catch { /* ignore parse errors */ }

  // Parse gallery photos JSON: string[]
  let galleryPhotos: string[] = [];
  try {
    const raw = r['Gallery Photos'] || '';
    if (raw) galleryPhotos = JSON.parse(raw);
  } catch { /* ignore parse errors */ }

  const quarterPrice = r['Quarter Price'];
  const quarterLbs = r['Quarter lbs'] || '';
  const quarterLink = r['Quarter Payment Link'] || '';
  const halfPrice = r['Half Price'];
  const halfLbs = r['Half lbs'] || '';
  const halfLink = r['Half Payment Link'] || '';
  const wholePrice = r['Whole Price'];
  const wholeLbs = r['Whole lbs'] || '';
  const wholeLink = r['Whole Payment Link'] || '';

  const hasPricing = quarterPrice || halfPrice || wholePrice;
  const embedUrl = getYouTubeEmbedUrl(videoUrl);

  const processingDateDisplay = nextProcessingDate
    ? new Date(nextProcessingDate).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : null;

  return (
    <main className="min-h-screen bg-[#F4F1EC] text-[#0E0E0E]">

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="py-20 border-b border-[#2A2A2A]/10">
        <Container>
          <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center gap-10">
            {/* Logo */}
            <div className="flex-shrink-0">
              {logoUrl ? (
                <Image
                  src={logoUrl}
                  alt={`${name} logo`}
                  width={180}
                  height={180}
                  className="object-contain max-h-40"
                  unoptimized
                />
              ) : (
                <div className="w-32 h-32 border border-[#A7A29A] flex items-center justify-center">
                  <span className="font-[family-name:var(--font-playfair)] text-5xl text-[#A7A29A]">
                    {name.charAt(0)}
                  </span>
                </div>
              )}
            </div>

            {/* Name + meta */}
            <div className="space-y-4 text-center md:text-left">
              <p className="text-xs uppercase tracking-widest text-[#6B4F3F]">
                BuyHalfCow Verified Partner
              </p>
              <h1 className="font-[family-name:var(--font-playfair)] text-4xl md:text-5xl">
                {name}
              </h1>
              {tagline && (
                <p className="text-xl text-[#6B4F3F]">{tagline}</p>
              )}
              <div className="flex flex-wrap justify-center md:justify-start gap-2 pt-1">
                {state && (
                  <span className="text-xs border border-[#A7A29A] px-3 py-1 text-[#6B4F3F]">
                    {state}
                  </span>
                )}
                {beefTypes && (
                  <span className="text-xs border border-[#A7A29A] px-3 py-1 text-[#6B4F3F]">
                    {beefTypes}
                  </span>
                )}
                {statesServed && statesServed !== state && (
                  <span className="text-xs border border-[#A7A29A] px-3 py-1 text-[#6B4F3F]">
                    Ships to: {statesServed}
                  </span>
                )}
                {certifications && (
                  <span className="text-xs border border-[#8C2F2F] px-3 py-1 text-[#8C2F2F]">
                    ✓ {certifications}
                  </span>
                )}
              </div>
            </div>
          </div>
        </Container>
      </section>

      {/* ── About + Video ─────────────────────────────────────────────────── */}
      {(aboutText || embedUrl) && (
        <section className="py-16">
          <Container>
            <div className="max-w-4xl mx-auto space-y-10">
              {aboutText && (
                <div className="space-y-4">
                  <h2 className="font-[family-name:var(--font-playfair)] text-3xl">
                    About {name}
                  </h2>
                  <div className="prose prose-lg max-w-none text-[#0E0E0E]/80 leading-relaxed whitespace-pre-line">
                    {aboutText}
                  </div>
                </div>
              )}

              {embedUrl && (
                <div className="space-y-4">
                  <h2 className="font-[family-name:var(--font-playfair)] text-2xl">
                    Watch Our Interview{operatorName ? ` with ${operatorName}` : ''}
                  </h2>
                  <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
                    <iframe
                      src={embedUrl}
                      title={`${name} interview`}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                      className="absolute inset-0 w-full h-full border border-[#A7A29A]"
                    />
                  </div>
                </div>
              )}
            </div>
          </Container>
        </section>
      )}

      {/* ── Photo Gallery ─────────────────────────────────────────────── */}
      {galleryPhotos.length > 0 && (
        <section className="py-16 border-b border-[#2A2A2A]/10">
          <Container>
            <div className="max-w-5xl mx-auto space-y-8">
              <h2 className="font-[family-name:var(--font-playfair)] text-3xl text-center">
                Our Operation
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {galleryPhotos.map((url, i) => (
                  <div key={i} className="relative aspect-square overflow-hidden border border-[#A7A29A]">
                    <Image
                      src={url}
                      alt={`${name} ranch photo ${i + 1}`}
                      fill
                      className="object-cover"
                      unoptimized
                    />
                  </div>
                ))}
              </div>
            </div>
          </Container>
        </section>
      )}

      {/* ── Testimonials ───────────────────────────────────────────────── */}
      {testimonials.length > 0 && (
        <section className="py-16 bg-white border-b border-[#A7A29A]/40">
          <Container>
            <div className="max-w-4xl mx-auto space-y-8">
              <h2 className="font-[family-name:var(--font-playfair)] text-3xl text-center">
                What Customers Say
              </h2>
              <div className="grid md:grid-cols-2 gap-6">
                {testimonials.map((t, i) => (
                  <div key={i} className="p-6 border border-[#A7A29A] space-y-4">
                    <p className="text-[#0E0E0E]/80 leading-relaxed italic">
                      &ldquo;{t.quote}&rdquo;
                    </p>
                    <div className="flex items-center gap-3">
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
                        <div className="w-10 h-10 border border-[#A7A29A] flex items-center justify-center rounded-full">
                          <span className="text-sm text-[#A7A29A]">{t.name.charAt(0)}</span>
                        </div>
                      )}
                      <div>
                        <p className="text-sm font-medium">{t.name}</p>
                        {t.location && (
                          <p className="text-xs text-[#A7A29A]">{t.location}</p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Container>
        </section>
      )}

      {/* ── Social Proof + Facility ─────────────────────────────────────── */}
      {(processingFacility || googleReviewsUrl || facebookUrl || instagramUrl) && (
        <section className="py-10 border-b border-[#2A2A2A]/10">
          <Container>
            <div className="max-w-4xl mx-auto flex flex-wrap justify-center items-center gap-6 text-sm">
              {processingFacility && (
                <span className="text-[#6B4F3F]">
                  🏭 USDA Inspected: {processingFacility}
                </span>
              )}
              {googleReviewsUrl && (
                <a href={googleReviewsUrl} target="_blank" rel="noopener noreferrer"
                   className="text-[#6B4F3F] hover:text-[#0E0E0E] underline transition-colors">
                  ⭐ Google Reviews
                </a>
              )}
              {facebookUrl && (
                <a href={facebookUrl} target="_blank" rel="noopener noreferrer"
                   className="text-[#6B4F3F] hover:text-[#0E0E0E] underline transition-colors">
                  Facebook
                </a>
              )}
              {instagramUrl && (
                <a href={instagramUrl} target="_blank" rel="noopener noreferrer"
                   className="text-[#6B4F3F] hover:text-[#0E0E0E] underline transition-colors">
                  Instagram
                </a>
              )}
            </div>
          </Container>
        </section>
      )}

      {/* ── How It Works ─────────────────────────────────────────────────── */}
      <section className="py-14 bg-white border-y border-[#A7A29A]/40">
        <Container>
          <div className="max-w-4xl mx-auto space-y-8">
            <h2 className="font-[family-name:var(--font-playfair)] text-3xl text-center">
              How It Works
            </h2>
            <div className="grid md:grid-cols-3 gap-6">
              <div className="p-6 border border-[#A7A29A] space-y-2">
                <p className="text-2xl font-[family-name:var(--font-playfair)] text-[#6B4F3F]">01</p>
                <h3 className="font-medium">Choose Your Share</h3>
                <p className="text-sm text-[#A7A29A] leading-relaxed">
                  Select a quarter, half, or whole cow based on your family's needs and freezer space.
                </p>
              </div>
              <div className="p-6 border border-[#A7A29A] space-y-2">
                <p className="text-2xl font-[family-name:var(--font-playfair)] text-[#6B4F3F]">02</p>
                <h3 className="font-medium">Pay &amp; Confirm</h3>
                <p className="text-sm text-[#A7A29A] leading-relaxed">
                  Secure your share with a payment or deposit. {name} will reach out to confirm details.
                </p>
              </div>
              <div className="p-6 border border-[#A7A29A] space-y-2">
                <p className="text-2xl font-[family-name:var(--font-playfair)] text-[#6B4F3F]">03</p>
                <h3 className="font-medium">Pick Up or Deliver</h3>
                <p className="text-sm text-[#A7A29A] leading-relaxed">
                  Your beef is custom butchered and ready for pickup or delivery on processing day.
                </p>
              </div>
            </div>
          </div>
        </Container>
      </section>

      {/* ── Pricing ──────────────────────────────────────────────────────── */}
      {hasPricing && (
        <section className="py-16">
          <Container>
            <div className="max-w-4xl mx-auto space-y-8">
              <div className="text-center space-y-3">
                <h2 className="font-[family-name:var(--font-playfair)] text-3xl">
                  Choose Your Share
                </h2>
                <p className="text-[#A7A29A]">
                  All prices include processing. Custom cuts available at no extra charge.
                </p>
              </div>

              <RancherLeadModal
                slug={slug}
                rancherName={name}
                quarter={quarterPrice ? { price: quarterPrice, lbs: quarterLbs, hasLink: !!quarterLink } : undefined}
                half={halfPrice ? { price: halfPrice, lbs: halfLbs, hasLink: !!halfLink } : undefined}
                whole={wholePrice ? { price: wholePrice, lbs: wholeLbs, hasLink: !!wholeLink } : undefined}
              />

              <p className="text-center text-sm text-[#A7A29A]">
                Prices listed in USD. Questions?{' '}
                <Link href="/access" className="underline hover:text-[#0E0E0E]">
                  Contact BuyHalfCow
                </Link>
              </p>
            </div>
          </Container>
        </section>
      )}

      {/* ── Reserve ──────────────────────────────────────────────────────── */}
      {(processingDateDisplay || reserveLink) && (
        <>
          <Divider />
          <section className="py-14">
            <Container>
              <div className="max-w-2xl mx-auto text-center space-y-5">
                <h2 className="font-[family-name:var(--font-playfair)] text-2xl">
                  Not Ready to Commit?
                </h2>
                {processingDateDisplay && (
                  <p className="text-[#6B4F3F]">
                    Next processing date: <strong>{processingDateDisplay}</strong>
                  </p>
                )}
                <p className="text-[#A7A29A] text-sm leading-relaxed">
                  Reserve your spot before the processing date fills up. A small deposit holds your share.
                </p>
                {reserveLink ? (
                  <a
                    href={reserveLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block px-8 py-3 border border-[#6B4F3F] text-[#6B4F3F] text-sm tracking-wide hover:bg-[#6B4F3F] hover:text-[#F4F1EC] transition-colors"
                  >
                    Reserve Your Share →
                  </a>
                ) : (
                  <Link
                    href="/access"
                    className="inline-block px-8 py-3 border border-[#6B4F3F] text-[#6B4F3F] text-sm tracking-wide hover:bg-[#6B4F3F] hover:text-[#F4F1EC] transition-colors"
                  >
                    Get In Touch →
                  </Link>
                )}
              </div>
            </Container>
          </section>
        </>
      )}

      {/* ── Custom Notes ─────────────────────────────────────────────────── */}
      {customNotes && (
        <>
          <Divider />
          <section className="py-14">
            <Container>
              <div className="max-w-3xl mx-auto space-y-4">
                <h2 className="font-[family-name:var(--font-playfair)] text-2xl">
                  A Note from {name}
                </h2>
                <p className="text-[#0E0E0E]/80 leading-relaxed whitespace-pre-line">
                  {customNotes}
                </p>
              </div>
            </Container>
          </section>
        </>
      )}

      {/* ── Footer Nav ───────────────────────────────────────────────────── */}
      <div className="border-t border-[#2A2A2A]/10 py-10">
        <Container>
          <div className="max-w-4xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4 text-sm text-[#A7A29A]">
            <Link href="/ranchers" className="hover:text-[#0E0E0E] transition-colors">
              ← Browse All Ranchers
            </Link>
            <Link href="/" className="hover:text-[#0E0E0E] transition-colors">
              BuyHalfCow
            </Link>
          </div>
        </Container>
      </div>

    </main>
  );
}
