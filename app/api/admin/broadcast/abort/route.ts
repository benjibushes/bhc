import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { getAllRecords, updateRecord, escapeAirtableValue, TABLES } from '@/lib/airtable';

// Emergency abort for a mid-flight broadcast. P0 audit fix (C-4): a misfired
// 1500-buyer broadcast had no way to stop — once the Promise.allSettled batch
// loop started, it ran until maxDuration or completion. Now: flip the
// Campaigns row Status to 'Aborting' and the send loop polls between
// batches and bails.
export async function POST(request: Request) {
  const authResp = await requireAdmin(request);
  if (authResp) return authResp;

  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { campaignName } = body || {};
    if (!campaignName || typeof campaignName !== 'string') {
      return NextResponse.json({ error: 'campaignName required' }, { status: 400 });
    }

    const matches = await getAllRecords(
      TABLES.CAMPAIGNS,
      `{Campaign Name} = "${escapeAirtableValue(campaignName)}"`,
    );
    if (!matches.length) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
    }

    // Find the most recent 'Sending' row — there may be multiple historical
    // rows w/ the same name from prior tests but we only abort the live one.
    const sendingRow: any = matches.find(
      (r: any) => (r['Status'] || '') === 'Sending',
    );
    if (!sendingRow) {
      return NextResponse.json({
        error: 'No mid-flight send to abort',
        currentStatus: (matches[0] as any)['Status'] || 'unknown',
      }, { status: 409 });
    }

    await updateRecord(TABLES.CAMPAIGNS, sendingRow.id, { Status: 'Aborting' });

    return NextResponse.json({
      success: true,
      campaignName,
      campaignId: sendingRow.id,
      message: 'Abort flag set — send loop will exit at next batch boundary',
    });
  } catch (error: any) {
    console.error('broadcast/abort error:', error);
    return NextResponse.json(
      { error: 'Server error', detail: error?.message || 'unknown' },
      { status: 500 },
    );
  }
}
