import { NextResponse } from 'next/server';
import { updateRecord, getRecordById, TABLES } from '@/lib/airtable';
import { sendTelegramUpdate } from '@/lib/telegram';
import { requireAdmin } from '@/lib/adminAuth';
import { sendEmail } from '@/lib/email';
import { resolveRancherEmail, rancherFirstName } from '@/lib/rancherNotify';

// POST /api/admin/ranchers/[id]/pause
// Marks rancher Active Status = "Paused" so the matching engine stops routing
// leads to them. Use for vacation, processing months, sickness, etc.
// Body: { reason?: string }
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const __authResp = await requireAdmin(request);
    if (__authResp) return __authResp;
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const reason = (body.reason || '').trim();

    const rancher: any = await getRecordById(TABLES.RANCHERS, id);
    if (!rancher) {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
    }

    const current = rancher['Active Status']?.name || rancher['Active Status'];
    if (current === 'Paused') {
      return NextResponse.json({ error: 'Rancher is already paused' }, { status: 400 });
    }

    const name = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
    const existingNotes = rancher['Verification Notes'] || '';
    const stamp = new Date().toISOString().slice(0, 10);
    const note = `[PAUSED ${stamp}${reason ? ` — ${reason}` : ''}]`;

    await updateRecord(TABLES.RANCHERS, id, {
      'Active Status': 'Paused',
      'Verification Notes': `${note}\n${existingNotes}`.trim(),
    });

    // Wave C (2026-07-14): tell the RANCHER, not just the operator. An admin
    // pause stops all new leads AND mutes the follow-up/reactivation email
    // rails (they exclude Paused) — a rancher who doesn't log in never
    // learned lead flow was shut off or why. Best-effort, never blocks the
    // pause itself; whitelisted templateName so the 3/week cap can't eat it.
    const ranchName = String(rancher['Ranch Name'] || name);
    const rancherEmail = resolveRancherEmail(rancher);
    let rancherEmailed = false;
    if (rancherEmail) {
      try {
        const firstName = rancherFirstName(rancher) || 'there';
        const r = await sendEmail({
          to: rancherEmail,
          subject: `We paused new buyer leads to ${ranchName}`,
          templateName: 'sendRancherPauseNotice',
          html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;background:#F4F1EC;line-height:1.6;color:#0E0E0E">
            <p>hey ${firstName},</p>
            <p>quick heads up — we&rsquo;ve paused new buyer routing to <strong>${ranchName}</strong> for now.${reason ? ` Reason: ${reason}.` : ''}</p>
            <p>Nothing else changes: your page stays live, and any conversations you already have with buyers keep going exactly as they are.</p>
            <p>Ready for new leads again? Open <a href="${process.env.NEXT_PUBLIC_SITE_URL || 'https://www.buyhalfcow.com'}/rancher">your dashboard</a> and hit Resume — or just reply to this email and we&rsquo;ll sort it out together.</p>
            <p style="font-size:12px;color:#A7A29A;">— Ben<br>BuyHalfCow</p>
          </div>`,
        });
        rancherEmailed = !!r?.success;
      } catch (e: any) {
        console.warn('[admin pause] rancher email failed (non-fatal):', e?.message);
      }
    }
    // PWA push — dark-safe (no-ops without VAPID/subscriptions), never throws
    // into the route.
    try {
      const { sendRancherPush } = await import('@/lib/rancherPush');
      await sendRancherPush(id, {
        title: 'New buyer leads paused',
        body: reason
          ? `${reason} — open your dashboard to resume or reply to the email we sent.`
          : 'open your dashboard to resume, or reply to the email we sent to talk it through.',
        url: '/rancher',
      });
    } catch (e: any) {
      console.warn('[admin pause] rancher push skipped (non-fatal):', e?.message);
    }

    // Ops copy notes whether the rancher was actually told — so Ben knows
    // when a suppressed/missing email means he has to relay it himself.
    await sendTelegramUpdate(
      `⏸ <b>Rancher paused</b>: ${name}${reason ? `\nReason: ${reason}` : ''}\n` +
        (rancherEmailed
          ? `Rancher notified by email (${rancherEmail}).`
          : `⚠️ Rancher NOT notified${rancherEmail ? ' (email suppressed/failed)' : ' (no email on file)'} — tell them yourself.`)
    ).catch(() => {});

    return NextResponse.json({ success: true, rancherNotified: rancherEmailed, message: `${name} paused. Matching engine will skip them until resumed.${rancherEmailed ? ' Rancher notified by email.' : ' Rancher could NOT be notified — reach out directly.'}` });
  } catch (error: any) {
    console.error('Pause rancher error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
