import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord, TABLES } from '@/lib/airtable';

export const maxDuration = 300;

// One-time data migration: populate Segment for the ~971 consumers whose
// Segment field is blank. The matching engine REQUIRES Segment="Beef Buyer"
// before it'll route a buyer to a rancher, so blanks are silently skipped.
//
// Rule (mirrors batch-approve cron line 113):
//   hasOrderType OR hasBudget(not "<$500"/"Not Sure") → "Beef Buyer"
//   else                                              → "Community"
//
// Outside /api/admin/* on purpose so middleware doesn't gate it.
// Password-gated. Add ?dry=1 for a no-op preview.
//
// Usage: GET /api/maintenance-backfill-segment?password=ADMIN_PASSWORD[&dry=1]
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const password = searchParams.get('password');
  const dry = searchParams.get('dry') === '1';

  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const consumers = await getAllRecords(TABLES.CONSUMERS) as any[];
  const blank = consumers.filter((c: any) => {
    const seg = c['Segment']?.name || c['Segment'];
    return !seg;
  });

  let beefBuyer = 0;
  let community = 0;
  let updated = 0;
  const errors: string[] = [];

  for (const c of blank) {
    const orderType = c['Order Type']?.name || c['Order Type'];
    const budget = c['Budget']?.name || c['Budget'];
    const hasOrderType = orderType && orderType !== 'Not Sure';
    const hasBudget = budget && budget !== '<$500' && budget !== 'Not Sure';
    const isBeefBuyer = hasOrderType || hasBudget;
    const segment = isBeefBuyer ? 'Beef Buyer' : 'Community';

    if (isBeefBuyer) beefBuyer++; else community++;

    if (!dry) {
      try {
        await updateRecord(TABLES.CONSUMERS, c.id, { 'Segment': segment });
        updated++;
      } catch (e: any) {
        errors.push(`${c.id}: ${e.message}`);
      }
    }
  }

  return NextResponse.json({
    success: true,
    dry,
    totalConsumers: consumers.length,
    blankSegment: blank.length,
    classifiedAsBeefBuyer: beefBuyer,
    classifiedAsCommunity: community,
    actuallyUpdated: updated,
    errors: errors.slice(0, 20),
    errorCount: errors.length,
  });
}
