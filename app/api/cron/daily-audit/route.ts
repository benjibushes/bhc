// Daily Audit — autonomous morning sweep.
//
// Runs the audit skill prompt against the full BHC state via Claude tool-use.
// AI inspects: stale referrals, ghosting ranchers, capacity drift, buyers
// stuck in covered states, today's pipeline movement, error spikes. Then
// it produces a prioritized issue list with one-tap "fix it" actions.
//
// Output goes to Telegram every morning at 8 AM MT (14:00 UTC). Replaces
// half of the manual `scripts/audit-*.mjs` files.
//
// SAFETY:
//   - Read-only by default. The audit's job is to SURFACE issues, not fix
//     them. (Phase 2 will add per-issue auto-fix actions through tiered
//     autonomy, gated by AI_AUDIT_LOG.)
//   - All AI tool calls log to AI_AUDIT_LOG via runTool wrapper.
//   - Telegram cap: 4096 chars per message. The summary is hard-capped.

import { NextResponse } from 'next/server';
import { isMaintenanceMode, maintenanceResponse } from '@/lib/maintenance';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';
import { callClaudeWithTools } from '@/lib/ai';

export const maxDuration = 120;

const AUDIT_SYSTEM_PROMPT = `You are BuyHalfCow's daily morning audit agent. Your job: scan the entire
business state and produce a prioritized issue list for Ben (the founder).

You have read-only Airtable access via tools. Use them to investigate. Don't
fabricate — every claim must be backed by a tool result.

WHAT TO LOOK FOR (priority order):

1. 🚨 ACTIVELY BLEEDING REVENUE
   - Stale referrals (Intro Sent or Rancher Contacted >7 days, not closed)
   - Ranchers near or over capacity
   - Buyers who clicked Ready-to-Buy but have no active referral
   - Closed Won waiting for commission collection

2. 🟡 LEAD QUALITY ISSUES
   - Pending Approval queue (unmoved >24h)
   - Buyers in covered states with no referral
   - Form submissions with low intent score that should be re-qualified

3. 🟢 OPPORTUNITIES TO PUSH
   - Ranchers approaching their Pilot Closes Goal (upsell trigger)
   - Buyer Pulse responses showing "ghosted" — those need rescue
   - Repeat-buy ready customers (Closed Won >90 days ago)

OUTPUT FORMAT:
Plain text suitable for Telegram (HTML <b>...</b> + emoji OK; no markdown
headers). Under 2500 characters. Three sections:

🌅 BHC Daily Audit · {today's date}

🚨 NEEDS YOU NOW
- (top 3-5 highest urgency items, each one line)

🟡 WORTH A LOOK
- (next 3-5 items)

🟢 HEALTHY
- (1-2 lines confirming what's running clean)

If nothing is bleeding, say so. Don't manufacture urgency.

CRITICAL RULES:
- Cite specific record IDs / names so Ben can act in seconds.
- Don't repeat what you reported yesterday unless it's gotten worse.
- Numbers > narrative. "12 stale referrals at Ace" beats "ranchers seem slow."
- If a tool call fails, mention it in 🟢 HEALTHY (e.g. "couldn't query X today").`;

const AUDIT_USER_PROMPT = `Run today's audit. Use the available tools to gather facts before
writing your summary. Investigate at minimum:
- get_stalled_referrals (5+ days)
- get_pending_consumers
- get_pending_referrals
- get_rancher_capacity (onlyNearCapacity: true)
- get_unmatched_buyers (limit 10)
- get_revenue_summary

Output the prioritized issue list as specified.`;

export async function GET(request: Request) {
  try {
    if (isMaintenanceMode()) return maintenanceResponse('daily-audit');

    const { CRON_SECRET } = await import('@/lib/secrets');
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      const url = new URL(request.url);
      const secret = url.searchParams.get('secret');
      if (secret !== CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const startedAt = Date.now();
    let result: { text: string; toolCalls: any[] };
    try {
      result = await callClaudeWithTools({
        model: 'claude-sonnet-4-6',
        system: AUDIT_SYSTEM_PROMPT,
        user: AUDIT_USER_PROMPT,
        maxTokens: 2048,
        maxIterations: 8,
      });
    } catch (e: any) {
      console.error('[daily-audit] AI call failed:', e?.message);
      try {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `⚠️ <b>Daily audit failed</b>\n\n` +
          `Couldn't reach the AI provider this morning.\n` +
          `Error: ${e?.message?.slice(0, 200) || 'unknown'}\n\n` +
          `<i>Manually run /api/cron/daily-audit when AI is back. Other crons still running.</i>`
        );
      } catch {}
      return NextResponse.json({ ok: false, error: e?.message }, { status: 502 });
    }

    // Telegram cap is 4096 chars. Truncate hard.
    const summary = (result.text || '').slice(0, 3900);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const message = summary +
      `\n\n<i>Audit ran in ${elapsed}s · ${result.toolCalls.length} tool calls</i>`;

    try {
      await sendTelegramMessage(TELEGRAM_ADMIN_CHAT_ID, message);
    } catch (e: any) {
      console.error('[daily-audit] Telegram send failed:', e?.message);
    }

    return NextResponse.json({
      ok: true,
      elapsed,
      toolCalls: result.toolCalls.length,
      summaryLength: summary.length,
    });
  } catch (error: any) {
    console.error('[daily-audit] cron error:', error);
    return NextResponse.json({ error: error?.message || 'Internal server error' }, { status: 500 });
  }
}
