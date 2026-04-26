import { NextResponse } from 'next/server';
import { updateRecord, getRecordById, TABLES } from '@/lib/airtable';
import { sendEmail, sendBuyerIntroNotification } from '@/lib/email';
import { sendTelegramUpdate } from '@/lib/telegram';
import jwt from 'jsonwebtoken';
import { requireAdmin } from '@/lib/adminAuth';

const JWT_SECRET = process.env.JWT_SECRET || 'bhc-member-secret-change-me';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://buyhalfcow.com';

function esc(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// POST /api/admin/referrals/[id]/resend-intro
// Re-fires the intro emails to BOTH rancher and buyer for a referral
// that's already in Intro Sent state. Useful when the first intro
// landed in spam or the rancher claims they never got it.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const __authResp = await requireAdmin(request);
    if (__authResp) return __authResp;
    const { id } = await params;

    const referral: any = await getRecordById(TABLES.REFERRALS, id);
    if (!referral) {
      return NextResponse.json({ error: 'Referral not found' }, { status: 404 });
    }

    const rancherId = referral['Rancher']?.[0] || referral['Suggested Rancher']?.[0];
    if (!rancherId) {
      return NextResponse.json({ error: 'No rancher assigned to this referral' }, { status: 400 });
    }

    const rancher: any = await getRecordById(TABLES.RANCHERS, rancherId);
    if (!rancher) {
      return NextResponse.json({ error: 'Rancher not found' }, { status: 404 });
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

    let rancherSent = false;
    let buyerSent = false;

    if (rancherEmail) {
      try {
        await sendEmail({
          to: rancherEmail,
          subject: `[Resend] BuyHalfCow Introduction: ${buyerName} in ${buyerState}`,
          html: `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;padding:40px;border:1px solid #A7A29A;">
<h1 style="font-family:Georgia,serif;">Buyer Lead — Resent</h1>
<p>Hi ${esc(rancherName)},</p>
<p>Resending this introduction in case the first email got lost. Please reach out to them today:</p>
<div style="background:#F4F1EC;padding:20px;margin:20px 0;">
  <p><strong>Buyer:</strong> ${esc(buyerName)}</p>
  <p><strong>Email:</strong> ${esc(buyerEmail)}</p>
  <p><strong>Phone:</strong> ${esc(buyerPhone)}</p>
  <p><strong>Location:</strong> ${esc(buyerState)}</p>
  <p><strong>Order:</strong> ${esc(orderType)}</p>
  <p><strong>Budget:</strong> ${esc(budgetRange)}</p>
  ${buyerNotes ? `<p><strong>Notes:</strong> ${esc(buyerNotes)}</p>` : ''}
</div>
<p>— Benjamin, BuyHalfCow</p>
</body></html>`,
        });
        rancherSent = true;
      } catch (e) {
        console.error('Rancher intro resend error:', e);
      }
    }

    if (buyerEmail) {
      try {
        const buyerId = referral['Buyer']?.[0] || '';
        const loginUrl = buyerId
          ? `${SITE_URL}/member/verify?token=${jwt.sign(
              { type: 'member-login', consumerId: buyerId, email: buyerEmail.trim().toLowerCase() },
              JWT_SECRET,
              { expiresIn: '7d' }
            )}`
          : `${SITE_URL}/member`;
        await sendBuyerIntroNotification({
          firstName: buyerName.split(' ')[0] || 'there',
          email: buyerEmail,
          rancherName,
          rancherEmail: rancherEmail || '',
          rancherPhone: rancher['Phone'] || '',
          loginUrl,
          quarterPrice: Number(rancher['Quarter Price']) || undefined,
          quarterLbs: rancher['Quarter lbs'] || '',
          halfPrice: Number(rancher['Half Price']) || undefined,
          halfLbs: rancher['Half lbs'] || '',
          wholePrice: Number(rancher['Whole Price']) || undefined,
          wholeLbs: rancher['Whole lbs'] || '',
          nextProcessingDate: rancher['Next Processing Date'] || '',
          rancherSlug: rancher['Slug'] || '',
        });
        buyerSent = true;
      } catch (e) {
        console.error('Buyer intro resend error:', e);
      }
    }

    // Reset chase state so the chase-up cron gives them fresh time
    await updateRecord(TABLES.REFERRALS, id, {
      'Intro Sent At': new Date().toISOString(),
      'Chase Count': 0,
      'Last Chased At': '',
    });

    await sendTelegramUpdate(
      `↻ <b>MANUAL RESEND</b> — ${buyerName} × ${rancherName}\n📧 Rancher: ${rancherSent ? '✓' : '✗'} | Buyer: ${buyerSent ? '✓' : '✗'}`
    ).catch(() => {});

    return NextResponse.json({ success: true, rancherSent, buyerSent });
  } catch (error: any) {
    console.error('Resend intro error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
