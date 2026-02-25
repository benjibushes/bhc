import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

let cachedStats: { rancherCount: number; buyerCount: number; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function GET() {
  try {
    if (cachedStats && Date.now() - cachedStats.timestamp < CACHE_TTL) {
      return NextResponse.json(cachedStats, {
        headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
      });
    }

    const [ranchers, consumers] = await Promise.all([
      getAllRecords(TABLES.RANCHERS),
      getAllRecords(TABLES.CONSUMERS),
    ]);

    const rancherCount = ranchers.length;
    const buyerCount = consumers.length;

    cachedStats = { rancherCount, buyerCount, timestamp: Date.now() };

    return NextResponse.json({ rancherCount, buyerCount }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  } catch (error: any) {
    console.error('Error fetching public stats:', error);
    return NextResponse.json({ rancherCount: 0, buyerCount: 0 }, { status: 500 });
  }
}
