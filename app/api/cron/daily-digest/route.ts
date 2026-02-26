import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

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

    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [consumers, ranchers, referrals] = await Promise.all([
      getAllRecords(TABLES.CONSUMERS),
      getAllRecords(TABLES.RANCHERS),
      getAllRecords(TABLES.REFERRALS),
    ]);

    const recentSignups = consumers.filter((c: any) => {
      const created = new Date(c['Created'] || c.createdTime || 0);
      return created >= yesterday;
    });
    const beefSignups = recentSignups.filter((c: any) => c['Segment'] === 'Beef Buyer').length;
    const communitySignups = recentSignups.length - beefSignups;
    const pendingConsumers = consumers.filter((c: any) => (c['Status'] || '').toLowerCase() === 'pending').length;

    const pendingReferrals = referrals.filter((r: any) => r['Status'] === 'Pending Approval').length;
    const recentIntros = referrals.filter((r: any) => {
      const sent = new Date(r['Intro Sent At'] || 0);
      return sent >= yesterday && r['Status'] === 'Intro Sent';
    }).length;

    const monthWins = referrals.filter((r: any) => {
      const closed = new Date(r['Closed At'] || 0);
      return closed >= monthStart && r['Status'] === 'Closed Won';
    });
    const monthCommission = monthWins.reduce((s: number, r: any) => s + (r['Commission Due'] || 0), 0);

    const capacityWarnings = ranchers.filter((r: any) => {
      const cur = r['Current Active Referrals'] || 0;
      const max = r['Max Active Referrals'] || 5;
      return cur >= max * 0.8 && r['Active Status'] === 'Active';
    }).length;

    const msg = `☀️ <b>Good Morning — Daily Digest</b>
${now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}

<b>Last 24 Hours</b>
👤 New signups: ${recentSignups.length} (🥩 ${beefSignups} beef, 🏷️ ${communitySignups} community)
⏳ Consumers pending review: ${pendingConsumers}
🤝 Intros sent: ${recentIntros}

<b>Pipeline</b>
⏳ Referrals pending approval: ${pendingReferrals}

<b>This Month</b>
✅ Deals closed: ${monthWins.length}
💰 Commission: $${monthCommission.toLocaleString()}

<b>Supply</b>
🤠 Total ranchers: ${ranchers.length}${capacityWarnings > 0 ? `\n⚠️ ${capacityWarnings} rancher(s) near capacity` : '\n✅ All ranchers have capacity'}

👥 Total members: ${consumers.length}

<i>Reply /help for commands</i>`;

    await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, msg);

    return NextResponse.json({ success: true, message: 'Daily digest sent' });
  } catch (error: any) {
    console.error('Daily digest error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
