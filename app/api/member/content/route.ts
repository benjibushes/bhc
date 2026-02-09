import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET() {
  try {
    // Fetch approved/certified content only
    const [ranchers, landDeals, brands] = await Promise.all([
      getAllRecords(TABLES.RANCHERS, "{Certified} = TRUE()"),
      getAllRecords(TABLES.LAND_DEALS, "{Status} = 'Approved'"),
      getAllRecords(TABLES.BRANDS, "{Featured} = TRUE()"),
    ]);

    return NextResponse.json({
      ranchers,
      landDeals,
      brands,
    });
  } catch (error: any) {
    console.error('API error fetching member content:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
