import { NextResponse } from 'next/server';
import { getRancherBySlug } from '@/lib/airtable';
import { normalizeImageUrl } from '@/lib/imageUrl';

// Public endpoint — returns full landing page data for a single rancher by slug
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  try {
    const rancher = await getRancherBySlug(slug);

    if (!rancher) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const r: any = rancher;

    return NextResponse.json({
      rancher: {
        id: r.id,
        slug: r['Slug'] || '',
        ranch_name: r['Ranch Name'] || '',
        operator_name: r['Operator Name'] || '',
        tagline: r['Tagline'] || '',
        logo_url: normalizeImageUrl((r['Logo URL'] || '').toString()),
        about_text: r['About Text'] || '',
        video_url: r['Video URL'] || '',
        state: r['State'] || '',
        beef_types: r['Beef Types'] || '',
        states_served: r['States Served'] || '',
        certifications: r['Certifications'] || '',
        next_processing_date: r['Next Processing Date'] || '',
        reserve_link: r['Reserve Link'] || '',
        // Raw buy.stripe.com Payment Links are NOT exposed via this API —
        // buyers purchase through the rancher's public page, which routes
        // Connect ranchers on-platform. (SLICE F: the *_buy_url fields that
        // used to be emitted here had zero consumers and were removed.)
        quarter_price: r['Quarter Price'] || null,
        quarter_lbs: r['Quarter lbs'] || '',
        half_price: r['Half Price'] || null,
        half_lbs: r['Half lbs'] || '',
        whole_price: r['Whole Price'] || null,
        whole_lbs: r['Whole lbs'] || '',
        custom_notes: r['Custom Notes'] || '',
      },
    });
  } catch (error: any) {
    console.error(`Error fetching rancher page for slug "${slug}":`, error);
    return NextResponse.json({ error: 'Failed to load rancher' }, { status: 500 });
  }
}
