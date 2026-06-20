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
        quarter_price: r['Quarter Price'] || null,
        quarter_lbs: r['Quarter lbs'] || '',
        // Raw buy.stripe.com Payment Links are NOT exposed — any integrator gets
        // the tracked, fork-aware buy URL instead (Connect → on-site deposit,
        // legacy → Payment Link), so no off-platform link leaks via the API.
        quarter_buy_url: (r['Quarter Price'] || r['Quarter Payment Link']) ? `/ranchers/${slug}/pay/quarter` : '',
        half_price: r['Half Price'] || null,
        half_lbs: r['Half lbs'] || '',
        half_buy_url: (r['Half Price'] || r['Half Payment Link']) ? `/ranchers/${slug}/pay/half` : '',
        whole_price: r['Whole Price'] || null,
        whole_lbs: r['Whole lbs'] || '',
        whole_buy_url: (r['Whole Price'] || r['Whole Payment Link']) ? `/ranchers/${slug}/pay/whole` : '',
        custom_notes: r['Custom Notes'] || '',
      },
    });
  } catch (error: any) {
    console.error(`Error fetching rancher page for slug "${slug}":`, error);
    return NextResponse.json({ error: 'Failed to load rancher' }, { status: 500 });
  }
}
