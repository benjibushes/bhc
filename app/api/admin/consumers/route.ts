import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET() {
  try {
    const consumers = await getAllRecords(TABLES.CONSUMERS);
    return NextResponse.json(consumers);
  } catch (error: any) {
    console.error('API error fetching consumers:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
