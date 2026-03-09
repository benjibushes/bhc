import { NextResponse } from 'next/server';
import { getRancherBySlug } from '@/lib/airtable';

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
        logo_url: r['Logo URL'] || '',
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
        quarter_payment_link: r['Quarter Payment Link'] || '',
        half_price: r['Half Price'] || null,
        half_lbs: r['Half lbs'] || '',
        half_payment_link: r['Half Payment Link'] || '',
        whole_price: r['Whole Price'] || null,
        whole_lbs: r['Whole lbs'] || '',
        whole_payment_link: r['Whole Payment Link'] || '',
        custom_notes: r['Custom Notes'] || '',
      },
    });
  } catch (error: any) {
    console.error(`Error fetching rancher page for slug "${slug}":`, error);
    return NextResponse.json({ error: 'Failed to load rancher' }, { status: 500 });
  }
}
