import { NextResponse } from 'next/server';
import { updateRecord, getRecordById, TABLES } from '@/lib/airtable';
import { sendTelegramUpdate } from '@/lib/telegram';
import { requireAdmin } from '@/lib/adminAuth';
import { getMaxActiveReferrals } from '@/lib/rancherCapacity';
import { logAuditEntry, buildAirtableUpdateReverse } from '@/lib/auditLog';

// POST /api/admin/ranchers/[id]/resume
// Reactivates a paused rancher. Returns them to Active Status so matching resumes.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const __authResp = await requireAdmin(request);
    if (__authResp) return __authResp;
    const { id } = await params;
    const rancher: any = await getRecordById(TABLES.RANCHERS, id);
    if (!rancher) {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
    const cap = getMaxActiveReferrals(rancher);
    const current = Number(rancher['Current Active Referrals']) || 0;
    const newStatus = current >= cap ? 'At Capacity' : 'Active';

    await updateRecord(TABLES.RANCHERS, id, {
      'Active Status': newStatus,
    });

    // P1 audit D-3: log resume so we can trace mid-incident reactivations
    try {
      await logAuditEntry({
        actor: 'manual',
        tool: 'admin-rancher-resume',
        targetType: 'Rancher',
        targetId: id,
        args: { rancherId: id },
        result: { activeStatus: newStatus, capacity: `${current}/${cap}` },
        reverseAction: buildAirtableUpdateReverse(TABLES.RANCHERS, id, {
          'Active Status': rancher['Active Status'] || null,
        }),
      });
    } catch (e: any) {
      console.error('[resume] audit log failed (non-fatal):', e?.message);
    }

    await sendTelegramUpdate(`▶️ <b>Rancher resumed</b>: ${name}`).catch(() => {});

    return NextResponse.json({ success: true, message: `${name} resumed. Matching engine will start routing leads again.` });
  } catch (error: any) {
    console.error('Resume rancher error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
