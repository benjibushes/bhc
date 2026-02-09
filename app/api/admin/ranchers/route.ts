import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET() {
  try {
    const ranchers = await getAllRecords(TABLES.RANCHERS);
    return NextResponse.json(ranchers);
  } catch (error: any) {
    console.error('API error fetching ranchers:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
