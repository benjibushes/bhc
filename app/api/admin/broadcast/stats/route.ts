import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET() {
  try {
    const consumers = await getAllRecords(TABLES.CONSUMERS);
    const ranchers = await getAllRecords(TABLES.RANCHERS);

    // Count consumers by state
    const byState: Record<string, number> = {};
    consumers.forEach((consumer: any) => {
      const state = consumer.fields?.['State'];
      if (state) {
        byState[state] = (byState[state] || 0) + 1;
      }
    });

    return NextResponse.json({
      allConsumers: consumers.length,
      allRanchers: ranchers.length,
      byState,
    });
  } catch (error: any) {
    console.error('Error fetching broadcast stats:', error);
    return NextResponse.json({ error: error.message || 'Failed to fetch stats' }, { status: 500 });
  }
}


