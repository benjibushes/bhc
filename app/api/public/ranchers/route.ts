import { NextResponse } from 'next/server';
import { getActiveRancherPages } from '@/lib/airtable';

// Public endpoint — returns all ranchers with Page Live = true
// Only exposes fields needed for the directory listing (no PII)
export async function GET() {
  try {
    const ranchers = await getActiveRancherPages();

    const safe = ranchers.map((r: any) => ({
      id: r.id,
      slug: r['Slug'] || '',
      ranch_name: r['Ranch Name'] || '',
      operator_name: r['Operator Name'] || '',
      tagline: r['Tagline'] || '',
      logo_url: r['Logo URL'] || '',
      state: r['State'] || '',
      beef_types: r['Beef Types'] || '',
      states_served: r['States Served'] || '',
      next_processing_date: r['Next Processing Date'] || '',
      quarter_price: r['Quarter Price'] || null,
      half_price: r['Half Price'] || null,
      whole_price: r['Whole Price'] || null,
    }));

    return NextResponse.json({ ranchers: safe });
  } catch (error: any) {
    console.error('Error fetching public rancher pages:', error);
    return NextResponse.json({ error: 'Failed to load ranchers' }, { status: 500 });
  }
}
