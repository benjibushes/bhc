import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET() {
  try {
    const brands = await getAllRecords(TABLES.BRANDS);
    return NextResponse.json(brands);
  } catch (error: any) {
    console.error('API error fetching brands:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
