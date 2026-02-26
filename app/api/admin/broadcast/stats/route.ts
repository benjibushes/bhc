import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET() {
  try {
    const consumers = await getAllRecords(TABLES.CONSUMERS);
    const ranchers = await getAllRecords(TABLES.RANCHERS);

    const byState: Record<string, number> = {};
    let beefBuyers = 0;
    let community = 0;

    consumers.forEach((consumer: any) => {
      const state = consumer['State'];
      if (state) {
        byState[state] = (byState[state] || 0) + 1;
      }
      const segment = consumer['Segment'] || '';
      if (segment === 'Beef Buyer') beefBuyers++;
      else if (segment === 'Community') community++;
      else community++; // Default unsegmented consumers to community count
    });

    return NextResponse.json({
      allConsumers: consumers.length,
      allRanchers: ranchers.length,
      byState,
      beefBuyers,
      community,
    });
  } catch (error: any) {
    console.error('Error fetching broadcast stats:', error);
    return NextResponse.json({ error: error.message || 'Failed to fetch stats' }, { status: 500 });
  }
}


