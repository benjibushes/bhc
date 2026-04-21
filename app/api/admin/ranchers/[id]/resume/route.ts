import { NextResponse } from 'next/server';
import { updateRecord, getRecordById, TABLES } from '@/lib/airtable';
import { sendTelegramUpdate } from '@/lib/telegram';

// POST /api/admin/ranchers/[id]/resume
// Reactivates a paused rancher. Returns them to Active Status so matching resumes.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const rancher: any = await getRecordById(TABLES.RANCHERS, id);
    if (!rancher) {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
    const cap = Number(rancher['Max Active Referalls']) || 5;
    const current = Number(rancher['Current Active Referrals']) || 0;

    await updateRecord(TABLES.RANCHERS, id, {
      'Active Status': current >= cap ? 'At Capacity' : 'Active',
    });

    await sendTelegramUpdate(`▶️ <b>Rancher resumed</b>: ${name}`).catch(() => {});

    return NextResponse.json({ success: true, message: `${name} resumed. Matching engine will start routing leads again.` });
  } catch (error: any) {
    console.error('Resume rancher error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
