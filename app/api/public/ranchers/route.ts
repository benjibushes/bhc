import { NextResponse } from 'next/server';
import { getActiveRancherPages } from '@/lib/airtable';
import { normalizeImageUrl } from '@/lib/imageUrl';

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
      // Normalize sharing URLs (Dropbox, Google Drive) to raw image
      // URLs so <img src> renders the actual logo. Audited 2026-05-25:
      // 2 ranchers had pasted sharing URLs that returned HTML preview
      // pages instead of bytes.
      logo_url: normalizeImageUrl((r['Logo URL'] || '').toString()),
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
