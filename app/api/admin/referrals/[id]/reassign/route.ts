import { NextResponse } from 'next/server';
import { updateRecord, getRecordById, TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';
import { requireAdmin } from '@/lib/adminAuth';
import { getMaxActiveReferrals } from '@/lib/rancherCapacity';

function esc(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// POST /api/admin/referrals/[id]/reassign
// Reassigns a referral to a different rancher — works at ANY stage,
// not just Pending Approval. Handles capacity rebalancing on both sides.
// Body: { newRancherId: string, reason?: string }
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const __authResp = await requireAdmin(request);
    if (__authResp) return __authResp;
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const { newRancherId, reason } = body;

    if (!newRancherId) {
      return NextResponse.json({ error: 'newRancherId required' }, { status: 400 });
    }

    const referral: any = await getRecordById(TABLES.REFERRALS, id);
    if (!referral) {
      return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
    }

    const oldRancherId = referral['Rancher']?.[0] || referral['Suggested Rancher']?.[0] || null;
    if (oldRancherId === newRancherId) {
      return NextResponse.json({ error: 'Already assigned to this rancher' }, { status: 400 });
    }

    const newRancher: any = await getRecordById(TABLES.RANCHERS, newRancherId);
    if (!newRancher) {
      return NextResponse.json({ error: 'Target rancher not found' }, { status: 404 });
    }

    const newCap = getMaxActiveReferrals(newRancher);
    const newCount = newRancher['Current Active Referrals'] || 0;
    if (newCount >= newCap) {
      return NextResponse.json({
        error: `${newRancher['Operator Name'] || 'Target rancher'} is at capacity (${newCount}/${newCap})`
      }, { status: 400 });
    }

    // Decrement old rancher's count if we had one assigned (and referral was active).
    // Re-read immediately before write to reduce the race window on concurrent
    // reassigns. The daily capacity self-heal cron catches any residual drift.
    const wasActive = ['Intro Sent', 'Rancher Contacted', 'Negotiation'].includes(referral['Status']);
    if (oldRancherId && wasActive) {
      try {
        const oldRancher: any = await getRecordById(TABLES.RANCHERS, oldRancherId);
        const oldCount = Number(oldRancher['Current Active Referrals']) || 0;
        if (oldCount > 0) {
          await updateRecord(TABLES.RANCHERS, oldRancherId, {
            'Current Active Referrals': oldCount - 1,
          });
        }
      } catch (e) {
        console.error('Old rancher decrement error:', e);
      }
    }

    // Update referral — fresh Intro Sent, reset chase state
    const now = new Date().toISOString();
    const existingNotes = referral['Notes'] || '';
    const reassignNote = `[REASSIGNED ${now.slice(0, 10)}${reason ? ` — ${reason}` : ''} — was ${referral['Suggested Rancher Name'] || oldRancherId || 'unassigned'}]`;
    await updateRecord(TABLES.REFERRALS, id, {
      'Rancher': [newRancherId],
      'Suggested Rancher': [newRancherId],
      'Status': 'Intro Sent',
      'Intro Sent At': now,
      'Approved At': referral['Approved At'] || now,
      'Notes': `${reassignNote}\n${existingNotes}`.trim(),
      'Chase Count': 0,
      'Last Chased At': '',
      'Rancher Reminded At': '',
    });

    // Increment new rancher's count — re-read immediately before write to
    // minimize the race window on concurrent reassigns. Not truly atomic
    // (Airtable has no compare-and-swap) but closes the critical gap.
    try {
      const fresh: any = await getRecordById(TABLES.RANCHERS, newRancherId);
      const freshCount = Number(fresh['Current Active Referrals']) || 0;
      await updateRecord(TABLES.RANCHERS, newRancherId, {
        'Current Active Referrals': freshCount + 1,
        'Last Assigned At': now,
      });
    } catch (e) {
      console.error('New rancher increment error:', e);
    }

    // Fire intro email to new rancher
    const rancherEmail = newRancher['Email'];
    const rancherName = newRancher['Operator Name'] || newRancher['Ranch Name'] || 'Rancher';
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
          subject: `BuyHalfCow Introduction: ${buyerName} in ${buyerState}`,
          html: `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
<h1 style="font-family:Georgia,serif;">New Qualified Buyer Lead</h1>
<p>Hi ${esc(rancherName)},</p>
<p>You have a new qualified buyer lead from BuyHalfCow:</p>
<div style="background:#F4F1EC;padding:20px;margin:20px 0;">
  <p><strong>Buyer:</strong> ${esc(buyerName)}</p>
  <p><strong>Email:</strong> ${esc(buyerEmail)}</p>
  <p><strong>Phone:</strong> ${esc(buyerPhone)}</p>
  <p><strong>Location:</strong> ${esc(buyerState)}</p>
  <p><strong>Order:</strong> ${esc(orderType)}</p>
  <p><strong>Budget:</strong> ${esc(budgetRange)}</p>
  ${buyerNotes ? `<p><strong>Notes:</strong> ${esc(buyerNotes)}</p>` : ''}
</div>
<p>Please reach out to them directly to discuss availability and pricing.</p>
<p style="font-size:12px;color:#6B4F3F;margin-top:30px;">— Benjamin, BuyHalfCow · 10% commission applies to sales made through referrals.</p>
</body></html>`,
        });
      } catch (e) {
        console.error('Intro email send error:', e);
      }
    }

    await sendTelegramUpdate(
      `🔀 <b>MANUAL REASSIGN</b> — ${buyerName} (${buyerState}) → ${rancherName}${reason ? `\nReason: ${reason}` : ''}`
    ).catch(() => {});

    return NextResponse.json({
      success: true,
      message: `Reassigned to ${rancherName}. Intro email sent.`,
      rancherName,
    });
  } catch (error: any) {
    console.error('Reassign error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
