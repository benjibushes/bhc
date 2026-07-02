import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { requireCron } from '@/lib/cronAuth';
import { sendTelegramUpdate } from '@/lib/telegram';
import { getMaxActiveReferrals } from '@/lib/rancherCapacity';
import { triggerLaunchWarmup } from '@/lib/triggerLaunchWarmup';

export const maxDuration = 60;

export async function POST(request: Request) {
  // W5 (2026-07-01): migrated to requireCron. The old inline template-literal
  // check accepted the LITERAL header `Bearer undefined` whenever CRON_SECRET
  // was unset (`` `Bearer ${undefined}` `` stringifies), and its `?secret=`
  // fallback leaked the secret into Vercel access logs on manual triggers.
  // requireCron is fail-closed (lib/secrets throws at import if CRON_SECRET
  // is missing), constant-time, and header-only.
  const denied = requireCron(request);
  if (denied) return denied;
  try {
    const ranchers = await getAllRecords(TABLES.RANCHERS);
    const updates: { name: string; oldStatus: string; newStatus: string }[] = [];

    for (const rancher of ranchers as any[]) {
      const current = rancher['Current Active Referrals'] || 0;
      const max = getMaxActiveReferrals(rancher);
      const currentStatus = rancher['Active Status'] || '';

      if (current >= max && currentStatus === 'Active') {
        await updateRecord(TABLES.RANCHERS, rancher.id, {
          'Active Status': 'At Capacity',
        });
        updates.push({
          name: rancher['Operator Name'] || rancher['Ranch Name'] || 'Unknown',
          oldStatus: 'Active',
          newStatus: 'At Capacity',
        });
      } else if (current < max && currentStatus === 'At Capacity') {
        await updateRecord(TABLES.RANCHERS, rancher.id, {
          'Active Status': 'Active',
        });
        triggerLaunchWarmup(`capacity-check-resume:${rancher.id}`);
        updates.push({
          name: rancher['Operator Name'] || rancher['Ranch Name'] || 'Unknown',
          oldStatus: 'At Capacity',
          newStatus: 'Active',
        });
      }
    }

    if (updates.length > 0) {
      const msg = updates.map(u =>
        `${u.name}: ${u.oldStatus} → ${u.newStatus}`
      ).join('\n');

      try {
        await sendTelegramUpdate(`📊 <b>Capacity Update</b>\n\n${msg}`);
      } catch (e) {
        console.error('Telegram error:', e);
      }
    }

    return NextResponse.json({
      success: true,
      updatedCount: updates.length,
      updates,
    });
  } catch (error: any) {
    console.error('Capacity check error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
