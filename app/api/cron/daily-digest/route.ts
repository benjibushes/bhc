import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { callClaude } from '@/lib/ai';

const BHC_SYSTEM_PROMPT = `You are Ben's AI business assistant for BuyHalfCow (BHC). BHC is a private beef brokerage connecting verified consumers with American ranchers. Ben earns 10% commission on every sale. Be concise and direct — Ben reads this on his phone.`;

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
      const max = r['Max Active Referalls'] || 5;
      return cur >= max * 0.8 && r['Active Status'] === 'Active';
    }).length;

    // Stalled referrals (Intro Sent or Rancher Contacted, 5+ days no update)
    const stalledReferrals = referrals.filter((r: any) => {
      if (!['Intro Sent', 'Rancher Contacted'].includes(r['Status'])) return false;
      const lastActivity = r['Last Chased At'] || r['Intro Sent At'] || r['Approved At'];
      if (!lastActivity) return false;
      return (Date.now() - new Date(lastActivity).getTime()) >= 5 * 24 * 60 * 60 * 1000;
    }).length;

    const msg = `☀️ <b>Good Morning — Daily Digest</b>
${now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}

<b>Last 24 Hours</b>
👤 New signups: ${recentSignups.length} (🥩 ${beefSignups} beef, 🏷️ ${communitySignups} community)
⏳ Consumers pending review: ${pendingConsumers}
🤝 Intros sent: ${recentIntros}

<b>Pipeline</b>
⏳ Referrals pending approval: ${pendingReferrals}
🔕 Stalled referrals (5+ days): ${stalledReferrals}

<b>This Month</b>
✅ Deals closed: ${monthWins.length}
💰 Commission: $${monthCommission.toLocaleString()}

<b>Supply</b>
🤠 Total ranchers: ${ranchers.length}${capacityWarnings > 0 ? `\n⚠️ ${capacityWarnings} rancher(s) near capacity` : '\n✅ All ranchers have capacity'}

👥 Total members: ${consumers.length}

<i>Reply /help for commands</i>`;

    await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, msg);

    // AI Business Brief — append Claude's prioritized action list
    try {
      const aiPrompt = `Today's BuyHalfCow business data:
- New signups (24h): ${recentSignups.length} (${beefSignups} beef buyers, ${communitySignups} community)
- Consumers pending review: ${pendingConsumers}
- Referrals pending approval: ${pendingReferrals}
- Stalled referrals (5+ days no update): ${stalledReferrals}
- Near-capacity ranchers: ${capacityWarnings}
- Deals closed this month: ${monthWins.length}, commission: $${monthCommission.toLocaleString()}
- Total members: ${consumers.length}, total ranchers: ${ranchers.length}

Output exactly this format (no extra text):
TOP 3 PRIORITIES:
1. [specific action]
2. [specific action]
3. [specific action]

AT RISK:
• [1-2 bullet points on what needs attention]

SUGGESTED ACTIONS:
• [3 bullet points in priority order]`;

      const aiResponse = await callClaude({
        model: 'claude-haiku-4-5-20251001',
        system: BHC_SYSTEM_PROMPT,
        user: aiPrompt,
        maxTokens: 600,
      });

      const briefMsg = `🤖 <b>AI Business Brief</b>\n\n${aiResponse
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
        .replace(/^(TOP 3 PRIORITIES:|AT RISK:|SUGGESTED ACTIONS:)/gm, '<b>$1</b>')}`;

      await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, briefMsg);
    } catch (aiErr: any) {
      console.warn('AI brief skipped:', aiErr.message);
    }

    return NextResponse.json({ success: true, message: 'Daily digest sent' });
  } catch (error: any) {
    console.error('Daily digest error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
