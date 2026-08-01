import { NextResponse } from 'next/server';
import { getAllRecords, isInvalidFilterFormulaError } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { dailyDigestReferralsFormula } from '@/lib/cronReadFilters';
import { isMaintenanceMode } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { callClaude } from '@/lib/ai';
import { getMaxActiveReferrals } from '@/lib/rancherCapacity';
import { withCronRun } from '@/lib/cronRun';
import { requireCron } from '@/lib/cronAuth';
import {
  selectDueFollowUps,
  operatorToday,
  followUpContextLine,
  FOLLOW_UP_DIGEST_MAX_LINES,
} from '@/lib/followUpQueue';

export const maxDuration = 60;

/** Telegram parse_mode=HTML. Buyer-supplied text must not be able to break it. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const BHC_SYSTEM_PROMPT = `You are Ben's AI business assistant for BuyHalfCow (BHC). BHC is a private beef brokerage connecting verified consumers with American ranchers. Ben earns 10% commission on every sale. Be concise and direct — Ben reads this on his phone.`;

async function realHandler(_request: Request): Promise<{ status: 'success' | 'maintenance-blocked'; recordsTouched: number; notes: string }> {
  if (isMaintenanceMode()) {
    return { status: 'maintenance-blocked', recordsTouched: 0, notes: 'MAINTENANCE_MODE=true' };
  }

  const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // SCALE (#3): the referrals read only feeds status-bucketed COUNTS
    // (pending / recent intros / month wins / stalled), so pull just those
    // statuses instead of the full table. Every recency/month window that
    // narrows further stays in JS as the exact belt. On an
    // INVALID_FILTER_BY_FORMULA-class error fall back to the unfiltered scan so
    // a bad formula can never silently under-count the digest.
    // Consumers stays unfiltered — the digest reports whole-table totals
    // (recent signups, pending, total members) that need every row.
    const readReferrals = async (): Promise<any[]> => {
      try {
        return (await getAllRecords(TABLES.REFERRALS, dailyDigestReferralsFormula())) as any[];
      } catch (e: any) {
        if (!isInvalidFilterFormulaError(e)) throw e;
        console.warn('[daily-digest] referral status filter rejected; falling back to full Referrals scan:', e?.message);
        return (await getAllRecords(TABLES.REFERRALS)) as any[];
      }
    };
    const [consumers, ranchers, referrals] = await Promise.all([
      getAllRecords(TABLES.CONSUMERS),
      getAllRecords(TABLES.RANCHERS),
      readReferrals(),
    ]);

    // Supply-stall backstop (batch F, audit #9): synced Shopify products import
    // OFF /shop and only display after an operator runs /approvestore. If the
    // connect-time ping is ever missed, a catalog stalls invisibly. Surface the
    // standing count of sync-managed products still awaiting approval every
    // morning. Cheap: the filter returns ONLY the unapproved rows, not the
    // whole catalog. Best-effort — a read hiccup must not sink the digest.
    let pendingSyncApproval: number | null = null;
    try {
      const pendingRows = await getAllRecords(
        TABLES.RANCHER_PRODUCTS,
        'AND({Sync Managed} = TRUE(), NOT({Marketplace Approved} = TRUE()))',
      );
      pendingSyncApproval = pendingRows.length;
    } catch (e: any) {
      console.warn('[daily-digest] pending sync-approval count failed:', e?.message);
    }

    const recentSignups = consumers.filter((c: any) => {
      const created = new Date(c['Created'] || c.createdTime || c._createdTime || 0);
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
      const max = getMaxActiveReferrals(r);
      return cur >= max * 0.8 && r['Active Status'] === 'Active';
    }).length;

    // Stalled referrals (Intro Sent or Rancher Contacted, 5+ days no update)
    const stalledReferrals = referrals.filter((r: any) => {
      if (!['Intro Sent', 'Rancher Contacted'].includes(r['Status'])) return false;
      const lastActivity = r['Last Chased At'] || r['Intro Sent At'] || r['Approved At'];
      if (!lastActivity) return false;
      return (Date.now() - new Date(lastActivity).getTime()) >= 5 * 24 * 60 * 60 * 1000;
    }).length;

    // ── PROMISED FOLLOW-UPS ─────────────────────────────────────────────
    // Ben tells buyers "I'll call you in two weeks" on the phone. Until this
    // block, the only record was a free-text note nothing read. Reuses the
    // Consumers read above — zero extra Airtable calls.
    //
    // SILENT WHEN EMPTY, deliberately: this section renders as '' on a day
    // with nothing due, adding not one line of noise. A digest that reports
    // "0 follow-ups" every morning teaches Ben to skim past the whole message,
    // and a skimmed digest is a rail that no longer exists.
    //
    // OPERATOR-ONLY. This tells BEN to make a call. It never emails or texts
    // the buyer — his follow-ups are phone calls.
    const followUpsDue = selectDueFollowUps(consumers as any[], operatorToday());
    const shownFollowUps = followUpsDue.slice(0, FOLLOW_UP_DIGEST_MAX_LINES);
    const followUpBlock = followUpsDue.length === 0
      ? ''
      : `\n\n<b>⏰ Follow up today (${followUpsDue.length})</b>\n${shownFollowUps
          .map((f) => {
            const late = f.daysOverdue > 0 ? ` <i>(${f.daysOverdue}d late)</i>` : '';
            const phone = f.phone ? ` · ${escapeHtml(f.phone)}` : ' · no phone';
            const ctx = followUpContextLine(f.notes);
            return `• ${escapeHtml(f.name)}${phone}${late}${ctx ? `\n   ${escapeHtml(ctx)}` : ''}`;
          })
          .join('\n')}${
          followUpsDue.length > shownFollowUps.length
            ? `\n<i>+${followUpsDue.length - shownFollowUps.length} more on the desk</i>`
            : ''
        }`;

    const msg = `☀️ <b>Good Morning — Daily Digest</b>
${now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}${followUpBlock}

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
🤠 Total ranchers: ${ranchers.length}${capacityWarnings > 0 ? `\n⚠️ ${capacityWarnings} rancher(s) near capacity` : '\n✅ All ranchers have capacity'}${pendingSyncApproval && pendingSyncApproval > 0 ? `\n🕓 Synced products pending /approvestore: ${pendingSyncApproval}` : ''}

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
- Promised follow-ups due today (Ben said he'd call): ${followUpsDue.length}
- Near-capacity ranchers: ${capacityWarnings}
- Synced products pending /approvestore (off /shop until approved): ${pendingSyncApproval ?? 'unknown'}
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

      // Inline action buttons — one-tap drill-down from morning notification
      const briefKeyboard = {
        inline_keyboard: [
          [
            { text: '📋 Pending Leads', callback_data: 'brief_leads' },
            { text: '🔥 Stalled Refs', callback_data: 'brief_stalled' },
          ],
          [
            { text: '💰 Revenue', callback_data: 'brief_money' },
            { text: '📊 Pipeline', callback_data: 'brief_pipeline' },
          ],
        ],
      };

      await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, briefMsg, briefKeyboard);
    } catch (aiErr: any) {
      console.warn('AI brief skipped:', aiErr.message);
    }

  return {
    status: 'success',
    recordsTouched: recentSignups.length + recentIntros + monthWins.length,
    notes: `signups=${recentSignups.length} intros=${recentIntros} pending=${pendingConsumers} stalled=${stalledReferrals} closed=${monthWins.length} syncPendingApproval=${pendingSyncApproval ?? 'n/a'} followUpsDue=${followUpsDue.length}`,
  };
}

async function authedHandler(request: Request): Promise<Response> {
  const denied = requireCron(request);
  if (denied) return denied;
  return withCronRun('daily-digest', realHandler)(request);
}

export const GET = authedHandler;
export const POST = authedHandler;
