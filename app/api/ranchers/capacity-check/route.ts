import { NextResponse } from 'next/server';
import { getAllRecords, updateRecord } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramUpdate } from '@/lib/telegram';

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      const { searchParams } = new URL(request.url);
      const secret = searchParams.get('secret');
      if (secret !== process.env.CRON_SECRET || !process.env.CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const ranchers = await getAllRecords(TABLES.RANCHERS);
    const updates: { name: string; oldStatus: string; newStatus: string }[] = [];

    for (const rancher of ranchers as any[]) {
      const current = rancher['Current Active Referrals'] || 0;
      const max = rancher['Max Active Referrals'] || 5;
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
