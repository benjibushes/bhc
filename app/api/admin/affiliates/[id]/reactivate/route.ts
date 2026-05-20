import { NextResponse } from 'next/server';
import { updateRecord, getRecordById, TABLES } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';

export const maxDuration = 30;

// Admin: reactivate a previously-deactivated affiliate. Clears Deactivated
// At + Deactivation Reason so the audit trail shows ONLY the most-recent
// state.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const __authResp = await requireAdmin(request);
  if (__authResp) return __authResp;

  const { id } = await context.params;
  if (!id || !/^rec[A-Za-z0-9]{14}$/.test(id)) {
    return NextResponse.json({ error: 'Invalid affiliate id' }, { status: 400 });
  }

  try {
    const aff = (await getRecordById(TABLES.AFFILIATES, id)) as any;
    if (!aff) return NextResponse.json({ error: 'Affiliate not found' }, { status: 404 });

    await updateRecord(TABLES.AFFILIATES, id, {
      Status: 'Active',
      'Deactivated At': null,
      'Deactivation Reason': null,
    });

    return NextResponse.json({ ok: true, id, code: aff['Code'] || '' });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Reactivate failed' }, { status: 500 });
  }
}
