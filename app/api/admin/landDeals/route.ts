import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET() {
  try {
    const landDeals = await getAllRecords(TABLES.LAND_DEALS);
    return NextResponse.json(landDeals);
  } catch (error: any) {
    console.error('API error fetching land deals:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
