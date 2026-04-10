import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { bulkRouteStateToRancher } from '@/lib/bulkRoute';
import { sendTelegramMessage, TELEGRAM_ADMIN_CHAT_ID } from '@/lib/telegram';

export const maxDuration = 60;

// Routes all stuck consumers in a given state to a target rancher.
//   - Cancels duplicate Pending Approval referrals (keeps latest per consumer)
//   - Updates the latest stuck referral to Intro Sent, points at target rancher, sends intro emails
//   - Creates fresh Intro Sent referrals for Unmatched/Waitlisted consumers, sends intro emails
// Call: GET /api/admin/route-state-to-rancher?password=ADMIN_PASSWORD&state=CO&slug=the-high-lonesome-ranch
// OR: visit in a browser tab where you're already logged into /admin (cookie auth)
// Optional: &send_at=2026-04-10T14:00:00Z   (ISO date — Resend holds + delivers at this time)
// Optional: &dry_run=true                    (preview only, no Airtable writes, no emails)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pw = searchParams.get('password');
  const cookieStore = await cookies();
  const adminCookie = cookieStore.get('bhc-admin-auth');
  const isAdminCookie = adminCookie?.value === 'authenticated';
  const isPasswordOk = !!pw && pw === process.env.ADMIN_PASSWORD;
  if (!isAdminCookie && !isPasswordOk) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const state = searchParams.get('state') || 'CO';
  const slug = searchParams.get('slug') || 'the-high-lonesome-ranch';
  const dryRun = searchParams.get('dry_run') === 'true';
  const sendAt = searchParams.get('send_at') || undefined;

  try {
    const result = await bulkRouteStateToRancher({
      state,
      rancherSlug: slug,
      dryRun,
      scheduledAt: sendAt,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    const summary = result.summary;

    // Telegram summary
    if (!dryRun) {
      try {
        await sendTelegramMessage(
          TELEGRAM_ADMIN_CHAT_ID,
          `🚀 <b>BULK ROUTE COMPLETE</b>\n\n` +
          `State: ${summary.state} → ${summary.targetRancher}\n` +
          (sendAt ? `📅 Emails scheduled for: ${sendAt}\n\n` : `\n`) +
          `✅ Processed: ${summary.processed}\n` +
          `🔄 Updated stuck: ${summary.updated_stuck_referral}\n` +
          `🆕 New referrals: ${summary.created_new_referral}\n` +
          `🗑 Canceled dupes: ${summary.canceled_duplicates}\n` +
          `⏭ Skipped (already intro sent): ${summary.skipped_already_intro_sent}\n\n` +
          `📧 Rancher emails queued: ${summary.emails_sent_rancher}\n` +
          `📧 Buyer emails queued: ${summary.emails_sent_buyer}\n\n` +
          `${summary.errors.length > 0 ? `⚠️ Errors: ${summary.errors.length}` : '✨ No errors'}`
        );
      } catch (e) {
        console.error('Telegram bulk summary error:', e);
      }
    }

    return NextResponse.json(summary);
  } catch (error: any) {
    console.error('Bulk route error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
