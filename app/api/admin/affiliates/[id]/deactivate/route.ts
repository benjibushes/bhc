import { NextResponse } from 'next/server';
import { updateRecord, getRecordById, TABLES } from '@/lib/airtable';
import { requireAdmin } from '@/lib/adminAuth';

export const maxDuration = 30;

// Admin: deactivate an affiliate. Flips Status='Inactive' (the canonical
// gate read by validateAffiliateRefForSignup + affiliate dashboard auth),
// stamps Deactivated At, and persists the reason. Affiliate's existing
// historical attribution stays intact — only future ?ref=CODE links go
// inert.
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

  let reason = '';
  try {
    const body = await request.json();
    if (typeof body?.reason === 'string') reason = body.reason.slice(0, 500);
  } catch {}

  try {
    const aff = (await getRecordById(TABLES.AFFILIATES, id)) as any;
    if (!aff) return NextResponse.json({ error: 'Affiliate not found' }, { status: 404 });

    await updateRecord(TABLES.AFFILIATES, id, {
      Status: 'Inactive',
      'Deactivated At': new Date().toISOString(),
      'Deactivation Reason': reason || 'no reason given',
    });

    return NextResponse.json({
      ok: true,
      id,
      code: aff['Code'] || '',
      previousStatus: aff['Status'] || '',
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Deactivate failed' }, { status: 500 });
  }
}
