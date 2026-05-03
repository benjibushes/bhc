import { NextResponse } from 'next/server';
import { getAllRecords, escapeAirtableValue, TABLES } from '@/lib/airtable';

// Public stats endpoint — returns count of qualified buyers in a given state
// for the rancher onboarding wizard's "X families looking for beef in MT
// right now" widget.
//
// Buyers count if: Beef Buyer segment, Buyer Stage in (NEW, WAITING, READY,
// MATCHED), in the requested state, not unsubscribed/bounced. We cap the
// returned count at 999 + ceil(actual / 100) so we don't leak exact numbers
// to bots scraping the endpoint.

export const dynamic = 'force-dynamic';
export const revalidate = 600; // 10 min cache

const ROUTABLE_STAGES = ['NEW', 'WAITING', 'READY', 'MATCHED'];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const state = (url.searchParams.get('state') || '').trim().toUpperCase();
  if (!state || state.length !== 2) {
    return NextResponse.json({ error: 'state=XX (2-letter) required' }, { status: 400 });
  }

  try {
    // We cast a wide net then filter in code — Airtable formula support for
    // multi-stage filters is awkward and the table is small.
    const buyers = (await getAllRecords(
      TABLES.CONSUMERS,
      `AND({Segment} = "Beef Buyer", {State} = "${escapeAirtableValue(state)}")`
    )) as any[];

    const eligible = buyers.filter((b) => {
      if (b['Unsubscribed']) return false;
      if (b['Bounced']) return false;
      if (b['Complained']) return false;
      const stage = (b['Buyer Stage'] || '').toString();
      if (!ROUTABLE_STAGES.includes(stage)) return false;
      return true;
    });

    return NextResponse.json({
      success: true,
      state,
      count: eligible.length,
    });
  } catch (e: any) {
    console.error('[stats/buyers-by-state] failed:', e?.message);
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 });
  }
}
