import { NextResponse } from 'next/server';
import { updateRecord, getRecordById, TABLES } from '@/lib/airtable';
import { sendTelegramUpdate } from '@/lib/telegram';

// POST /api/admin/ranchers/[id]/pause
// Marks rancher Active Status = "Paused" so the matching engine stops routing
// leads to them. Use for vacation, processing months, sickness, etc.
// Body: { reason?: string }
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const reason = (body.reason || '').trim();

    const rancher: any = await getRecordById(TABLES.RANCHERS, id);
    if (!rancher) {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    const current = rancher['Active Status']?.name || rancher['Active Status'];
    if (current === 'Paused') {
      return NextResponse.json({ error: 'Rancher is already paused' }, { status: 400 });
    }

    const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
    const existingNotes = rancher['Verification Notes'] || '';
    const stamp = new Date().toISOString().slice(0, 10);
    const note = `[PAUSED ${stamp}${reason ? ` — ${reason}` : ''}]`;

    await updateRecord(TABLES.RANCHERS, id, {
      'Active Status': 'Paused',
      'Verification Notes': `${note}\n${existingNotes}`.trim(),
    });

    await sendTelegramUpdate(
      `⏸ <b>Rancher paused</b>: ${name}${reason ? `\nReason: ${reason}` : ''}`
    ).catch(() => {});

    return NextResponse.json({ success: true, message: `${name} paused. Matching engine will skip them until resumed.` });
  } catch (error: any) {
    console.error('Pause rancher error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
