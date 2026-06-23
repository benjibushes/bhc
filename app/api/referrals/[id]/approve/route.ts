import { NextResponse } from 'next/server';
import { updateRecord, getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';
import { getMaxActiveReferrals } from '@/lib/rancherCapacity';
import { logAuditEntry, buildAirtableUpdateReverse } from '@/lib/auditLog';
import { requireAdmin } from '@/lib/adminAuth';

function esc(str: string): string {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const { rancherId: overrideRancherId } = body;

    const referral: any = await getRecordById(TABLES.REFERRALS, id);

    if (referral['Status'] === 'Intro Sent' || referral['Status'] === 'Closed Won') {
      return NextResponse.json({ error: 'This referral has already been approved' }, { status: 400 });
    }

    const rancherId = overrideRancherId || referral['Suggested Rancher']?.[0];
    if (!rancherId) {
      return NextResponse.json({ error: 'No rancher assigned to this referral' }, { status: 400 });
    }

    const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);

    // Capacity check
    const currentRefs = rancher['Current Active Referrals'] || 0;
    const maxRefs = getMaxActiveReferrals(rancher);
    if (currentRefs >= maxRefs) {
      return NextResponse.json({
        error: `${rancher['Operator Name'] || 'Rancher'} is at capacity (${currentRefs}/${maxRefs}). Reassign to another rancher.`,
      }, { status: 400 });
    }

    const now = new Date().toISOString();
    // P1 audit D-3: capture pre-state for audit reversibility
    const reverseAction = buildAirtableUpdateReverse(TABLES.REFERRALS, id, {
      'Status': referral['Status'],
      'Rancher': referral['Rancher'] || [],
      'Approved At': referral['Approved At'] || null,
      'Intro Sent At': referral['Intro Sent At'] || null,
    });
    await updateRecord(TABLES.REFERRALS, id, {
      'Status': 'Intro Sent',
      'Rancher': [rancherId],
      'Approved At': now,
      'Intro Sent At': now,
    });

    // Note: Current Active Referrals is incremented at match creation time
    // in /api/matching/suggest — only update Last Assigned At here to avoid double-counting
    await updateRecord(TABLES.RANCHERS, rancherId, {
      'Last Assigned At': now,
    });

    // P1 audit D-3: log the approve. Non-fatal on failure (try/catch in lib).
    try {
      await logAuditEntry({
        actor: 'manual',
        tool: 'admin-referral-approve',
        targetType: 'Referral',
        targetId: id,
        args: { rancherId, overrideRancherId },
        result: { status: 'Intro Sent', approvedAt: now, rancherName: rancher['Operator Name'] || rancher['Ranch Name'] },
        reverseAction,
      });
    } catch (e: any) {
      console.error('[approve] audit log failed (non-fatal):', e?.message);
    }

    const rancherEmail = rancher['Email'];
    const rancherName = rancher['Operator Name'] || rancher['Ranch Name'] || 'Rancher';
    const buyerName = referral['Buyer Name'] || 'Buyer';
    const buyerEmail = referral['Buyer Email'] || '';
    const buyerPhone = referral['Buyer Phone'] || '';
    const buyerState = referral['Buyer State'] || '';
    const orderType = referral['Order Type'] || '';
    const budgetRange = referral['Budget Range'] || '';
    const buyerNotes = referral['Notes'] || '';

    if (rancherEmail) {
      try {
      await sendEmail({
        to: rancherEmail,
        subject: `i routed you a buyer${buyerState ? ` in ${buyerState}` : ''} — ${buyerName}`,
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0E0E0E; background: #F4F1EC; margin: 0; padding: 20px; }
              .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border: 1px solid #A7A29A; }
              h1 { font-family: Georgia, serif; font-size: 24px; margin: 0 0 20px 0; }
              .field { margin: 8px 0; padding: 12px; background: #F4F1EC; }
              .label { font-weight: bold; color: #6B4F3F; }
              .divider { height: 1px; background: #A7A29A; margin: 24px 0; }
              .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #A7A29A; font-size: 12px; color: #A7A29A; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>A buyer for you</h1>
              <p>Hi ${esc(rancherName)},</p>
              <p>I routed you a buyer${buyerState ? ` in ${esc(buyerState)}` : ''} — a real, in-state family who's ready. They're yours to close. Reply to this email and reach out to them today.</p>
              <div class="divider"></div>
              <div class="field"><span class="label">Buyer:</span> ${esc(buyerName)}</div>
              <div class="field"><span class="label">Email:</span> ${esc(buyerEmail)}</div>
              <div class="field"><span class="label">Phone:</span> ${esc(buyerPhone)}</div>
              <div class="field"><span class="label">Location:</span> ${esc(buyerState)}</div>
              <div class="field"><span class="label">Order:</span> ${esc(orderType)}</div>
              <div class="field"><span class="label">Budget:</span> ${esc(budgetRange)}</div>
              ${buyerNotes ? `<div class="field"><span class="label">Notes:</span> ${esc(buyerNotes)}</div>` : ''}
              <div class="divider"></div>
              <p>Call or email them, talk cut and timing, get them on the books. Reply here to keep me in the loop.</p>
              <div class="footer">
                <p>— Ben<br>your tier's rate applies on referred sales — a 1.5% floor on every tier. this buyer stays your customer.</p>
              </div>
            </div>
          </body>
          </html>
        `,
        // T3 (2026-06-10): tag templateName so cap whitelist applies.
        // Rancher manual-approve intro is revenue-critical.
        templateName: 'sendReferralApprovedIntro',
      } as any);
      } catch (emailErr) {
        console.error(`Failed to send intro email to ${rancherEmail}:`, emailErr);
      }
    }

    try {
      await sendTelegramUpdate(
        `✅ <b>Approved!</b> Intro sent to <b>${rancherName}</b> for buyer <b>${buyerName}</b> in ${buyerState}`
      );
    } catch (e) {
      console.error('Telegram update error:', e);
    }

    return NextResponse.json({
      success: true,
      message: `Intro sent to ${rancherName}`,
      rancherName,
      buyerName,
    });
  } catch (error: any) {
    console.error('Error approving referral:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
