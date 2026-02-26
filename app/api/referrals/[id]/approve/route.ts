import { NextResponse } from 'next/server';
import { updateRecord, getRecordById } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';
import { sendEmail } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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
    const maxRefs = rancher['Max Active Referrals'] || 5;
    if (currentRefs >= maxRefs) {
      return NextResponse.json({
        error: `${rancher['Operator Name'] || 'Rancher'} is at capacity (${currentRefs}/${maxRefs}). Reassign to another rancher.`,
      }, { status: 400 });
    }

    const now = new Date().toISOString();
    await updateRecord(TABLES.REFERRALS, id, {
      'Status': 'Intro Sent',
      'Rancher': [rancherId],
      'Approved At': now,
      'Intro Sent At': now,
    });

    await updateRecord(TABLES.RANCHERS, rancherId, {
      'Last Assigned At': now,
      'Current Active Referrals': currentRefs + 1,
    });

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
      await sendEmail({
        to: rancherEmail,
        subject: `BuyHalfCow Introduction: ${buyerName} in ${buyerState}`,
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
              <h1>New Qualified Buyer Lead</h1>
              <p>Hi ${rancherName},</p>
              <p>You have a new qualified buyer lead from BuyHalfCow:</p>
              <div class="divider"></div>
              <div class="field"><span class="label">Buyer:</span> ${buyerName}</div>
              <div class="field"><span class="label">Email:</span> ${buyerEmail}</div>
              <div class="field"><span class="label">Phone:</span> ${buyerPhone}</div>
              <div class="field"><span class="label">Location:</span> ${buyerState}</div>
              <div class="field"><span class="label">Order:</span> ${orderType}</div>
              <div class="field"><span class="label">Budget:</span> ${budgetRange}</div>
              ${buyerNotes ? `<div class="field"><span class="label">Notes:</span> ${buyerNotes}</div>` : ''}
              <div class="divider"></div>
              <p>Please reach out to them directly to discuss availability and pricing.</p>
              <p><strong>Reply-all to this email to keep me in the loop.</strong></p>
              <div class="footer">
                <p>— Benjamin, BuyHalfCow<br>Remember: 10% commission applies to sales made through BuyHalfCow referrals.</p>
              </div>
            </div>
          </body>
          </html>
        `,
      });
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
