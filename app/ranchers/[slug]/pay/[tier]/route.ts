import { NextResponse } from 'next/server';
import { getRancherBySlug, updateRecord, TABLES } from '@/lib/airtable';

// Tracking redirect: /ranchers/[slug]/pay/[tier]
// Logs the click, appends UTM params, then redirects to the rancher's payment link.
// tier must be: quarter | half | whole

const TIER_CONFIG: Record<string, {
  clickField: string;
  linkField: string;
  label: string;
}> = {
  quarter: {
    clickField: 'Quarter Clicks',
    linkField: 'Quarter Payment Link',
    label: 'Quarter Share',
  },
  half: {
    clickField: 'Half Clicks',
    linkField: 'Half Payment Link',
    label: 'Half Share',
  },
  whole: {
    clickField: 'Whole Clicks',
    linkField: 'Whole Payment Link',
    label: 'Whole Share',
  },
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; tier: string }> }
) {
  const { slug, tier } = await params;
  const config = TIER_CONFIG[tier.toLowerCase()];
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

  // Invalid tier — redirect back to ranch page
  if (!config) {
    return NextResponse.redirect(`${siteUrl}/ranchers/${slug}`, { status: 302 });
  }

  try {
    const rancher: any = await getRancherBySlug(slug);

    // No rancher or page not live — redirect home
    if (!rancher) {
      return NextResponse.redirect(`${siteUrl}/ranchers`, { status: 302 });
    }

    const paymentLink: string = rancher[config.linkField] || '';

    // ── Log the click (fire-and-forget, don't block the redirect) ──────────
    const currentClicks: number = rancher[config.clickField] || 0;
    updateRecord(TABLES.RANCHERS, rancher.id, {
      [config.clickField]: currentClicks + 1,
    }).catch(err => console.error('Click log failed:', err));

    // ── If no payment link configured, send to ranch page ─────────────────
    if (!paymentLink) {
      return NextResponse.redirect(`${siteUrl}/ranchers/${slug}`, { status: 302 });
    }

    // ── Append UTM params so rancher's analytics sees BHC as source ───────
    const { searchParams } = new URL(request.url);
    const utmSource = searchParams.get('utm_source') || 'bhc';
    const utmMedium = searchParams.get('utm_medium') || 'rancher-page';
    const utmCampaign = searchParams.get('utm_campaign') || slug;
    const utmContent = searchParams.get('utm_content') || tier;

    let destination: URL;
    try {
      destination = new URL(paymentLink);
    } catch {
      // Malformed URL in Airtable — just redirect as-is
      return NextResponse.redirect(paymentLink, { status: 302 });
    }

    destination.searchParams.set('utm_source', utmSource);
    destination.searchParams.set('utm_medium', utmMedium);
    destination.searchParams.set('utm_campaign', utmCampaign);
    destination.searchParams.set('utm_content', utmContent);
    destination.searchParams.set('ref', 'bhc');

    return NextResponse.redirect(destination.toString(), { status: 302 });
  } catch (error: any) {
    console.error(`Pay redirect error [${slug}/${tier}]:`, error);
    // On any error, send to the ranch page rather than a 500
    return NextResponse.redirect(`${siteUrl}/ranchers/${slug}`, { status: 302 });
  }
}
