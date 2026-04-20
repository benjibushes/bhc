import { NextResponse } from 'next/server';
import { getAllRecords, TABLES } from '@/lib/airtable';

export const revalidate = 300; // Cache for 5 minutes — listings don't change minute-to-minute

// Public endpoint — returns approved land deals for the /land browse page.
// No auth required: land seller wants visibility, buyer wants to browse before
// committing to BuyHalfCow membership.
export async function GET() {
  try {
    const records = await getAllRecords(
      TABLES.LAND_DEALS,
      `{Status} = "Approved"`
    ) as any[];

    const deals = records.map((r) => ({
      id: r.id,
      sellerName: r['Seller Name'] || '',
      propertyType: r['Property Type'] || '',
      acreage: r['Acreage'] || 0,
      state: r['State'] || '',
      county: r['County'] || '',
      propertyLocation: r['Property Location'] || '',
      askingPrice: r['Asking Price'] || r['Price'] || '',
      description: r['Description'] || '',
      zoning: r['Zoning'] || '',
      utilities: r['Utilities'] || '',
      created: r['Created'] || '',
    })).sort((a, b) => {
      // Featured/newest first — for now just newest first
      return new Date(b.created).getTime() - new Date(a.created).getTime();
    });

    return NextResponse.json({ deals });
  } catch (error: any) {
    console.error('Public land deals error:', error);
    return NextResponse.json({ deals: [], error: error.message }, { status: 500 });
  }
}
